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

The note cannot infer decisions that were never written down. The plugin adds one model-facing tool, `sticky_note`, which pins short imperative lines — a decision, a constraint, an open problem — that must survive eviction. Pinned lines are carried forward verbatim on every rollover, and a later call replaces the whole list.

You do not have to use it. Without any pinned facts the note still carries the objective, the changed files, the failing commands, and the next action, which is enough to continue most work.

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
- **Removing this plugin restores the summarizing backend**, since the switch is a profile patch, not a rewrite of the stored session.
