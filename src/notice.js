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
 * @param {number} remainingTokens - tokens left before the rollover line.
 * @returns {{ text: string, summary: string }} the notice.
 */
export function warningNotice(remainingTokens) {
  return {
    summary: `${remainingTokens} tokens left`,
    text: `About ${remainingTokens} tokens remain before this window ends. `
      + 'Update the handoff note now with `sticky_note` action `update`: the goal and what finishing '
      + 'means, decisions and their reasons, constraints, rejected approaches, open questions, and the '
      + 'exact next action. Write it while there is room — once the window ends, anything not in the note '
      + 'leaves the conversation.',
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
