/**
 * Configuration for the sticky-window compaction backend.
 *
 * Two disjoint groups share one config object: window lifecycle fields the
 * compaction transaction already understands, and note fields that decide what
 * the carried sticky note contains. Lifecycle fields are forwarded untouched so
 * this backend inherits the shipped pressure policy; note fields are resolved
 * here into byte budgets.
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

/**
 * Note fields this backend owns. Every one is a deployment choice: a person who
 * runs short tasks wants a smaller note than one who runs long migrations.
 */
export const NOTE_KEYS = [
  'noteMaxBytes',
  'objectiveMaxBytes',
  'verifiedMaxBytes',
  'openIssueMaxBytes',
  'pinnedMaxBytes',
  'objectiveMessages',
  'fileListMax',
  'commandListMax',
  'pinnedLineMaxChars',
  'noteTool',
]

/** Default carried-note budget in UTF-8 bytes. */
const DEFAULT_NOTE_MAX_BYTES = 6144
/** Default budget for the objective section. */
const DEFAULT_OBJECTIVE_MAX_BYTES = 1024
/** Default budget for the verified-state section, which also holds paths. */
const DEFAULT_VERIFIED_MAX_BYTES = 2560
/** Default budget for the open-issues section. */
const DEFAULT_OPEN_ISSUE_MAX_BYTES = 1024
/** Default budget for the pinned-state section. */
const DEFAULT_PINNED_MAX_BYTES = 2048
/** Default number of trailing user messages considered for the objective. */
const DEFAULT_OBJECTIVE_MESSAGES = 3
/** Default cap on distinct file paths reported. */
const DEFAULT_FILE_LIST_MAX = 24
/** Default cap on distinct commands reported. */
const DEFAULT_COMMAND_LIST_MAX = 12
/** Default per-line character cap for a pinned fact. */
const DEFAULT_PINNED_LINE_MAX_CHARS = 400

/** Resolved note policy; every value is a positive integer except {@link noteTool}. */
export class NoteConfig {
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
 * Unset keys stay unset so the shipped defaults keep applying; passing an
 * explicit `undefined` would not change behavior but would obscure where a
 * value came from.
 * @param {Record<string, unknown>} config - raw plugin config.
 * @returns {Record<string, unknown>} the keys the transaction owns.
 */
export function toLifecycleConfig(config) {
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const key of LIFECYCLE_KEYS) {
    if (config[key] !== undefined) out[key] = config[key]
  }
  return out
}

/**
 * Validate the complete plugin config and resolve note budgets.
 *
 * Unknown keys fail here instead of being dropped: a misspelled budget would
 * otherwise silently fall back to a default the deployer never chose.
 * @param {Record<string, unknown>} config - raw plugin config.
 * @returns {NoteConfig} the resolved note policy.
 * @throws {Error} when a key is unknown or a value is out of range.
 */
export function resolveNoteConfig(config) {
  for (const key of Object.keys(config)) {
    if (!LIFECYCLE_KEYS.includes(key) && !NOTE_KEYS.includes(key)) {
      throw new Error(`dsh-compaction-sticky-window: unknown config key "${key}"`)
    }
  }
  const noteTool = config.noteTool
  if (noteTool !== undefined && typeof noteTool !== 'boolean') {
    throw new Error('dsh-compaction-sticky-window: noteTool must be a boolean')
  }
  return new NoteConfig({
    noteMaxBytes: positiveInteger('noteMaxBytes', config.noteMaxBytes, DEFAULT_NOTE_MAX_BYTES),
    objectiveMaxBytes: positiveInteger('objectiveMaxBytes', config.objectiveMaxBytes, DEFAULT_OBJECTIVE_MAX_BYTES),
    verifiedMaxBytes: positiveInteger('verifiedMaxBytes', config.verifiedMaxBytes, DEFAULT_VERIFIED_MAX_BYTES),
    openIssueMaxBytes: positiveInteger('openIssueMaxBytes', config.openIssueMaxBytes, DEFAULT_OPEN_ISSUE_MAX_BYTES),
    pinnedMaxBytes: positiveInteger('pinnedMaxBytes', config.pinnedMaxBytes, DEFAULT_PINNED_MAX_BYTES),
    objectiveMessages: positiveInteger('objectiveMessages', config.objectiveMessages, DEFAULT_OBJECTIVE_MESSAGES),
    fileListMax: positiveInteger('fileListMax', config.fileListMax, DEFAULT_FILE_LIST_MAX),
    commandListMax: positiveInteger('commandListMax', config.commandListMax, DEFAULT_COMMAND_LIST_MAX),
    pinnedLineMaxChars: positiveInteger('pinnedLineMaxChars', config.pinnedLineMaxChars, DEFAULT_PINNED_LINE_MAX_CHARS),
    noteTool: noteTool ?? true,
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
