# Sticky-window context

DeepSeek Harness normally reclaims context by summarizing: when a session grows past a pressure threshold, an older span is replaced by one model-written summary. That costs an extra model call at every rollover, and the summary is whatever the model decided to keep.

This plugin replaces that with a sliding window and a carried note.

## What changes

Once installed, the summarizing backend is switched off and every rollover — automatic pressure, context-overflow recovery, and `/compact` — instead:

1. **Keeps a verbatim window.** The most recent share of the conversation stays exactly as it was. Nothing is rewritten inside it.
2. **Evicts everything older into one note.** The note is built deterministically from the evicted messages: the objective, files touched, commands run, open errors, and the next action, plus anything the model pinned.
3. **Makes no model call.** A rollover costs no tokens and produces the same note from the same history, so a replayed session condenses identically.

The evicted messages are not deleted. They stay in the session log and remain available to session search and export; they simply stop being sent to the model.

## The pinned state

The note cannot infer decisions that were never written down. The plugin adds one model-facing tool, `sticky_note`, which pins short imperative lines — a decision, a constraint, an open problem — that must survive eviction. Pinned lines are carried forward verbatim on every rollover, and a later call replaces the whole list. The pinned section claims its budget before any derived section, and a list too large for it is refused with an instruction to consolidate rather than silently trimmed, so what you pin is what the next window actually carries.

You do not have to use it. Without any pinned facts the note still carries the objective, the changed files, the failing commands, and the next action, which is enough to continue most work.

## Sensing and recall

A note is a lossy index, so the model also gets two ways to look outward:

- **Budget sensing.** It can ask how many tokens remain before the next rollover, and whether that figure is provider-reported or locally estimated. That is what lets it pin state *before* a rollover instead of after.
- **Archive recall.** Evicted messages are not deleted. The model can list the archived windows, search them for an exact literal, and read one item by id, so a detail the note compressed away is still one targeted lookup away.

Together with the note these form a closed loop: sense the budget, pin what matters, roll over, and recall the rest on demand. A standing prompt section tells the model how to use that loop and that it must never surface it to you.

## Choosing the preset on Web or Desktop

On a CLI, headless, or SDK profile the plugin takes over as soon as it is installed. On Web and Desktop the compaction backend belongs to the agent preset rather than the profile, so the plugin ships its own preset and selects it as the default for new sessions. Your own preset choice in Settings always wins; pick any other preset and its backend takes over again.

## What you will see

Rollovers are silent. The conversation continues from the note plus the retained window, and nothing in the reply acknowledges the switch. If you want the rollover facts, the session log records each one as a `compaction/*` bracket with the replaced range.

## Configuration

The window is sized by the same policy fields the shipped backend uses, so an existing `modelPolicies` entry keeps working:

| Key | Default | Meaning |
|---|---|---|
| `thresholdRatio` | `0.8` | Share of the message budget that triggers a rollover. |
| `retainRatio` | `0.35` | Share kept verbatim as the sliding window. |
| `retainTokens` | — | Absolute retained-window size; mutually exclusive with `retainRatio`. |
| `headroomTokens` | shipped default | Reserve subtracted from the context window before pressure is measured. |
| `noteMaxBytes` | `6144` | UTF-8 budget for the note itself. |
| `noteTool` | `true` | Whether the `sticky_note` tool is registered. |

Section budgets (`objectiveMaxBytes`, `verifiedMaxBytes`, `openIssueMaxBytes`, `pinnedMaxBytes`) and list caps (`fileListMax`, `commandListMax`, `objectiveMessages`, `pinnedLineMaxChars`) are also settable; every unknown key fails at load rather than being ignored.

## Limits

- **The note is a summary of structure, not of prose.** It records what the history contains — paths, commands, errors, the last request and the last reply — not a paraphrase of the reasoning that produced it. Pin anything a reader could not recover from those facts.
- **One indivisible unit is out of reach.** A single oversized tool result or message that alone fills the window cannot be split by a window slide.
- **The shipped preset is a snapshot.** It mirrors the built-in `standard` preset at the release this plugin targets. A later DSH release can change that preset without this plugin noticing, so update the plugin alongside DSH.
- **Removing this plugin restores the summarizing backend**, since the switch is a composition patch, not a rewrite of the stored session.
