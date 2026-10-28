/**
 * The standing window protocol this backend adds to the system prompt.
 *
 * A sliding window is only as good as the model's cooperation with it: a note
 * carries what was pinned, and nothing pins state unless the model knows the
 * note exists and what it is for. The reference implementations make the same
 * move — Axon keeps a `<memory_window_protocol>` block in its stable prefix —
 * so this text is a prompt contract, not documentation.
 *
 * It states four things the tool descriptions cannot: that the machinery is
 * private, when to check the budget, what a note must contain to be worth
 * carrying, and how to recover a detail the note dropped.
 *
 * @module dsh-compaction-sticky-window/guidance
 */

/** Section name registered on `ctx.systemPrompt`. */
export const GUIDANCE_SECTION_NAME = 'sticky-window-protocol'

/**
 * Order this section takes among all prompt sections.
 *
 * External contributors may use any finite order; a value below the
 * environment-bearing sections keeps this protocol with the other behavioral
 * instructions rather than after them.
 */
export const GUIDANCE_SECTION_ORDER = 9000

/**
 * The protocol text.
 *
 * Written for the model, so it names the tools it can actually call and avoids
 * harness-internal vocabulary the model cannot act on.
 */
export const GUIDANCE_TEXT = `<sticky-window-protocol>
Private bookkeeping. The note, the archive, and the moment a window ends are internal context-continuation machinery. Never mention them, their ids, or a context reset to the user, and never let the conversation show the seam: the person sees one continuous session.

What a window is. This session runs in windows. When a window ends, every message before the current turn leaves the conversation permanently. The next window starts with the system prompt and your note, and nothing else. Anything you did not write into the note does not exist there — it survives only in the archive, reachable one lookup at a time.

Sensing. Call \`context_status\` before a large step and whenever you are unsure how much room is left. It reports the tokens used, the rollover line, the tokens remaining, and whether the figure is provider-reported or estimated.

Writing the note. Maintain it with \`sticky_note\` action \`update\` as work progresses, not at the last moment. Each call replaces the whole list, so send the complete set. Write what the next window cannot reconstruct from code and files: the goal and what finishing means, decisions and the reason behind them, constraints that are not obvious, approaches already rejected and why, open questions, and the exact next action. Keep it terse — imperative lines, not narrative. Call action \`read\` when you need to see what a fresh window will actually inherit.

Rolling over. Call \`new_context\` when the note is current and more room is needed. Without a saved note the call is refused, because a window opened with nothing written would lose everything. When the note is saved the rollover happens immediately: the conversation before the current turn is evicted and becomes archive.

After a rollover. Read the note before acting — it is the only summary of what came before. Continue from its next action without restating it. When the note lacks a detail that matters, recover exactly that detail instead of guessing: \`history_query\` action \`windows\` lists what was archived, \`search\` finds a case-sensitive literal and returns item ids, \`read\` returns one item by id. One targeted read beats a broad listing, and the current window is never in the archive.
</sticky-window-protocol>`
