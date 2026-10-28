/**
 * Sticky-note plus sliding-window compaction backend for DeepSeek Harness.
 *
 * The shipped backend replaces an old span with a model-written summary: one
 * extra model call per rollover, and a summary that a reader must trust. This
 * backend keeps the same durable transaction and the same ability to reclaim
 * context, but changes what survives. Everything older than a retained verbatim
 * window is replaced by a deterministic note built from the evicted messages
 * themselves — objective, verified state, open issues, next action — plus the
 * facts the model pinned. No model call is made, so a rollover costs nothing and
 * replays identically.
 *
 * Three tools close the loop the note alone cannot: `context_status` reports how
 * much room is left before the next rollover, `sticky_note` reads and replaces
 * the pinned list, and `history_query` reaches the evicted messages that the
 * note compressed away.
 *
 * @module dsh-compaction-sticky-window
 */

import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveConfig, toLifecycleConfig } from './src/config.js'
import { PINS_CLOSE, PINS_OPEN, PIN_TOOL_NAME, buildStickyNote, extractPins, textOf } from './src/note.js'
import {
  collectArchive,
  currentWindowNumber,
  describeWindows,
  readArchivedItem,
  searchArchive,
} from './src/history.js'
import { describeStatus, resolveRolloverBudget, rolloverCeiling } from './src/budget.js'
import { noteSavedThisWindow, selectRolloverRange } from './src/window.js'
import {
  NOTICE_SOURCE_KIND,
  blockedNotice,
  exhaustedNotice,
  warningNotice,
} from './src/notice.js'
import { GUIDANCE_SECTION_NAME, GUIDANCE_SECTION_ORDER, GUIDANCE_TEXT } from './src/guidance.js'

/** Bytes of framing the checkpoint wrapper adds around the note. */
const CHECKPOINT_FRAMING_BYTES = 512

/** Deepest argument nesting the note's path walk inspects. */
const ARGUMENT_WALK_DEPTH = 3

/**
 * Conservative note budget for one span.
 *
 * A note larger than the span it replaces fails the transaction's shrink check,
 * so the configured budget is trimmed to a fraction of what the span occupies.
 * The system head is excluded because the transaction prices only surface nodes
 * when it decides whether the replacement is smaller.
 * @param {readonly object[]} messages - the messages about to be evicted.
 * @param {{ noteMaxBytes: number }} config - resolved plugin policy.
 * @returns {number} the byte budget this note may use.
 */
function spanNoteBudget(messages, config) {
  const span = messages.filter(message => message.role !== 'system')
  const spanBytes = Buffer.byteLength(JSON.stringify(span), 'utf8')
  const permitted = Math.floor(spanBytes / 2) - CHECKPOINT_FRAMING_BYTES
  return Math.max(0, Math.min(config.noteMaxBytes, permitted))
}

/**
 * Render the block a pin call leaves in the conversation.
 *
 * The block is the pins' only durable home: it is a normal tool result on the
 * surface, so the next rollover reads it back without any side storage.
 * @param {readonly string[]} pins - validated pinned facts.
 * @returns {string} the model-visible pin block.
 */
function renderPins(pins) {
  const body = pins.map(pin => `- ${pin}`).join('\n')
  return `${PINS_OPEN}\n${body}\n${PINS_CLOSE}\nPinned ${pins.length} ${pins.length === 1 ? 'fact' : 'facts'} to the sticky note.`
}

/**
 * Normalize and bound the pinned facts of one call.
 *
 * A pin replaces the previous set, so an empty list is rejected: an accidental
 * empty call must not silently erase the state the next rollover depends on.
 * @param {readonly string[]} raw - model-supplied lines, already schema-checked.
 * @param {{ pinnedLineMaxChars: number, pinnedMaxBytes: number }} config - resolved policy.
 * @returns {string[]} trimmed, deduplicated, bounded lines.
 * @throws {Error} when no usable line remains.
 */
