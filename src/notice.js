/**
 * Budget notices the session pushes into the model's context.
 *
 * A tool the model must remember to call is not a warning. The reference
 * implementation pushes a notice *before* the rollover line, then another when
 * the line is passed, so the model has two chances to write its note while
 * there is still room to write it. These are those notices.
 *
 * Each notice is model-facing text only: it names what to do next, never the
 * machinery behind it.
 *
 * @module dsh-compaction-sticky-window/notice
 */

/**
 * Source kind stamped on every notice this plugin injects.
 *
 * The session format admits extension source kinds (it validates only a
 * non-empty string), so a log written here stays readable after this plugin is
 * removed.
 */
export const NOTICE_SOURCE_KIND = 'sticky-window-notice'

/**
 * The notice shown while there is still room before the rollover line.
 *
 * It reports the remainder in steps as well as tokens, because the decision it
 * asks for — does the work unit in flight fit — cannot be answered from tokens
 * alone. Both the "keep going" and the "roll over now" branches are stated so
 * the model chooses rather than always wrapping up.
 * @param {number} remainingTokens - tokens left before the rollover line.
 * @param {number | undefined} remainingSteps - whole steps that budget still covers.
 * @returns {{ text: string, summary: string }} the notice.
 */
export function warningNotice(remainingTokens, remainingSteps) {
  const scale = remainingSteps === undefined
    ? ''
    : `, roughly ${remainingSteps} more ${remainingSteps === 1 ? 'step' : 'steps'} at the pace this `
      + 'session has been running'
  return {
    summary: `${remainingTokens} tokens left`,
    text: `About ${remainingTokens} tokens remain before this window ends${scale}. Decide with that `
      + 'number. If the work unit you are in fits, keep going and ignore this. If it does not, finish '
      + 'the step you are on, update the handoff note with `sticky_note` action `update`, and call '
      + '`new_context`. Do not roll over mid-operation: the tool result you are waiting on has to '
      + 'attach to a call that is still in the window.',
  }
}

/**
 * The notice shown once the rollover line has passed but the window still runs.
 * @param {number} remainingTokens - tokens left before the window is forced to end.
 * @returns {{ text: string, reason: string, summary: string }} the notice.
 */
export function exhaustedNotice(remainingTokens) {
  return {
    summary: 'window budget spent',
    text: 'This window has used its budget. It ends as soon as the handoff note is saved: call '
      + '`sticky_note` action `update` now, then call `new_context`. Do not start new work in this '
      + `window. About ${remainingTokens} tokens of slack remain before the window is closed anyway.`,
  }
}

/**
 * The notice shown while the window still has comfortable room.
 *
 * Nothing is running out here, which is exactly why it is offered: a decision,
 * a stated constraint, or a rejected approach is cheapest to pin the moment it
 * exists, and most expensive to reconstruct after an eviction that was not
 * about it. It names the three facts worth pinning instead of asking for a note
 * in general, and it asks for the cheap call only — never for a rollover.
 * @returns {{ text: string, summary: string }} the notice.
 */
export function midwayNotice() {
  return {
    summary: 'room to record decisions',
    text: 'You still have room, but this is the cheapest moment to record what you already know. If a '
      + 'decision and the reason behind it, a constraint the person stated, or an approach you ruled '
      + 'out currently lives only in this conversation, pin it now with `sticky_note` action `update`. '
      + 'That is one cheap call and it survives the rollover; left here, it does not. Keep working '
      + 'afterwards — this is not a reason to end the window.',
  }
}

/**
 * The notice shown when the note is already saved and the window has not ended.
 *
 * Asking for a note that is already written is the one instruction a model must
 * not receive twice: it spends a turn on work that changes nothing. The window
 * ends on its own at the next boundary, so this notice names that and asks for
 * nothing.
 * @returns {{ text: string, summary: string }} the notice.
 */
export function readyNotice() {
  return {
    summary: 'handoff note saved',
    text: 'The handoff note is saved, so this window ends at the next boundary on its own. Keep working, '
      + 'and update the note whenever something new has to survive — one cheap call. Do not resubmit '
      + 'the same note just to force the rollover; that is the expensive operation, not this one.',
  }
}

/**
 * The notice shown when the window is over its ceiling but cannot end yet.
 *
 * Two different situations land here — no note saved, or nothing large enough
 * to replace — and the model cannot tell them apart, so the notice names both
 * and gives an action for each.
 * @returns {{ text: string, summary: string }} the notice.
 */
export function blockedNotice() {
  return {
    summary: 'window cannot end yet',
    text: 'This window is past its budget but cannot end yet. If the handoff note is not saved, call '
      + '`sticky_note` action `update` now with the complete state — that is the only thing that '
      + 'survives. If the note is already saved, the history in this window is still too small to '
      + 'replace, so finish or split the current work instead of calling `new_context` again.',
  }
}
