/**
 * Sticky-window compaction backend for DeepSeek Harness.
 *
 * The shipped backend replaces an old span with a model-written summary. This
 * backend inverts the ownership: the model writes its own handoff note with
 * `sticky_note`, opens a window with `new_context`, and the fresh window holds
 * the system prompt, that note, and the turn in flight — nothing else. An
 * automatic rollover refuses to evict history the model never wrote down, and
 * pushes budget notices so it never has to.
 *
 * Tool definitions live in `./src/tools.js`; pin parsing in `./src/pins.js`.
 *
 * @module dsh-compaction-sticky-window
 */

import z from '@deepseek-ai/schemastery'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { resolveConfig, toLifecycleConfig } from './src/config.js'
import { PIN_TOOL_NAME, buildStickyNote, extractPins, textOf } from './src/note.js'
import { resolveRolloverBudget, rolloverCeiling } from './src/budget.js'
import { selectRolloverRange } from './src/window.js'
import {
  NOTICE_SOURCE_KIND,
  blockedNotice,
  exhaustedNotice,
  readyNotice,
  warningNotice,
} from './src/notice.js'
import { GUIDANCE_SECTION_NAME, GUIDANCE_SECTION_ORDER, GUIDANCE_TEXT } from './src/guidance.js'
import { currentPins } from './src/pins.js'
import { createHistoryTool, createNewContextTool, createPinTool, createSensingTool } from './src/tools.js'

/** Bytes of framing the checkpoint wrapper adds around the note. */
const CHECKPOINT_FRAMING_BYTES = 512

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
  budgetRecheckMs: COUNT(),
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

  /** Incremental window/gate state per session, advanced by `eventAt`. */
  #windowStates = new WeakMap()

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
    if (!this.#windowState(agent.session).saved) return null
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
    const now = Date.now()
    const cached = this.#budgets.get(session)
    if (cached !== undefined && cached.key === key) {
      if (cached.value !== undefined) return cached.value
      // A negative answer is re-asked after `budgetRecheckMs`, because an
      // operator can fix the adapter's capacity while the session runs.
      if (now < cached.retryAt) return undefined
    }
    const resolved = await this.#resolveBudget(provider, model, maxTokens, signal)
    if (resolved.value !== undefined) {
      this.#budgets.set(session, { key, value: resolved.value })
    } else {
      this.#budgets.set(session, { key, retryAt: Date.now() + this.policy.budgetRecheckMs })
    }
    return resolved.value
  }

  /**
   * Resolve one route's budget, without caching.
   * @param {string} provider - routed provider.
   * @param {string} model - routed model.
   * @param {number | undefined} maxTokens - the request's own output cap, when set.
   * @param {AbortSignal} signal - cancellation for the lookup.
   * @returns {Promise<{ value: object | undefined }>} the budget, when one exists.
   */
  async #resolveBudget(provider, model, maxTokens, signal) {
    let info
    try {
      info = await this.ctx.llm.resolveModelInfo(provider, model, signal)
    } catch (error) {
      signal.throwIfAborted()
      return { value: undefined }
    }
    const contextWindow = info.context?.contextWindow
    if (typeof contextWindow !== 'number' || !Number.isInteger(contextWindow) || contextWindow <= 0) {
      return { value: undefined }
    }
    const reserved = maxTokens ?? info.defaultMaxTokens ?? 0
    const budget = resolveRolloverBudget(this.config, { provider, model }, contextWindow, reserved)
    if (budget.problem !== undefined) return { value: undefined }
    return { value: { ...budget, contextWindow, reserved } }
  }

  /**
   * Current window ordinal and write-ahead gate state, advanced incrementally.
   *
   * `#noticeFor` runs on every pre-step, so this must cost only the events added
   * since the last call. A summary is counted only once a replacement cites it,
   * which is what keeps a crash between the two appends from opening a window
   * that never ended.
   * @param {object} session - the session to inspect.
   * @returns {{ window: number, saved: boolean }} the current ordinal and whether this window has a saved note.
   */
  #windowState(session) {
    const state = this.#windowStates.get(session)
      ?? { at: 0, window: 0, pending: new Set(), savedInWindow: -1, calls: new Map() }
    for (let seq = state.at; seq < session.seq; seq += 1) {
      const event = session.eventAt(seq)
      if (event === undefined) continue
      switch (event.type) {
        case 'tool/call':
          state.calls.set(event.data.callId, event.data.name)
          break
        case 'compaction/summary':
          state.pending.add(event.seq)
          break
        case 'user/message':
          for (const cited of event.sourceEventSeqs ?? []) {
            if (state.pending.delete(cited)) state.window += 1
          }
          break
        case 'tool/result': {
          if (state.calls.get(event.data.message?.source?.callId) !== PIN_TOOL_NAME) break
          if (event.data.error !== undefined || event.data.message?.isError === true) break
          if (extractPins(textOf(event.data.message)) === null) break
          state.savedInWindow = state.window
          break
        }
        default:
          break
      }
    }
    state.at = session.seq
    this.#windowStates.set(session, state)
    return { window: state.window + 1, saved: state.savedInWindow === state.window }
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
      const before = this.#windowState(agent.session).window
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      if (pending === undefined || this.#windowState(agent.session).window !== before) return decision
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
    // Away from the line there is nothing to say, and the window state below
    // costs a log scan. This runs on every step, so it exits cheap.
    if (used < budget.thresholdTokens - this.policy.warnTokens) return undefined
    const ceiling = rolloverCeiling(budget, this.policy.fallbackTokens, budget.contextWindow, budget.reserved)
    const { window, saved } = this.#windowState(session)
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
      return saved ? undefined : once('blocked', blockedNotice)
    }
    if (used >= budget.thresholdTokens) {
      // A saved note is the precondition for the rollover, not a reason to ask
      // for it again: `compactIfNeeded` ends this window in the same step.
      return saved ? once('ready', readyNotice) : once('exhausted', () => exhaustedNotice(ceiling - used))
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