function toPins(raw, config) {
  /** @type {string[]} */
  const pins = []
  const seen = new Set()
  let used = 0
  for (const entry of raw) {
    const line = entry.replace(/\s+/gu, ' ').trim().slice(0, config.pinnedLineMaxChars)
    if (line.length === 0 || seen.has(line)) continue
    const size = Buffer.byteLength(line, 'utf8') + 3
    if (used + size > config.handoffMaxBytes) {
      throw new Error(
        `sticky_note: the pinned list exceeds the ${config.handoffMaxBytes}-byte handoff budget after `
        + `${pins.length} ${pins.length === 1 ? 'entry' : 'entries'}; consolidate it and call again`,
      )
    }
    seen.add(line)
    pins.push(line)
    used += size
  }
  if (pins.length === 0) {
    throw new Error('sticky_note: provide at least one non-empty pin')
  }
  return pins
}

/**
 * Keep the pinned lines one note can actually carry.
 *
 * Read must not attest to a fact the next rollover is going to drop, so the
 * reported list is the list a note of the current budget renders.
 * @param {readonly string[]} pins - the full pinned list.
 * @param {number} maxBytes - the note's pinned-section budget.
 * @returns {string[]} the carried prefix.
 */
function carriedPins(pins, maxBytes) {
  /** @type {string[]} */
  const carried = []
  let used = 0
  for (const pin of pins) {
    const size = Buffer.byteLength(`- ${pin}`, 'utf8') + 1
    if (used + size > maxBytes) break
    carried.push(pin)
    used += size
  }
  return carried
}

/**
 * Read the pinned list currently carried by this session.
 *
 * The newest pin block in the log is authoritative, including one already
 * carried into the note by a rollover.
 * @param {object} session - the session to read.
 * @returns {string[]} pinned lines, empty when nothing was pinned yet.
 */
function currentPins(session) {
  const events = session.snapshotEvents()
  /** @type {Map<string, string>} */
  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name)
  }
  /** @type {string[]} */
  let pins = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    if (calls.get(event.data.message?.source?.callId) !== PIN_TOOL_NAME) continue
    const found = extractPins(textOf(event.data.message))
    if (found !== null) pins = found
  }
  if (pins.length > 0) return pins
  for (const message of session.deriveMessages()) {
    if (message.source?.kind !== 'compact-checkpoint') continue
    const section = /## Handoff\n([\s\S]*?)(?:\n## |\n<\/sticky-note>)/u.exec(textOf(message))
    if (section === null) continue
    const lines = section[1]
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/u, '').trim())
      .filter(line => line.length > 0 && line !== '(none)')
    if (lines.length > 0) pins = lines
  }
  return pins
}

/** Model-facing contract of the pin tool. */
const PIN_TOOL_DESCRIPTION =
  'Write or read the handoff note that survives a window change. When this window ends, every message '
  + 'before the current turn leaves the conversation; the next window starts with the system prompt and '
  + 'this note only. Anything you leave out is gone from the live context and reachable only through '
  + '`history_query`. Call `update` as work progresses — each call replaces the whole list, so send the '
  + 'complete set: the goal and what finishing means, decisions with their reasons, non-obvious '
  + 'constraints, rejected approaches, open questions, and the exact next action. Write terse imperative '
  + 'lines, not narrative. Call `read` to see exactly what a fresh window will inherit.'

/** Model-facing contract of the sensing tool. */
const SENSING_TOOL_DESCRIPTION =
  'Report how much of this window is left before it ends. Returns the tokens used, the rollover line, '
  + 'the tokens remaining, the current window ordinal, and whether the number comes from provider usage '
  + 'or a local estimate. Call it before a large step, and to decide whether the note is current enough '
  + 'to roll over.'

/** Model-facing contract of the recall tool. */
const HISTORY_TOOL_DESCRIPTION =
  'Read the conversation that earlier rollovers evicted. Nothing is deleted: each rollover archives the '
  + 'messages it replaced, addressable by window and position. `windows` lists the archived windows, '
  + '`search` finds a case-sensitive literal across archived text and returns item ids, and `read` '
  + 'returns one item by id. The current window is not archived yet, so it never appears here. Use this '
  + 'when the sticky note is not detailed enough and the exact earlier wording, path, or error matters.'

