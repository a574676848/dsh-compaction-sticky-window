# dsh-compaction-sticky-window

A DeepSeek Harness profile bundle that replaces the summarizing context compactor with a **carried sticky note plus a verbatim sliding window**.

The shipped backend (`@deepseek-ai/dsh-compaction-basic`) replaces an old span with a model-written summary: one extra model call per rollover. This backend keeps the same durable transaction but replaces the span with a deterministic note built from the evicted messages themselves, so a rollover costs no tokens and replays identically.

## Install

From a checkout of this repository:

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-compaction-sticky-window
```

Or through the Plugins page, which installs the bundle and enables it. The bundle patch disables the `compaction-basic` row and inserts this backend in its place, so no other composition change is needed.

## What a rollover does

1. The compaction transaction selects the span to evict from token pressure, keeping the configured share of the conversation verbatim as the sliding window and never splitting a tool-call/result pair.
2. `summarize()` — the single hook this backend overrides — builds the note from the evicted messages. No model is called.
3. The transaction writes the usual `compaction/start`, `compaction/summary`, replacement `user/message`, and `compaction/end` bracket, and enforces that the replacement is smaller than the span it replaces.

Because the transaction is untouched, `/compact`, automatic pressure, model-switch, and context-overflow recovery all keep working, and the session log stays reconstructable.

## The note

Sections are derived from the evicted messages, in this order:

| Section | Source |
|---|---|
| `## Objective` | The most recent user-authored messages, newest first. |
| `## Verified state` | File paths and commands recovered from tool-call arguments, with the tool names that touched them. |
| `## Open issues` | Tool results that reported an error. |
| `## Next action` | The last assistant text in the span. |
| `## Pinned state` | The model's own `sticky_note` list, carried forward verbatim. |

The note is a normal checkpoint message on the surface, so it is read back on the next rollover exactly like any other evicted content — there is no side storage, and a replayed session rebuilds the identical note.

### `sticky_note`

The one model-facing addition. Each call replaces the whole pinned list, and the tool's result is the pins' only durable home: the block it renders into the conversation is what the next rollover parses. Pins win over the previous note's section, so an explicit pin always outranks carried text.

## Configuration

Every key is optional. Unknown keys fail at load instead of being ignored.

| Key | Default | Meaning |
|---|---|---|
| `thresholdRatio` | `0.8` | Share of the message budget that triggers a rollover. |
| `retainRatio` | `0.35` | Share kept verbatim as the sliding window. |
| `retainTokens` | — | Absolute retained-window size; mutually exclusive with `retainRatio`. |
| `headroomTokens` | shipped default | Reserve subtracted from the context window before pressure is measured. |
| `maxTokens` | shipped default | Generation cap used when pricing the request. |
| `compactionRetries` | shipped default | Retries when one rollover does not fall below the threshold. |
| `maxOverflowRetries` | shipped default | Retries after a provider-confirmed context overflow. |
| `modelPolicies` | `[]` | Per-provider/model overrides of the fields above. |
| `auto` | `true` | Whether automatic pressure and overflow listeners are registered. |
| `noteMaxBytes` | `6144` | UTF-8 budget for the note. |
| `objectiveMaxBytes` | `1024` | Budget for the objective section. |
| `verifiedMaxBytes` | `2560` | Budget for the verified-state section. |
| `openIssueMaxBytes` | `1024` | Budget for the open-issues section. |
| `pinnedMaxBytes` | `2048` | Budget for the pinned section. |
| `objectiveMessages` | `3` | Trailing user messages considered for the objective. |
| `fileListMax` | `24` | Distinct file paths reported. |
| `commandListMax` | `12` | Distinct commands reported. |
| `pinnedLineMaxChars` | `400` | Per-line character cap for a pinned fact and for a recovered line. |
| `noteTool` | `true` | Whether `sticky_note` is registered. |

The note budget is additionally trimmed to half of the span it replaces, so a very small span cannot fail the transaction's shrink check.

## Why this shape

- **No side storage.** The note and the pins are ordinary surface content, so fork, resume, and replay need no extra persistence and no format version.
- **No new session events.** The mechanism rides the existing `compaction/*` vocabulary.
- **No dependence on internal APIs.** The backend extends the published `BasicCompactionEngine` and overrides the documented `summarize()` hook; everything else is the shipped transaction.

## Development

```sh
node --test test/note.test.mjs test/engine.integration.mjs
```

`test/engine.integration.mjs` drives one real rollover through the shipped compaction transaction with a hand-built Cordis Context, so it fails if the note ever stops landing where a summary used to.

`node_modules/.` holds a local junction to a DSH installation for module resolution in development and is not published.

## Known limitations

- The note records structure, not prose: it cannot paraphrase reasoning it never saw written down. Use `sticky_note` for anything a reader could not recover from paths, commands, errors, and the last request and reply.
- A single indivisible message larger than the window cannot be repaired by a window slide; the optional tool-result pruner still runs before selection.
- Removing the bundle restores the summarizing backend only for sessions started afterwards' compositions — the switch is a profile patch, not a session rewrite.
