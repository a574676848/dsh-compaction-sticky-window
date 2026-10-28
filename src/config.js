/**
 * Configuration for the sticky-window compaction backend.
 *
 * Three groups share one config object: window lifecycle fields the compaction
 * transaction already understands, note fields that decide what the carried
 * note contains, and tool fields that decide what the model can ask about its
 * own context. Lifecycle fields are forwarded untouched so this backend
 * inherits the shipped pressure policy; the rest are resolved here.
 *
 * @module dsh-compaction-sticky-window/config
 */

/**
 * Lifecycle fields forwarded to the compaction transaction. They are the
 * shipped policy vocabulary — trigger fraction, retained-window fraction or
 * absolute size, model policies — and this backend changes none of their
 * meanings.
 */
export const LIFECYCLE_KEYS = [
  'thresholdRatio',
  'headroomTokens',
  'retainRatio',
  'retainTokens',
  'maxTokens',
  'compactionRetries',
  'maxOverflowRetries',
  'modelPolicies',
  'auto',
]

/** Default carried-note budget in UTF-8 bytes. */
const DEFAULT_NOTE_MAX_BYTES = 6144
/** Default budget for the model-authored handoff, which claims its space first. */
const DEFAULT_HANDOFF_MAX_BYTES = 4096
/** Default budget for the derived factual appendix. */
const DEFAULT_RECORDED_MAX_BYTES = 2048
/** Default cap on distinct file paths reported in the appendix. */
const DEFAULT_FILE_LIST_MAX = 24
/** Default cap on distinct commands reported in the appendix. */
const DEFAULT_COMMAND_LIST_MAX = 12
/** Default per-line character cap for a pinned fact. */
const DEFAULT_PINNED_LINE_MAX_CHARS = 400
/** Default remaining-token distance at which the sensing tool warns. */
const DEFAULT_WARNING_TOKENS = 6144
/** Default distance before the rollover line at which the session pushes a warning. */
const DEFAULT_WARN_TOKENS = 6144
/** Default distance past the rollover line during which a rollover is postponed. */
const DEFAULT_FALLBACK_TOKENS = 16384
/**
 * Default smallest evictable span, in tokens.
 *
 * A note carries fixed framing — the transaction's checkpoint preamble, the
 * note's own lead and tail, its headings — that no configuration shrinks. A
 * span smaller than that framing cannot be replaced by anything smaller, so the
 * transaction's shrink check fails and the rollover throws. Refusing below this
 * size turns a hard failure into a plain "not yet".
 */
const DEFAULT_MIN_EVICT_TOKENS = 1024
/**
 * Default time before a failed or negative budget resolution is retried.
 *
 * A resolved budget is cached for the session because resolving it is a
 * provider round trip. A *negative* answer is different: an operator can add a
 * missing `contextWindow` or lower the headroom while the session runs, and the
 * plugin must notice. This interval bounds how long a stale "no budget" lasts.
 */
const DEFAULT_BUDGET_RECHECK_MS = 60_000
/** Default characters returned by one history read. */
const DEFAULT_HISTORY_READ_MAX_CHARS = 4000
/** Default hits returned by one history search. */
const DEFAULT_HISTORY_SEARCH_LIMIT = 5
/** Default characters of context shown around a history search hit. */
const DEFAULT_HISTORY_SNIPPET_CHARS = 400

/**
 * Every field this plugin accepts, besides {@link LIFECYCLE_KEYS}.
 *
 * Note fields shape the carried note; tool fields shape what the model can ask.
 */
export const EXTRA_KEYS = [
  'noteMaxBytes',
  'handoffMaxBytes',
  'recordedMaxBytes',
  'fileListMax',
  'commandListMax',
  'pinnedLineMaxChars',
  'derivedAppendix',
  'noteTool',
  'sensingTool',
  'historyTool',
  'newContextTool',
  'guidance',
  'warningTokens',
  'warnTokens',
  'fallbackTokens',
  'minEvictTokens',
  'budgetRecheckMs',
  'notices',
  'historyReadMaxChars',
  'historySearchLimit',
  'historySnippetChars',
]

/** Resolved plugin policy; frozen so a later mutation cannot change behavior mid-session. */
export class ResolvedConfig {
  /**
   * @param {object} values - resolved values, already validated.
   */
  constructor(values) {
    Object.assign(this, values)
    Object.freeze(this)
  }
}

/**
 * Build the lifecycle-only object the compaction transaction validates.
 *
 * Unset keys stay unset so the shipped defaults keep applying, with one
 * deliberate exception: when the deployment states no retention, this backend
 * retains almost nothing. Keeping a large verbatim tail would leave the model
 * reading old messages instead of the note it was told to write, which defeats
 * the shape the model is instructed to work with.
 * @param {Record<string, unknown>} config - raw plugin config.
 * @returns {Record<string, unknown>} the keys the transaction owns.
 */