/**
 * Build the pin tool for one resolved configuration.
 * @param {object} config - resolved plugin policy.
 * @returns {object} a tool definition for `ctx.tools.register`.
 */
function createPinTool(config) {
  return defineTool({
    name: 'sticky_note',
    description: PIN_TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['read', 'update'],
        description: 'read returns the carried list; update replaces it with `pins`.',
      },
      pins: {
        type: 'array',
        description: 'The COMPLETE pinned list, replacing any previous list. Required for `update`.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          pins: { type: 'array', required: true, items: { type: 'string' } },
          count: { type: 'integer', required: true },
          total: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.count === 0
          ? 'No facts are pinned yet, so the sticky note carries only what it derives from the messages.'
          : renderPins(value.pins)
            + (value.total > value.count
              ? ` Only ${value.count} of ${value.total} pinned lines fit the note budget; consolidate the list.`
              : ''),
      }],
    },
    execute(args, exec) {
      const session = requireSession(exec, 'sticky_note')
      if (args.action === 'read') {
        const all = currentPins(session)
        const carried = carriedPins(all, config.handoffMaxBytes)
        return Promise.resolve({ action: 'read', pins: carried, count: carried.length, total: all.length })
      }
      if (args.pins === undefined) {
        throw new Error('sticky_note: `pins` is required for action `update`')
      }
      const pins = toPins(args.pins, config)
      return Promise.resolve({ action: 'update', pins, count: pins.length, total: pins.length })
    },
    presentCall: args => ({ card: 'generic', title: 'Sticky note', kind: 'other', rawInput: args.pins ?? args.action }),
  })
}

/**
 * Build the sensing tool bound to the engine that owns the transaction policy.
 * @param {object} engine - the compaction engine whose config and services answer the question.
 * @returns {object} a tool definition for `ctx.tools.register`.
 */
