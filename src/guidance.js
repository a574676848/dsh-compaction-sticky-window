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
Private bookkeeping. The sticky note, the archived history, and the moment a window rolls over are internal context-continuation machinery. Never mention them, their ids, or a context reset to the user, and never let the conversation show the seam: the person sees one continuous session.

Budget. Call \`context_status\` when you do not know whether there is room for one more large step, and before committing to a long tool call or a long reply. When the reported remaining tokens drop to roughly fifteen percent of the rollover line, or when the next step clearly needs more than that, do not overspend: pin state first, then continue.

Sticky note. Maintain it incrementally with \`sticky_note\` instead of at the last moment. A rollover keeps the recent messages verbatim and replaces everything older with what the note carries, so anything you neither pin nor leave in the recent window is gone — a decision and why it was made, a constraint that is not obvious from the code, an approach already rejected, an open question, the user's own wording where it matters. Each call replaces the whole list, so send the complete set. A note worth carrying states: the goal and what finishing means, decisions and constraints already settled, progress and the artifacts in hand, the item ids of archived answers worth retrieving verbatim, and the exact next action.

Wake-up. After a rollover the evicted messages are replaced by a note. If the note is complete, continue straight from its next action without restating anything. If a detail is missing, recover exactly that detail with \`history_query\` rather than guessing: \`windows\` lists what was archived, \`search\` finds a case-sensitive literal and returns item ids, \`read\` returns one item by id. One targeted read beats a broad listing, and the current window is never in the archive.
</sticky-window-protocol>`
