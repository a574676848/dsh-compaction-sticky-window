/**
 * How much budget one step of this conversation costs.
 *
 * A token count alone gives the model nothing to decide with: "60000 tokens
 * left" answers no question until it is divided by what the session already
 * spends per step. The estimate comes from this session's own steps rather
 * than a constant, because a session editing large files and one answering
 * short questions differ by an order of magnitude.
 *
 * The median is used rather than the mean: one enormous tool result would
 * otherwise make every later estimate optimistic exactly when the budget
 * matters most.
 *
 * @module dsh-compaction-sticky-window/pacing
 */

/** Steps averaged into one pace estimate. */
const PACE_WINDOW_STEPS = 3
/** Fewest steps an estimate needs before it is worth reporting. */
const MIN_PACE_SAMPLES = 1

/**
 * Estimate the tokens one step costs in this session.
 *
 * Only completed steps count. The step in flight has partially landed its
 * messages, so including it would read as a cheap step every time it is
 * sampled early.
 * @param {readonly { seq: number, tokens: number }[]} nodes - priced surface nodes.
 * @param {readonly number[]} stepStarts - `step/start` seqs in log order.
 * @param {number} [steps] - how many recent steps to average.
 * @returns {number | undefined} median tokens per step, or undefined without enough history.
 */
export function tokensPerStep(nodes, stepStarts, steps = PACE_WINDOW_STEPS) {
  if (stepStarts.length < MIN_PACE_SAMPLES + 1) return undefined
  const boundaries = stepStarts.slice(-(steps + 1))
  /** @type {number[]} */
  const samples = []
  for (let index = 1; index < boundaries.length; index += 1) {
    const from = boundaries[index - 1]
    const to = boundaries[index]
    let total = 0
    for (const node of nodes) {
      if (node.seq >= from && node.seq < to) total += node.tokens
    }
    if (total > 0) samples.push(total)
  }
  if (samples.length < MIN_PACE_SAMPLES) return undefined
  samples.sort((left, right) => left - right)
  return samples[Math.floor(samples.length / 2)]
}

/**
 * Convert a token remainder into whole steps at the measured pace.
 * @param {number} remainingTokens - tokens left before the rollover line.
 * @param {number | undefined} pace - median tokens per step.
 * @returns {number | undefined} completed steps the budget still covers.
 */
export function stepsRemaining(remainingTokens, pace) {
  if (pace === undefined || pace <= 0 || remainingTokens <= 0) return undefined
  return Math.floor(remainingTokens / pace)
}
