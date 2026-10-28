/**
 * The four model-facing tools this backend registers.
 *
 * They are separated from the engine so the engine file stays about the
 * transaction and this file stays about what the model can ask for.
 *
 * @module dsh-compaction-sticky-window/tools
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { carriedPins, currentPins, renderPins, toPins } from './pins.js'
import {
  collectArchive,
  currentWindowNumber,
  describeWindows,
  readArchivedItem,
  searchArchive,
} from './history.js'
import { describeStatus, resolveRolloverBudget } from './budget.js'
import { noteSavedThisWindow, selectRolloverRange } from './window.js'

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
export function createPinTool(config) {
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
export function createSensingTool(engine) {
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
export function createHistoryTool(config) {
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
export function createNewContextTool(engine) {
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

