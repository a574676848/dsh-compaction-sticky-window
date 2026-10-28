/**
 * Sticky-note plus sliding-window compaction backend for DeepSeek Harness.
 *
 * The shipped backend replaces an old span with a model-written summary: one
 * extra model call per rollover, and a summary that a reader must trust. This
 * backend keeps the same durable transaction and the same ability to reclaim
 * context, but changes what survives. Everything older than a retained verbatim
 * window is replaced by a deterministic note built from the evicted messages
 * themselves — objective, verified state, open issues, next action — plus the
 * facts the model pinned with the `sticky_note` tool. No model call is made, so
 * a rollover costs nothing and replays identically.
 *
 * @module dsh-compaction-sticky-window
 */

import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveNoteConfig, toLifecycleConfig } from './src/config.js'
import { PINS_CLOSE, PINS_OPEN, buildStickyNote } from './src/note.js'

/** Bytes of framing the checkpoint wrapper adds around the note. */
const CHECKPOINT_FRAMING_BYTES = 512

/**
 * Conservative note budget for one span.
 *
 * A note larger than the span it replaces fails the transaction's shrink check,
 * so the configured budget is trimmed to a fraction of what the span occupies.
 * Derived messages cost roughly a token per four bytes on both sides of that
 * comparison, which makes a byte comparison a safe proxy.
 * @param {readonly object[]} messages - the messages about to be evicted.
 * @param {{ noteMaxBytes: number }} config - resolved note policy.
 * @returns {number} the byte budget this note may use.
 */
function spanNoteBudget(messages, config) {
  const spanBytes = Buffer.byteLength(JSON.stringify(messages), 'utf8')
  const permitted = Math.floor(spanBytes / 2) - CHECKPOINT_FRAMING_BYTES
  return Math.max(512, Math.min(config.noteMaxBytes, permitted))
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
 * @param {{ pinnedLineMaxChars: number, pinnedMaxBytes: number }} config - resolved note policy.
 * @returns {string[]} trimmed, deduplicated, bounded lines.
 * @throws {Error} when no usable line remains.
 */
function toPins(raw, config) {
  const limit = Math.max(1, Math.floor(config.pinnedMaxBytes / 32))
  /** @type {string[]} */
  const pins = []
  const seen = new Set()
  for (const entry of raw) {
    const line = entry.replace(/\s+/gu, ' ').trim().slice(0, config.pinnedLineMaxChars)
    if (line.length === 0 || seen.has(line)) continue
    seen.add(line)
    pins.push(line)
  }
  if (pins.length === 0) {
    throw new Error('sticky_note: provide at least one non-empty pin')
  }
  if (pins.length > limit) {
    throw new Error(
      `sticky_note: at most ${limit} pins fit the configured budget; `
      + 'consolidate the list and call again',
    )
  }
  return pins
}

/** Model-facing contract of the pin tool. */
const PIN_TOOL_DESCRIPTION =
  'Pin durable facts that must survive context eviction. This session keeps a sliding context window: '
  + 'older messages are replaced by a sticky note that carries the pinned list forward verbatim, while the '
  + 'recent window stays intact. Call this once a decision, constraint, or open problem must not be lost, '
  + 'and again after it changes. Each call replaces the whole pinned list, so send the complete set you '
  + 'want carried. Write terse imperative lines: what is decided, what is verified, what remains. '
  + 'Echo the current list when only one entry changes.'

/**
 * Build the pin tool for one resolved configuration.
 * @param {{ pinnedLineMaxChars: number, pinnedMaxBytes: number }} config - resolved note policy.
 * @returns {object} a tool definition for `ctx.tools.register`.
 */
function createStickyNoteTool(config) {
  return defineTool({
    name: 'sticky_note',
    description: PIN_TOOL_DESCRIPTION,
    parameters: {
      pins: {
        type: 'array',
        required: true,
        description: 'The COMPLETE pinned list, replacing any previously pinned list.',
        items: { type: 'string' },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pins: { type: 'array', required: true, items: { type: 'string' } },
          count: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: renderPins(value.pins) }],
    },
    execute(args) {
      const pins = toPins(args.pins, config)
      return Promise.resolve({ pins, count: pins.length })
    },
    presentCall: args => ({ card: 'generic', title: 'Pin sticky note', kind: 'other', rawInput: args.pins }),
  })
}

/** Byte- or count-valued note budget shared by the schema. */
const COUNT = () => z.number().step(1).min(1)

/**
 * Schemastery schema for the complete plugin config.
 *
 * Every lifecycle key is optional here because an absent key leaves the
 * shipped default in force; {@link resolveNoteConfig} owns the note defaults.
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
  objectiveMaxBytes: COUNT(),
  verifiedMaxBytes: COUNT(),
  openIssueMaxBytes: COUNT(),
  pinnedMaxBytes: COUNT(),
  objectiveMessages: COUNT(),
  fileListMax: COUNT(),
  commandListMax: COUNT(),
  pinnedLineMaxChars: COUNT(),
  noteTool: z.boolean(),
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
  /** Services the transaction and the pin tool require. */
  static inject = ['llm', 'tokenMeter', 'sessions', 'tools']

  /** Complete plugin config schema. */
  static Config = CONFIG_SCHEMA

  /**
   * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
   * @param {Record<string, unknown>} [config] - raw plugin config.
   */
  constructor(ctx, config = {}) {
    const noteConfig = resolveNoteConfig(config)
    super(ctx, toLifecycleConfig(config))
    /** Resolved note policy; see {@link import('./src/config.js').NoteConfig}. */
    this.noteConfig = noteConfig
    if (noteConfig.noteTool) {
      ctx.effect(() => ctx.tools.register(createStickyNoteTool(noteConfig)))
    }
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
    const budget = spanNoteBudget(input.messages, this.noteConfig)
    const { text } = buildStickyNote(input.messages, { ...this.noteConfig, noteMaxBytes: budget })
    return {
      summary: [{ type: 'text', text }],
      provider: 'dsh-compaction-sticky-window',
      model: 'deterministic-note',
    }
  }
}

export default StickyWindowCompactionEngine
