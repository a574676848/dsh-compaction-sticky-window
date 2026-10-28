# dsh-compaction-sticky-window

A DeepSeek Harness profile bundle that replaces the summarizing context compactor with a **carried sticky note plus a verbatim sliding window**, and adds the tools a model needs to work with one.

The shipped backend (`@deepseek-ai/dsh-compaction-basic`) replaces an old span with a model-written summary: one extra model call per rollover. This backend keeps the same durable transaction but replaces the span with a deterministic note built from the evicted messages themselves, so a rollover costs no tokens and replays identically.

## Install

From a checkout of this repository:

```sh
dsh plugin --profile <profile> add /absolute/path/to/dsh-compaction-sticky-window
```

Or through the Plugins page, which installs the bundle and enables it. The bundle patch retires the summarizing backend on every plane the profile exposes, so nothing else needs composing.

## Where it mounts, and why that is two places

Compaction has two possible owners, and which one a profile uses decides what "installed" has to mean.

| Profile kind | Compaction owner | What the bundle does |
|---|---|---|
| CLI, headless, SDK | A host-plane row from the base bundle | Disables `compaction-basic` and inserts this backend in its place |
| Web, Desktop | Each agent preset, inside a group that isolates `compaction` | Ships its own preset with the compaction group pointed here, and selects it as the default for new sessions |

On a preset-backed profile a host-plane row cannot reach a session: the preset isolates `compaction`, so its own backend serves its own agents. Running only a host row there would leave the summarizing backend in charge. That is why the bundle ships `presets/sticky-window.patch.yml` — the shipped `standard` preset with one group changed — and overrides the preset registry's default to select it.

A person's own choice in Settings still wins over that default. If they switch back to another preset, that preset's backend takes over again, and this bundle's tools report budget for the window they can see rather than the one actually in use.

The preset's child list is a snapshot. `npm run sync-preset` regenerates it from a local installation after a DSH upgrade; the child list is otherwise frozen at the release this package targets.

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
| `## Pinned state` | The model's own pinned list, carried forward verbatim. |

The note is a normal checkpoint message on the surface, so it is read back on the next rollover exactly like any other evicted content — there is no side storage, and a replayed session rebuilds the identical note.

## The tools

Three tools close the loop the note alone cannot. All three are registered on the host plane, so a preset realm inherits them through the `tools` registry it does not isolate.

| Tool | Answers |
|---|---|
| `context_status` | How many tokens are left before the next rollover, the current window ordinal, and whether the number is provider usage or a local estimate. |
| `sticky_note` | `read` returns the pinned list; `update` replaces it. |
| `history_query` | `windows` lists archived windows, `search` finds a case-sensitive literal and returns item ids, `read` returns one item by id. |

`context_status` prices the same threshold the transaction triggers on: the routed model's context window, minus the request's own output reservation and the configured headroom, capped by `thresholdRatio`. A reported number that disagreed with the trigger would be worse than no number, so `src/budget.js` mirrors that arithmetic and is tested against it.

`sticky_note` persists by leaving its result in the conversation. The newest pin block in the log is authoritative, which means pins survive fork, resume, and replay without side storage or a session-format change.

`history_query` reads the archive the log already holds: each `compaction/summary` event records the seqs it replaced, and those events stay at their original seqs forever. Windows and items are named the way the reference implementations name them — `w<window>:<ordinal>`.

## The prompt protocol

A sliding window only works if the model cooperates with it. The bundle registers one `systemPrompt` section (order 9000) stating that the machinery is private, when to check the budget, what a note must contain to be worth carrying, and how to recover a detail the note dropped. It is written for the model, names only tools the model can call, and is registered with `interpolate: false` so its braces stay literal.

The reference implementations make the same move — Axon keeps a `<memory_window_protocol>` block in its stable prefix.

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
| `pinnedLineMaxChars` | `400` | Per-line character cap for a pinned fact. |
| `warningTokens` | `6144` | Remaining budget at which `context_status` advises pinning now. |
| `historyReadMaxChars` | `4000` | Characters returned by one archive read. |
| `historySearchLimit` | `5` | Hits returned by one archive search. |
| `historySnippetChars` | `400` | Context characters shown around a hit. |
| `noteTool` | `true` | Register `sticky_note`. |
| `sensingTool` | `true` | Register `context_status`. |
| `historyTool` | `true` | Register `history_query`. |
| `guidance` | `true` | Register the prompt protocol section. |

The note budget is additionally trimmed to half of the span it replaces, so a small span shrinks the note instead of failing the transaction's shrink check. A span too small to hold even the note's framing still fails loudly, exactly as the shipped backend does with a summary that cannot fit.

## Why this shape

- **No side storage.** The note, the pins, and the archive index are ordinary surface content or existing log events, so fork, resume, and replay need no extra persistence and no format version.
- **No new session events.** The mechanism rides the existing `compaction/*` vocabulary.
- **No dependence on internal APIs.** The backend extends the published `BasicCompactionEngine` and overrides the documented `summarize()` hook; everything else is the shipped transaction.

## Development

```sh
node --test test/note.test.mjs test/engine.integration.mjs
node scripts/sync-preset.mjs
```

`test/engine.integration.mjs` drives real rollovers through the shipped compaction transaction with a hand-built Cordis Context, so it fails if the note ever stops landing where a summary used to, or if the archive stops answering.

`node_modules/.` holds a local junction to a DSH installation for module resolution in development and is not published.

## Known limitations

- The note records structure, not prose: it cannot paraphrase reasoning it never saw written down. Use `sticky_note` for anything a reader could not recover from paths, commands, errors, and the last request and reply.
- A single indivisible message larger than the window cannot be repaired by a window slide; the optional tool-result pruner still runs before selection.
- The shipped preset is a snapshot of `standard` at the targeted DSH release. A DSH upgrade can change that preset without this package noticing; run `sync-preset` and publish a new version.
- Switching a session back to a preset that mounts the summarizing backend re-enables it for that session. Removing the bundle restores the shipped behavior everywhere.