function createSensingTool(engine) {
  return defineTool({
    name: 'context_status',
    description: SENSING_TOOL_DESCRIPTION,
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          available: { type: 'boolean', required: true },
          reason: { type: 'string' },
          window: { type: 'integer' },
          usedTokens: { type: 'integer' },
          remainingTokens: { type: 'integer' },
          rolloverAtTokens: { type: 'integer' },
          contextWindow: { type: 'integer' },
          reservedCompletionTokens: { type: 'integer' },
          source: { type: 'string' },
          advice: { type: 'string' },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(_args, exec) {
      const session = requireSession(exec, 'context_status')
      const header = session.requestHeader()
      if (header === undefined) {
        return { available: false, reason: 'No request has been routed in this session yet.' }
      }
      const { provider, model, maxTokens } = header.config
      if (provider.length === 0 || model.length === 0) {
        return { available: false, reason: 'The latest request carries no routed model.' }
      }
      const measurement = engine.ctx.tokenMeter.measure(session)
      const signal = exec.signal ?? new AbortController().signal
      let info
      try {
        info = await engine.ctx.llm.resolveModelInfo(provider, model, signal)
      } catch (error) {
        // A cancelled call must not read as "no budget available".
        signal.throwIfAborted()
        return {
          available: false,
          reason: `Cannot resolve ${provider}/${model}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
      const contextWindow = info.context?.contextWindow
      if (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0) {
        return {
          available: false,
          reason: `${provider}/${model} declares no context window, so no rollover line exists; `
            + 'configure contextWindow on that adapter model.',
        }
      }
      const reservedCompletionTokens = maxTokens ?? info.defaultMaxTokens ?? 0
      const budget = resolveRolloverBudget(
        engine.config, { provider, model }, contextWindow, reservedCompletionTokens,
      )
      if (budget.problem !== undefined) {
        return { available: false, reason: `${provider}/${model}: ${budget.problem}` }
      }
      const status = describeStatus({
        usedTokens: measurement.totalTokens,
        providerMeasured: measurement.baseline.kind === 'usage',
        contextWindow,
        reservedCompletionTokens,
        rolloverAtTokens: budget.thresholdTokens,
        windowNumber: currentWindowNumber(session),
        warningTokens: engine.policy.warningTokens,
      })
      return { available: true, ...status }
    },
    presentCall: () => ({ card: 'generic', title: 'Context status', kind: 'other' }),
  })
}

/**
 * Render one sensing result for the model.
 * @param {object} value - the tool's output value.
 * @returns {string} a short, actionable report.
 */
function renderStatus(value) {
  if (value.available !== true) return `Context status unavailable: ${value.reason ?? 'unknown reason'}`
  return [
    `Window ${value.window}: ${value.usedTokens} of ${value.rolloverAtTokens} tokens used `
      + `(${value.contextWindow} context, ${value.reservedCompletionTokens} reserved for the reply).`,
    `Remaining before rollover: ${value.remainingTokens} tokens (source: ${value.source}).`,
    value.advice,
  ].join('\n')
}

/**
 * Build the recall tool over the session archive.
 * @param {object} config - resolved plugin policy.
 * @returns {object} a tool definition for `ctx.tools.register`.
 */
function createHistoryTool(config) {
  return defineTool({
    name: 'history_query',
    description: HISTORY_TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['windows', 'search', 'read'],
        description: 'windows lists archived windows; search finds a literal; read returns one item.',
      },
      query: { type: 'string', description: 'Case-sensitive literal to find. Required for `search`.' },
      id: { type: 'string', description: 'Item id such as `w1:2`. Required for `read`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          total: { type: 'integer' },
          truncated: { type: 'boolean' },
          windows: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                window: { type: 'integer', required: true },
                items: { type: 'integer', required: true },
                evictedTokens: { type: 'integer', required: true },
                firstTime: { type: 'integer', required: true },
                lastTime: { type: 'integer', required: true },
                idRange: { type: 'string', required: true },
              },
            },
          },
          hits: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                window: { type: 'integer', required: true },
                role: { type: 'string', required: true },
                occurrences: { type: 'integer', required: true },
                snippet: { type: 'string', required: true },
              },
            },
          },
          found: { type: 'boolean' },
          item: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string', required: true },
              window: { type: 'integer', required: true },
              role: { type: 'string', required: true },
              truncated: { type: 'boolean', required: true },
              text: { type: 'string', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderHistory(value) }],
    },
    execute(args, exec) {
      const session = requireSession(exec, 'history_query')
      const archive = collectArchive(session)
      if (args.action === 'windows') {
        const windows = describeWindows(archive)
        return Promise.resolve({ action: 'windows', total: windows.length, windows })
      }
      if (args.action === 'search') {
        if (args.query === undefined || args.query.length === 0) {
          throw new Error('history_query: `query` is required for action `search`')
        }
        return Promise.resolve({
          action: 'search',
          ...searchArchive(archive, args.query, config.historySearchLimit, config.historySnippetChars),
        })
      }
      if (args.id === undefined || args.id.length === 0) {
        throw new Error('history_query: `id` is required for action `read`')
      }
      const item = readArchivedItem(archive, args.id, config.historyReadMaxChars)
      return Promise.resolve({ action: 'read', found: item.found, ...item.found ? { item } : {} })
    },
    presentCall: args => ({ card: 'generic', title: 'History query', kind: 'other', rawInput: { action: args.action, query: args.query ?? args.id } }),
  })
}

/**
 * Render one recall result for the model.
 * @param {object} value - the tool's output value.
 * @returns {string} a short, readable report.
 */
function renderHistory(value) {
  switch (value.action) {
    case 'windows': {
      if (value.total === 0) return 'Nothing has been archived yet: this session has not rolled over.'
      return [
        `${value.total} archived ${value.total === 1 ? 'window' : 'windows'}, oldest first:`,
        ...value.windows.map(window => `- window ${window.window}: ${window.items} items, `
          + `${window.evictedTokens} tokens, ids ${window.idRange}`),
      ].join('\n')
    }
    case 'search': {
      if (value.total === 0) return 'No archived item contains that literal.'
      const header = `${value.total} matching ${value.total === 1 ? 'item' : 'items'}`
        + `${value.truncated ? `, showing the first ${value.hits.length}` : ''}:`
      return [
        header,
        ...value.hits.map(hit => `- ${hit.id} (${hit.role}, ${hit.occurrences}x): ${hit.snippet}`),
      ].join('\n')
    }
    case 'read': {
      if (value.found !== true) return 'No archived item carries that id.'
      return `${value.item.id} (${value.item.role}, window ${value.item.window}`
        + `${value.item.truncated ? ', truncated' : ''}):\n${value.item.text}`
    }
    default:
      return 'Unknown history action.'
  }
}

/**
 * Require the calling agent's session.
 * @param {object} exec - tool execution context.
 * @param {string} tool - tool name for the diagnostic.
 * @returns {object} the owning session.
 * @throws {Error} when the call has no owning agent.
 */
function requireSession(exec, tool) {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error(`${tool} requires an owning agent session`)
  }
  return session
}

/** Model-facing contract of the rollover tool. */
const NEW_CONTEXT_TOOL_DESCRIPTION =
  'Open a new memory window once the handoff note is saved. The fresh window keeps only the system prompt, '
  + 'your `sticky_note` list, and the work still in flight; every earlier message leaves the conversation '
  + 'and stays reachable only through `history_query`. Call `sticky_note` first — a rollover with no saved '
  + 'note is refused, because the note is the only thing that survives it.'

/**
 * Build the rollover tool bound to the engine that owns the transaction.
 * @param {object} engine - the compaction engine that performs the rollover.
 * @returns {object} a tool definition for `ctx.tools.register`.
 */
function createNewContextTool(engine) {
  return defineTool({
    name: 'new_context',
    description: NEW_CONTEXT_TOOL_DESCRIPTION,
    parameters: {
      reason: { type: 'string', description: 'Optional. Why a new window is appropriate now.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          rolled: { type: 'boolean', required: true },
          window: { type: 'integer' },
          evicted: { type: 'integer' },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.detail }],
    },
    async execute(args, exec) {
      const session = requireSession(exec, 'new_context')
      const gate = noteSavedThisWindow(session)
      if (!gate.saved) {
        return {
          rolled: false,
          detail: 'No note is saved in this window, so a rollover would leave nothing behind. Call '
            + '`sticky_note` with action `update` and the complete handoff list, then call `new_context` '
            + 'again in this same turn.',
        }
      }
      const range = selectRolloverRange(session)
      if (range === null) {
        return {
          rolled: false,
          detail: 'Nothing is evictable yet: the current turn is the only history in this window.',
        }
      }
      const signal = exec.signal ?? new AbortController().signal
      const result = await engine.rolloverNow(exec.agent, signal)
      if (result === null) {
        return {
          rolled: false,
          detail: 'The history before this turn is too small to be worth a window change — the note '
            + 'would be larger than what it replaces. Keep working in this window and write the note '
            + 'before the budget runs out.',
        }
      }
      return {
        rolled: true,
        window: currentWindowNumber(session),
        evicted: result.shadowedSeqs.length,
        detail: `Rolled over to window ${currentWindowNumber(session)}: ${result.shadowedSeqs.length} `
          + `messages left the conversation and now live only in the archive. Continue from the note`
          + `${typeof args.reason === 'string' && args.reason.length > 0 ? ` (${args.reason})` : ''}.`,
      }
    },
    presentCall: () => ({ card: 'generic', title: 'Open new window', kind: 'other' }),
  })
}

/** Byte- or count-valued budget shared by the schema. */
const COUNT = () => z.number().step(1).min(1)

/**
 * Schemastery schema for the complete plugin config.
 *
 * Every lifecycle key is optional here because an absent key leaves the
 * shipped default in force; {@link resolveConfig} owns the remaining defaults.
 */
const CONFIG_SCHEMA = z.object({
  thresholdRatio: z.number(),
  headroomTokens: z.number().step(1).min(0),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  maxTokens: COUNT(),
  compactionRetries: z.number().step(1).min(0),
  maxOverflowRetries: z.number().step(1).min(0),
  modelPolicies: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    thresholdRatio: z.number(),
    headroomTokens: z.number().step(1).min(0),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    maxTokens: COUNT(),
    compactionRetries: z.number().step(1).min(0),
    maxOverflowRetries: z.number().step(1).min(0),
  })),
  auto: z.boolean(),
  noteMaxBytes: COUNT(),
  handoffMaxBytes: COUNT(),
  recordedMaxBytes: COUNT(),
  fileListMax: COUNT(),
  commandListMax: COUNT(),
  pinnedLineMaxChars: COUNT(),
  warningTokens: COUNT(),
  warnTokens: COUNT(),
  fallbackTokens: COUNT(),
  minEvictTokens: COUNT(),
  notices: z.boolean(),
  historyReadMaxChars: COUNT(),
  historySearchLimit: COUNT(),
  historySnippetChars: COUNT(),
  derivedAppendix: z.boolean(),
  noteTool: z.boolean(),
  sensingTool: z.boolean(),
  historyTool: z.boolean(),
  newContextTool: z.boolean(),
  guidance: z.boolean(),
})

/**
 * Sliding-window compaction backend.
 *
 * It owns no policy the shipped backend owned: trigger thresholds, retained
 * window selection, tool-pair boundaries, the durable `compaction/*` bracket,
 * and replay all stay in the transaction it extends. Only the replacement
 * content changes, from a model summary to the carried note.
 */
export class StickyWindowCompactionEngine extends BasicCompactionEngine {
  /** Services the transaction and the tools require. */
  static inject = ['llm', 'tokenMeter', 'sessions', 'tools']

  /** Complete plugin config schema. */
  static Config = CONFIG_SCHEMA

  /** Per-session budget notices already delivered in the current window. */
  #notices = new WeakMap()

  /** Per-session resolved budget, keyed by the route it was resolved for. */
  #budgets = new WeakMap()

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {Record<string, unknown>} [config] - raw plugin config.
   */
  constructor(ctx, config = {}) {
    const policy = resolveConfig(config)
    super(ctx, toLifecycleConfig(config))
    /** Resolved plugin policy for the note and the tools. */
    this.policy = policy
    const tools = [
      policy.noteTool ? createPinTool(policy) : null,
      policy.sensingTool ? createSensingTool(this) : null,
      policy.historyTool ? createHistoryTool(policy) : null,
      policy.newContextTool ? createNewContextTool(this) : null,
    ].filter(tool => tool !== null)
    if (tools.length > 0) {
      ctx.effect(() => {
        const disposers = tools.map(tool => ctx.tools.register(tool))
        return () => { for (const dispose of disposers) dispose() }
      })
    }
    if (policy.guidance) {
      // The prompt registry is optional: a composition without it (a bare SDK
      // host) still compacts, it just cannot tell the model how to cooperate.
      const prompt = ctx.get('systemPrompt')
      if (prompt !== undefined) {
        ctx.effect(() => prompt.section({
          name: GUIDANCE_SECTION_NAME,
          order: GUIDANCE_SECTION_ORDER,
          text: GUIDANCE_TEXT,
          interpolate: false,
        }))
      }
    }
    this.#registerNotices()
  }

  /**
   * Decide whether an automatic rollover happens now.
   *
   * A prepared model gets its window changed as soon as the pressure line is
   * crossed. An unprepared one does not: the rollover is postponed into the
   * fallback band while notices ask for the note, because evicting history the
   * model never wrote down is the one failure this backend exists to prevent.
   * A provider-confirmed overflow is the exception — there the window must end,
   * and the note says plainly that none was written.
   * @param {object} agent - agent whose session is measured.
   * @param {'pressure' | 'context-overflow'} trigger - why the transaction is considering a rollover.
   * @param {AbortSignal} signal - live turn cancellation signal.
   * @returns {Promise<object | null>} the rollover result, or null when none ran.
   */
  async compactIfNeeded(agent, trigger, signal) {
    if (trigger === 'context-overflow') return this.rolloverNow(agent, signal)
    const budget = await this.#budgetFor(agent.session, signal)
    if (budget === undefined) return null
    const used = this.ctx.tokenMeter.measure(agent.session).totalTokens
    if (used < budget.thresholdTokens) return null
    if (!noteSavedThisWindow(agent.session).saved) return null
    return this.rolloverNow(agent, signal)
  }

  /**
   * Resolve the routed target's rollover line and capacity.
   *
   * Cached per session and route: the caller runs on every step, and resolving
   * model info is a provider round trip that does not change within a window.
   * @param {object} session - session whose latest request is measured.
   * @param {AbortSignal} signal - cancellation for the model-info lookup.
   * @returns {Promise<object | undefined>} the budget, or undefined when it cannot be resolved.
   */
  async #budgetFor(session, signal) {
    const header = session.requestHeader()
    if (header === undefined) return undefined
    const { provider, model, maxTokens } = header.config
    if (provider.length === 0 || model.length === 0) return undefined
    const key = `${provider}/${model}/${maxTokens ?? ''}`
    const cached = this.#budgets.get(session)
    if (cached !== undefined && cached.key === key) return cached.value
    const resolved = await this.#resolveBudget(provider, model, maxTokens, signal)
    // A lookup that failed (network, aborted) is retried next step; only a
    // resolved answer, including a definitive "no capacity", is cached.
    if (resolved.cacheable) this.#budgets.set(session, { key, value: resolved.value })
    return resolved.value
  }

  /**
   * Resolve one route's budget, without caching.
   * @param {string} provider - routed provider.
   * @param {string} model - routed model.
   * @param {number | undefined} maxTokens - the request's own output cap, when set.
   * @param {AbortSignal} signal - cancellation for the lookup.
   * @returns {Promise<{ cacheable: boolean, value: object | undefined }>} the budget and whether it may be cached.
   */
  async #resolveBudget(provider, model, maxTokens, signal) {
    let info
    try {
      info = await this.ctx.llm.resolveModelInfo(provider, model, signal)
    } catch (error) {
      signal.throwIfAborted()
      return { cacheable: false, value: undefined }
    }
    const contextWindow = info.context?.contextWindow
    if (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0) {
      return { cacheable: true, value: undefined }
    }
    const reserved = maxTokens ?? info.defaultMaxTokens ?? 0
    const budget = resolveRolloverBudget(this.config, { provider, model }, contextWindow, reserved)
    if (budget.problem !== undefined) return { cacheable: true, value: undefined }
    return { cacheable: true, value: { ...budget, contextWindow, reserved } }
  }

  /**
   * Evict everything before the current turn and replace it with the note.
   *
   * A span smaller than `minEvictTokens` is refused rather than attempted: the
   * note's framing alone can exceed a tiny span, and the transaction then raises
   * a shrink failure. Refusing keeps a small window a plain no-op.
   * @param {object} agent - agent owning the session.
   * @param {AbortSignal} signal - cancellation signal.
   * @returns {Promise<object | null>} the result, or null when nothing worth evicting exists.
   */
  async rolloverNow(agent, signal) {
    const session = agent.session
    this.ctx.get('toolResultPruner')?.pruneSession(session)
    const range = selectRolloverRange(session)
    if (range === null) return null
    // A range names surface POSITIONS. After a replace the surface is not
    // seq-monotonic, so the span is sliced by index, never by seq comparison.
    const nodes = this.ctx.tokenMeter.measure(session).nodes
    const startIdx = nodes.findIndex(node => node.seq === range.start)
    const endIdx = nodes.findIndex(node => node.seq === range.end)
    if (startIdx === -1 || endIdx < startIdx) return null
    const priced = nodes.slice(startIdx, endIdx + 1).reduce((total, node) => total + node.tokens, 0)
    if (priced < this.policy.minEvictTokens) return null
    return this.compactRegion(range.start, range.end, agent, signal)
  }

  /**
   * Announce the budget while the model can still act on it.
   *
   * Registered ahead of the pressure listener so the notice reflects the window
   * the step is about to run in, and dropped when that listener rolled over
   * first.
   */
  #registerNotices() {
    if (!this.policy.notices) return
    this.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      const pending = await this.#noticeFor(agent)
      const before = currentWindowNumber(agent.session)
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      if (pending === undefined || currentWindowNumber(agent.session) !== before) return decision
      // Record only now: a rejected step must not consume the one notice this
      // window gets for its stage.
      pending.state.sent.add(pending.stage)
      const message = createUserMessage({
        content: [{ type: 'text', text: pending.notice.text }],
        source: { kind: NOTICE_SOURCE_KIND, form: 'notice', summary: pending.notice.summary },
      })
      return { ...decision, messages: [message, ...decision.messages] }
    }, { prepend: true })
  }

  /**
   * Choose the notice this step deserves, at most once per window per stage.
   *
   * Nothing is recorded here: the caller records the stage after the step is
   * known to enter, so a rejection does not burn it.
   * @param {object} agent - agent whose session is measured.
   * @returns {Promise<{ stage: string, notice: { text: string, summary: string }, state: object } | undefined>} the pending notice.
   */
  async #noticeFor(agent) {
    const session = agent.session
    const budget = await this.#budgetFor(session, new AbortController().signal)
    if (budget === undefined) return undefined
    const used = this.ctx.tokenMeter.measure(session).totalTokens
    const ceiling = rolloverCeiling(budget, this.policy.fallbackTokens, budget.contextWindow, budget.reserved)
    const window = currentWindowNumber(session)
    const previous = this.#notices.get(session)
    const state = previous !== undefined && previous.window === window
      ? previous
      : { window, sent: new Set() }
    this.#notices.set(session, state)
    /**
     * Offer one stage at most once per window.
     * @param {string} stage - stage key.
     * @param {() => { text: string, summary: string }} build - notice builder.
     * @returns {object | undefined} the pending notice when this stage is new.
     */
    const once = (stage, build) => (state.sent.has(stage) ? undefined : { stage, notice: build(), state })
    if (used >= ceiling) {
      // Once the note is saved the rollover happens in `compactIfNeeded`; the
      // notice is only for a window that cannot end yet.
      return noteSavedThisWindow(session).saved ? undefined : once('blocked', blockedNotice)
    }
    if (used >= budget.thresholdTokens) {
      return once('exhausted', () => exhaustedNotice(ceiling - used))
    }
    if (budget.thresholdTokens - used <= this.policy.warnTokens) {
      return once('warn', () => warningNotice(budget.thresholdTokens - used))
    }
    return undefined
  }

  /**
   * Replace the evicted span with the deterministic sticky note.
   *
   * Overriding this single hook is what retires the summarizing backend: the
   * transaction still records the `compaction/*` bracket, prices the
   * replacement, and enforces tool-pair boundaries, but no model is called.
   * @param {{ messages: readonly object[] }} input - the replayed evicted span.
   * @param {object} agent - agent owning the session being compacted.
   * @param {AbortSignal} [signal] - cancellation for this rollover.
   * @returns {Promise<object>} the note as the replacement's content blocks.
   */
  async summarize(input, agent, signal) {
    signal?.throwIfAborted()
    const budget = spanNoteBudget(input.messages, this.policy)
    // Read the handoff from the whole session: a note written in the turn that
    // triggered this rollover sits outside the evicted span.
    const handoff = currentPins(agent.session)
    const { text } = buildStickyNote(
      input.messages,
      { ...this.policy, noteMaxBytes: budget },
      { handoff },
    )
    return {
      summary: [{ type: 'text', text }],
      provider: 'dsh-compaction-sticky-window',
      model: 'deterministic-note',
    }
  }
}

export default StickyWindowCompactionEngine