export function toLifecycleConfig(config) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of LIFECYCLE_KEYS) {
    if (config[key] !== undefined) out[key] = config[key]
  }
  if (out.retainRatio === undefined && out.retainTokens === undefined) {
    out.retainTokens = 0
  }
  return out
}

/**
 * Validate the complete plugin config and resolve every budget.
 *
 * Unknown keys fail here instead of being dropped: a misspelled budget would
 * otherwise silently fall back to a default the deployer never chose.
 * @param {Record<string, unknown>} config - raw plugin config.
 * @returns {ResolvedConfig} the resolved policy.
 * @throws {Error} when a key is unknown or a value is out of range.
 */
export function resolveConfig(config) {
  for (const key of Object.keys(config)) {
    if (!LIFECYCLE_KEYS.includes(key) && !EXTRA_KEYS.includes(key)) {
      throw new Error(`dsh-compaction-sticky-window: unknown config key "${key}"`)
    }
  }
  return new ResolvedConfig({
    noteMaxBytes: positiveInteger('noteMaxBytes', config.noteMaxBytes, DEFAULT_NOTE_MAX_BYTES),
    handoffMaxBytes: positiveInteger('handoffMaxBytes', config.handoffMaxBytes, DEFAULT_HANDOFF_MAX_BYTES),
    recordedMaxBytes: positiveInteger('recordedMaxBytes', config.recordedMaxBytes, DEFAULT_RECORDED_MAX_BYTES),
    fileListMax: positiveInteger('fileListMax', config.fileListMax, DEFAULT_FILE_LIST_MAX),
    commandListMax: positiveInteger('commandListMax', config.commandListMax, DEFAULT_COMMAND_LIST_MAX),
    pinnedLineMaxChars: positiveInteger('pinnedLineMaxChars', config.pinnedLineMaxChars, DEFAULT_PINNED_LINE_MAX_CHARS),
    warningTokens: positiveInteger('warningTokens', config.warningTokens, DEFAULT_WARNING_TOKENS),
    warnTokens: positiveInteger('warnTokens', config.warnTokens, DEFAULT_WARN_TOKENS),
    fallbackTokens: positiveInteger('fallbackTokens', config.fallbackTokens, DEFAULT_FALLBACK_TOKENS),
    minEvictTokens: positiveInteger('minEvictTokens', config.minEvictTokens, DEFAULT_MIN_EVICT_TOKENS),
    budgetRecheckMs: positiveInteger('budgetRecheckMs', config.budgetRecheckMs, DEFAULT_BUDGET_RECHECK_MS),
    historyReadMaxChars: positiveInteger('historyReadMaxChars', config.historyReadMaxChars, DEFAULT_HISTORY_READ_MAX_CHARS),
    historySearchLimit: positiveInteger('historySearchLimit', config.historySearchLimit, DEFAULT_HISTORY_SEARCH_LIMIT),
    historySnippetChars: positiveInteger('historySnippetChars', config.historySnippetChars, DEFAULT_HISTORY_SNIPPET_CHARS),
    derivedAppendix: booleanValue('derivedAppendix', config.derivedAppendix),
    notices: booleanValue('notices', config.notices),
    noteTool: booleanValue('noteTool', config.noteTool),
    sensingTool: booleanValue('sensingTool', config.sensingTool),
    historyTool: booleanValue('historyTool', config.historyTool),
    newContextTool: booleanValue('newContextTool', config.newContextTool),
    guidance: booleanValue('guidance', config.guidance),
  })
}

/**
 * Read one optional positive integer, defaulting when absent.
 * @param {string} name - config key, used in the diagnostic.
 * @param {unknown} value - configured value or undefined.
 * @param {number} fallback - default used when absent.
 * @returns {number} the validated value.
 * @throws {Error} when present and not a positive integer.
 */
function positiveInteger(name, value, fallback) {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new Error(`dsh-compaction-sticky-window: ${name} must be a positive integer`)
  }
  return value
}

/**
 * Read one optional boolean, defaulting to enabled.
 * @param {string} name - config key, used in the diagnostic.
 * @param {unknown} value - configured value or undefined.
 * @returns {boolean} the validated value.
 * @throws {Error} when present and not a boolean.
 */
function booleanValue(name, value) {
  if (value === undefined) return true
  if (typeof value !== 'boolean') {
    throw new Error(`dsh-compaction-sticky-window: ${name} must be a boolean`)
  }
  return value
}
