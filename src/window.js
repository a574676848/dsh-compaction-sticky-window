/**
 * Window boundaries for a rollover that keeps almost nothing verbatim.
 *
 * A sliding window that retains a large share of the conversation is still a
 * summarizer with extra steps: the model keeps reading old messages instead of
 * the note. The target shape is the reference one — after a rollover the fresh
 * window holds the stable prefix, the note, and the work in flight, and nothing
 * else. "In flight" means the current turn, because evicting a turn that is
 * still appending tool results would strand its own messages.
 *
 * @module dsh-compaction-sticky-window/window
 */

import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import { PIN_TOOL_NAME, extractPins, textOf } from './note.js'

/**
 * Whether surface node 0 is the system prompt, which a rollover always keeps.
 * @param {object} session - the session to inspect.
 * @param {readonly number[]} nodes - current surface seqs.
 * @returns {boolean} whether node 0 must be excluded from the range.
 */
function hasSystemHead(session, nodes) {
  if (nodes.length === 0) return false
  const head = session.eventAt(nodes[0])
  return head !== undefined && head.type === 'system/message'
}

/**
 * Sequence of the most recent turn boundary in the log.
 * @param {object} session - the session to inspect.
 * @returns {number} the last `turn/start` seq, or -1 without one.
 */
function lastTurnStartSeq(session) {
  let seq = -1
  for (const event of session.snapshotEvents()) {
    if (event.type === 'turn/start') seq = event.seq
  }
  return seq
}

/**
 * Sequence of the most recent step boundary in the log.
 *
 * A turn can outlive every node before it: a model that keeps taking steps in
 * one turn leaves a surface holding nothing older than that turn, and a turn
 * boundary then names no cut. The step is the next boundary up, and the pairing
 * walk below still refuses a cut that would strand a tool call.
 * @param {object} session - the session to inspect.
 * @returns {number} the last `step/start` seq, or -1 without one.
 */
function lastStepStartSeq(session) {
  let seq = -1
  for (const event of session.snapshotEvents()) {
    if (event.type === 'step/start') seq = event.seq
  }
  return seq
}

/**
 * Choose the span a rollover evicts.
 *
 * Everything from the first non-system node up to the current turn goes; the
 * current turn stays so its tool results still have a surface to land on. The
 * end edge walks back until it no longer splits an assistant tool call from its
 * result, which is the same balance rule the transaction enforces.
 * @param {object} session - the session whose surface is measured.
 * @returns {{ start: number, end: number, evicted: number } | null} the inclusive positional range, or null when nothing is evictable.
 */
export function selectRolloverRange(session) {
  const nodes = [...session.surface.nodes]
  if (nodes.length === 0) return null
  const firstIdx = hasSystemHead(session, nodes) ? 1 : 0

  const turnStart = lastTurnStartSeq(session)
  let keepFrom = nodes.length
  if (turnStart !== -1) {
    // Scan positions, not seqs: a previous rollover inserts the note at an old
    // position with a newer seq, so the surface is not seq-monotonic. Everything
    // after the last node that predates this turn is the turn in flight.
    keepFrom = 0
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      if (nodes[index] < turnStart) {
        keepFrom = index + 1
        break
      }
    }
    // A turn that outlived the history it started with leaves no turn boundary
    // to cut at — every surface node is in the turn in flight. Keep only the
    // step in flight instead, so a long turn can still roll over.
    if (keepFrom <= firstIdx) {
      keepFrom = nodes.length
      const stepStart = lastStepStartSeq(session)
      if (stepStart !== -1) {
        for (let index = nodes.length - 1; index >= 0; index -= 1) {
          if (nodes[index] < stepStart) {
            keepFrom = index + 1
            break
          }
        }
      }
    }
  }

  // Never evict the turn in flight, and never split a tool pair at the cut.
  for (let index = keepFrom; index > firstIdx; index -= 1) {
    if (toolPairingBalancedAfter(session, nodes[index - 1])) {
      keepFrom = index
      break
    }
    if (index - 1 === firstIdx) return null
  }
  if (keepFrom <= firstIdx) return null
  if (!toolPairingBalancedBefore(session, nodes[firstIdx])) return null

  return {
    start: nodes[firstIdx],
    end: nodes[keepFrom - 1],
    evicted: keepFrom - firstIdx,
  }
}

/**
 * Whether the model has pinned state since the current window began.
 *
 * The write-ahead gate the reference implementation enforces: a rollover the
 * model asked for must follow a note, because the note is the only thing the
 * fresh window inherits. A pin that failed validation never reaches the note,
 * so it must not satisfy the gate either — only a successful result carrying
 * pins counts.
 * @param {object} session - the session to inspect.
 * @returns {{ saved: boolean, savedInWindow: number }} whether the current window has a note, and which window holds the last one.
 */
export function noteSavedThisWindow(session) {
  const events = session.snapshotEvents()
  /** @type {Map<string, string>} */
  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name)
  }
  let windowOrdinal = 0
  let savedInWindow = -1
  for (const event of events) {
    if (event.type === 'compaction/summary') {
      windowOrdinal += 1
      continue
    }
    if (event.type !== 'tool/result') continue
    if (calls.get(event.data.message?.source?.callId) !== PIN_TOOL_NAME) continue
    if (event.data.error !== undefined || event.data.message?.isError === true) continue
    if (extractPins(textOf(event.data.message)) === null) continue
    savedInWindow = windowOrdinal
  }
  return { saved: savedInWindow === windowOrdinal, savedInWindow }
}
