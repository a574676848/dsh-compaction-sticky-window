# Sticky-window context

DeepSeek Harness normally reclaims context by summarizing: when a session grows past a pressure threshold, an older span is replaced by one model-written summary. That costs an extra model call at every rollover, and the summary is whatever the model happened to keep.

This plugin replaces that with a handoff note the model writes itself, and a new window that keeps almost nothing else.

## What changes

Once installed:

1. **The model writes the note.** It decides what a fresh window must know — the goal, the decisions and their reasons, the constraints, the rejected approaches, the open questions, the next action — and saves it with one tool call.
2. **The window ends.** Either the model asks for it, or token pressure does. Every message before the current turn leaves the conversation.
3. **The next window is nearly empty.** It holds the system prompt, the note, and the turn in flight. Nothing else is carried.
4. **No model call is spent on the transition.** A rollover costs no tokens and produces the same note from the same history, so a replayed session condenses identically.

The evicted messages are not deleted. They stay in the session log and remain readable one item at a time through the recall tool.

## The handoff note

The note is mostly the model's own words, carried verbatim. A second, optional section records what the conversation demonstrably did — paths it touched, commands it ran, tool results that failed — because a model can forget a path but the log cannot.

If an automatic rollover happens before the model has written anything, the note says so plainly and carries only those recorded facts. It never invents a handoff.

The note claims its byte budget before anything else and is never truncated into an unreadable state; a note that would not fit is refused with an instruction to consolidate.

## Sensing and recall

- **Budget sensing.** The model can ask how many tokens remain before the window ends, and whether that figure is provider-reported or locally estimated. That is what lets it write the note *before* the window ends rather than after.
- **Archive recall.** The model can list the archived windows, search them for an exact literal, and read one item by id, so any detail the note left out is one targeted lookup away.

A standing prompt section tells the model how the whole loop works, and that it must never surface it to you.

## Adding tools, replacing the compactor

Installing adds four tools and replaces the compaction backend. It takes no tool away, and it does not change which agent preset your sessions use.

On a CLI, headless, or SDK profile the backend is a profile row: the plugin disables the summarizing one and puts itself in its place. On Web and Desktop the compaction backend belongs to the agent preset, so the plugin overrides the shipped `standard` preset in place — same id, same order, same plugin list — and swaps only its compaction group. Nothing needs selecting: enable the plugin, restart, and new sessions compact with the note.

Your existing tools are untouched: measured on a live profile, enabling went from 108 tools to 112, with nothing removed.

## What you will see

The transition is silent. The conversation continues from the note, and nothing in the reply acknowledges the switch. If you want the facts, the session log records each rollover as a `compaction/*` bracket with the replaced range.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `thresholdRatio` | `0.8` | Message-budget share that triggers an automatic rollover. |
| `retainTokens` | `0` | Verbatim tail kept after a rollover; `0` keeps only the turn in flight. |
| `noteMaxBytes` | `6144` | Budget for the whole note. |
| `handoffMaxBytes` | `4096` | Budget for the model's own handoff, claimed first. |
| `derivedAppendix` | `true` | Include the recorded-facts section. |

Section and tool switches (`noteTool`, `sensingTool`, `historyTool`, `newContextTool`, `guidance`) and search and read limits are also settable; every unknown key fails at load rather than being ignored.

## Limits

- **The note is only as good as what was written into it.** That is the point — the model decides — but it also means an under-written note loses detail. The recall tool exists for exactly that case.
- **One indivisible unit is out of reach.** A single oversized tool result or message that alone fills the window cannot be split by a rollover.
- **The shipped preset is a snapshot.** It mirrors the built-in `standard` preset at the release this plugin targets. A later DSH release can change that preset without this plugin noticing, so update the plugin alongside DSH.
- **Removing this plugin restores the summarizing backend**, since the switch is a composition patch, not a rewrite of the stored session.
