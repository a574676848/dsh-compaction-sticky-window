/**
 * Remaining-context arithmetic for the sensing tool.
 *
 * The compaction transaction decides when to roll over from the routed model's
 * context capacity, its reserved completion tokens, and the configured
 * fractions. The sensing tool answers the same question the trigger answers, so
 * a model told how many tokens remain is looking at the number that will
 * actually stop it — including the cases where the trigger refuses to run.
 *
 * @module dsh-compaction-sticky-window/budget
 */

/** Request-pressure fraction used when the config leaves it unset, mirroring the backend. */
const DEFAULT_THRESHOLD_RATIO = 0.8
/** Retained-window fraction used when the config leaves it unset, mirroring the backend. */
const DEFAULT_RETAIN_RATIO = 0.16
/** Request headroom used when the config leaves it unset, mirroring the backend. */
const DEFAULT_HEADROOM_TOKENS = 65_536

/**
 * Resolve the exact target policy the transaction would use.
 * @param {{ thresholdRatio?: number, headroomTokens?: number, retainRatio?: number, retainTokens?: number, modelPolicies?: readonly object[] }} config - plugin config.
 * @param {{ provider: string, model: string }} target - the routed request target.
 * @returns {object} the merged policy fields.
 */
function targetPolicy(config, target) {
  const override = config.modelPolicies?.find(
    policy => policy.provider === target.provider && policy.model === target.model,
  )
  return {
    thresholdRatio: override?.thresholdRatio ?? config.thresholdRatio ?? DEFAULT_THRESHOLD_RATIO,
    headroomTokens: override?.headroomTokens ?? config.headroomTokens ?? DEFAULT_HEADROOM_TOKENS,
    retainRatio: override?.retainRatio ?? config.retainRatio ?? DEFAULT_RETAIN_RATIO,
    retainTokens: override?.retainTokens ?? config.retainTokens,
  }
}

/**
 * Resolve the rollover line and retained-window size for one routed target.
 *
 * Mirrors the backend's capacity policy exactly, including its two refusals: a
 * budget that leaves no room after the output reservation and the headroom, and
 * a retained window at or above the rollover line. Both make compaction throw
 * and never run, so reporting a token count in those states would be a lie.
 * @param {object} config - plugin config.
 * @param {{ provider: string, model: string }} target - the routed request target.
 * @param {number} contextWindow - the target's context capacity.
 * @param {number} reservedCompletionTokens - output tokens the request reserves.
 * @returns {{ thresholdTokens?: number, retainTokens?: number, problem?: string }} the budget or the reason it does not exist.
 */
export function resolveRolloverBudget(config, target, contextWindow, reservedCompletionTokens) {
  const key = `${target.provider}/${target.model}`
  if (!Number.isInteger(contextWindow) || contextWindow <= 0) {
    return { problem: `contextWindow (${contextWindow}) must be a positive integer` }
  }
  if (!Number.isInteger(reservedCompletionTokens) || reservedCompletionTokens < 0) {
    return { problem: `reservedCompletionTokens (${reservedCompletionTokens}) must be a non-negative integer` }
  }
  const policy = targetPolicy(config, target)
  const messageBudget = contextWindow - reservedCompletionTokens
  if (messageBudget <= 0) {
    return {
      problem: `${key} reserves ${reservedCompletionTokens} completion tokens of its `
        + `${contextWindow}-token context window, leaving no message budget; configure the adapter `
        + "model's contextWindow above the effective request maxTokens",
    }
  }
  const pressureBudget = messageBudget - policy.headroomTokens
  if (pressureBudget <= 0) {
    return {
      problem: `${key} reserves ${reservedCompletionTokens} completion and `
        + `${policy.headroomTokens} headroom tokens of a ${contextWindow}-token window, leaving no `
        + 'pressure budget; reduce the request maxTokens or headroomTokens, or raise contextWindow',
    }
  }
  const thresholdTokens = Math.floor(Math.min(contextWindow * policy.thresholdRatio, pressureBudget))
  const retainTokens = policy.retainTokens === undefined
    ? Math.floor(messageBudget * policy.retainRatio)
    : policy.retainTokens
  if (retainTokens >= thresholdTokens) {
    return {
      problem: `${key} retainTokens (${retainTokens}) must be less than threshold tokens `
        + `${thresholdTokens}; compaction would refuse to run`,
    }
  }
  return { thresholdTokens, retainTokens }
}

/**
 * The token count at which the window ends regardless of a saved note.
 *
 * The reference implementation postpones an unprepared rollover by a fixed
 * buffer and then stops offering slack, capping the ceiling at the model's real
 * capacity so the postponement can never push past it.
 * @param {{ thresholdTokens: number }} budget - resolved rollover line.
 * @param {number} fallbackTokens - slack allowed past the line.
 * @param {number} contextWindow - the target's context capacity.
 * @param {number} reservedCompletionTokens - output tokens the request reserves.
 * @returns {number} the token count at which the window must end.
 */
export function rolloverCeiling(budget, fallbackTokens, contextWindow, reservedCompletionTokens) {
  return Math.min(budget.thresholdTokens + fallbackTokens, contextWindow - reservedCompletionTokens)
}

/**
 * Describe how much room the session has left before its next rollover.
 * @param {object} options - measured facts.
 * @param {number} options.usedTokens - current request pressure from the token meter.
 * @param {boolean} options.providerMeasured - whether the meter anchored on provider usage rather than an estimate.
 * @param {number} options.contextWindow - resolved context capacity.
 * @param {number} options.reservedCompletionTokens - output tokens the request reserves.
 * @param {number} options.rolloverAtTokens - resolved rollover threshold.
 * @param {number} options.windowNumber - ordinal of the current window.
 * @param {number} options.warningTokens - remaining budget at which the note should be written.
 * @returns {object} the model-facing status.
 */
export function describeStatus(options) {
  const remainingTokens = options.rolloverAtTokens - options.usedTokens
  return {
    window: options.windowNumber,
    usedTokens: options.usedTokens,
    remainingTokens,
    rolloverAtTokens: options.rolloverAtTokens,
    contextWindow: options.contextWindow,
    reservedCompletionTokens: options.reservedCompletionTokens,
    source: options.providerMeasured ? 'provider-usage' : 'local-estimate',
    advice: adviceFor(remainingTokens, options.warningTokens),
  }
}

/**
 * Tell the caller what to do with the remaining budget.
 * @param {number} remainingTokens - tokens left before the next rollover.
 * @param {number} warningTokens - the configured warning distance.
 * @returns {string} one actionable sentence.
 */
function adviceFor(remainingTokens, warningTokens) {
  if (remainingTokens <= 0) {
    return 'The next step rolls over to a new window. Call sticky_note now with the state a fresh '
      + 'reader needs; the note and the retained messages are all that survives.'
  }
  if (remainingTokens <= warningTokens) {
    return 'A rollover is close. Call sticky_note with decisions, constraints, and open problems that '
      + 'this conversation alone records; otherwise they are lost at the next eviction.'
  }
  return 'There is room to continue. Pin durable facts as they are decided rather than at the end.'
}
