/**
 * Deterministic construction of the carried sticky note.
 *
 * The note is the only thing a fresh window inherits, and it is the model's own
 * handoff: the pinned list it wrote with `sticky_note`. That is the reference
 * shape — a writer that decides what matters, not a summarizer that guesses.
 *
 * Two things here are derived rather than written. The factual appendix records
 * what the conversation demonstrably did — files touched, commands run, tool
 * results that failed — because a model can forget a path but the log cannot.
 * And the window/eviction counts come from the note itself. Everything else is
 * the model's words, carried unchanged.
 *
 * @module dsh-compaction-sticky-window/note
 */

/** Opening tag of the note carried inside the compaction checkpoint. */
const NOTE_OPEN_TAG = '<sticky-note'
/** Opening tag as it appears with its first attribute, used to find a prior note. */
const NOTE_OPEN_PREFIX = `${NOTE_OPEN_TAG} version="`
/** Number of the note inside the checkpoint, used to continue the count. */
const NOTE_WINDOW_ATTRIBUTE = /window="(\d+)"/u
/** Opening tag of the block a pin call renders into the conversation. */
export const PINS_OPEN = '<sticky-note-pins>'
/** Closing tag of the block a pin call renders into the conversation. */
export const PINS_CLOSE = '</sticky-note-pins>'
/** Tool whose result is the only place a pin block may come from. */
export const PIN_TOOL_NAME = 'sticky_note'
/** Heading carrying the model's own handoff. */
export const HANDOFF_HEADING = '## Handoff'
/** Heading carrying facts derived from the evicted messages. */
export const FACTS_HEADING = '## Recorded facts'
/** Text shown when a section has nothing to report. */
const NONE = '- (none)'
/** Shown when an automatic rollover ran without a note behind it. */
const NO_NOTE = '- (no note was written before this rollover; the facts below are what the conversation recorded)'

/**
 * Collect every `tool-call` block into an id-keyed index.
 *
 * A tool result carries only the call id, so the call must be recovered from
 * the assistant message that requested it to learn which file or command the
 * result belongs to.
 * @param {readonly object[]} messages - evicted messages in surface order.
 * @returns {Map<string, { name: string, arguments: string }>} calls by id.
 */
function indexToolCalls(messages) {
  const calls = new Map()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content ?? []) {
      if (block.type !== 'tool-call') continue
      calls.set(block.id, { name: block.name, arguments: block.arguments })
    }
  }
  return calls
}

/**
 * Concatenate the visible text of one message.
 * @param {object} message - any conversation message.
 * @returns {string} its text blocks joined by newlines.
 */
export function textOf(message) {
  /** @type {string[]} */
  const parts = []
  for (const block of message.content ?? []) {
    if (block.type === 'text' && block.text.length > 0) parts.push(block.text)
  }
  return parts.join('\n')
}

/**
 * Parse one tool-call argument payload.
 * @param {unknown} raw - the JSON string the model produced.
 * @returns {Record<string, unknown> | null} the parsed object, or null.
 */
function parseArguments(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    // A malformed payload carries no recoverable detail; the call's name
    // still reaches the note through the tool-result branch.
    return null
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return parsed
}

/** Argument keys that name a filesystem path the call operated on. */
const PATH_KEYS = /^(?:file_path|filePath|path|paths|target|notebook_path)$/u
/** Argument keys that name a command the call executed. */
const COMMAND_KEYS = /^(?:command|cmd|script)$/u
/** Deepest argument nesting the walk inspects. */
const ARGUMENT_WALK_DEPTH = 3

/**
 * Walk an argument object for path and command values.
 * @param {Record<string, unknown>} value - parsed arguments.
 * @param {number} depth - remaining traversal depth.
 * @param {{ paths: string[], commands: string[] }} out - accumulators.
 */
function walkArguments(value, depth, out) {
  if (depth <= 0) return
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') {
      if (PATH_KEYS.test(key) && entry.length > 0) out.paths.push(entry)
      else if (COMMAND_KEYS.test(key) && entry.length > 0) out.commands.push(entry)
      continue
    }
    if (Array.isArray(entry)) {
      for (const item of entry) {
        if (typeof item === 'string' && PATH_KEYS.test(key) && item.length > 0) out.paths.push(item)
      }
      continue
    }
    if (entry !== null && typeof entry === 'object') walkArguments(entry, depth - 1, out)
  }
}

/**
 * Collapse whitespace and clip one line to a character budget.
 * @param {string} text - raw text, possibly multi-line.
 * @param {number} maxChars - maximum retained characters.
 * @returns {string} a single trimmed line, marked when clipped.
 */
function oneLine(text, maxChars) {
  const collapsed = text.replace(/\s+/gu, ' ').trim()
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, maxChars - 1)}…`
}

/**
 * Read the newest pinned-fact block from one text, if it holds one.
 * @param {string} text - message text that may contain a pin block.
 * @returns {string[] | null} pinned lines, or null without a block.
 */
export function extractPins(text) {
  const start = text.lastIndexOf(PINS_OPEN)
  if (start === -1) return null
  const end = text.indexOf(PINS_CLOSE, start)
  if (end === -1) return null
  return text.slice(start + PINS_OPEN.length, end)
    .split('\n')
    .map(line => line.replace(/^[-*]\s*/u, '').trim())
    .filter(line => line.length > 0)
}

/**
 * Read the newest pinned-fact block the pin tool produced.
 *
 * Provenance matters: the markers are ordinary text, so a file the agent read
 * could contain them. Only a result answering a `sticky_note` call counts.
 * @param {readonly object[]} messages - evicted messages in surface order.
 * @param {ReadonlyMap<string, { name: string }>} calls - tool calls by id.
 * @returns {string[]} pinned lines, or an empty list without a pin call.
 */
function readPinnedBlocks(messages, calls) {
  /** @type {string[]} */
  let latest = []
  for (const message of messages) {
    if (message.role !== 'tool') continue
    if (calls.get(message.source?.callId)?.name !== PIN_TOOL_NAME) continue
    const found = extractPins(textOf(message))
    if (found !== null) latest = found
  }
  return latest
}

/**
 * Recover the previous note's handoff section and continuation number.
 * @param {readonly object[]} messages - evicted messages in surface order.
 * @returns {{ window: number, handoff: string[] }} prior note state.
 */
function readPreviousNote(messages) {
  let window = 0
  /** @type {string[]} */
  let handoff = []
  for (const message of messages) {
    const text = textOf(message)
    const start = text.lastIndexOf(NOTE_OPEN_PREFIX)
    if (start === -1) continue
    const match = NOTE_WINDOW_ATTRIBUTE.exec(text.slice(start, start + 120))
    if (match !== null) window = Math.max(window, Number(match[1]))
    handoff = sectionBody(text, HANDOFF_HEADING) ?? sectionBody(text, '## Pinned state') ?? handoff
  }
  return { window, handoff }
}

/**
 * Extract one heading's bullets from a rendered note.
 * @param {string} text - text containing a previously rendered note.
 * @param {string} heading - exact heading line to read.
 * @returns {string[] | null} the bullets, or null when the section is absent.
 */
function sectionBody(text, heading) {
  const start = text.lastIndexOf(heading)
  if (start === -1) return null
  const rest = text.slice(start + heading.length)
  const end = rest.search(/\n## /u)
  const body = end === -1 ? rest : rest.slice(0, end)
  const lines = body
    .split('\n')
    .map(line => line.replace(/^[-*]\s*/u, '').trim())
    .filter(line => line.length > 0 && line !== '(none)')
  return lines.length === 0 ? null : lines
}

/**
 * Gather the model's handoff and the facts the conversation recorded.
 * @param {readonly object[]} messages - evicted messages in surface order.
 * @param {import('./config.js').ResolvedConfig} config - resolved policy.
 * @returns {object} collected facts before rendering.
 */
function collectFacts(messages, config) {
  const calls = indexToolCalls(messages)
  /** @type {{ files: Map<string, Set<string>>, commands: string[], openIssues: string[] }} */
  const facts = { files: new Map(), commands: [], openIssues: [] }
  const previous = readPreviousNote(messages)
  const pins = readPinnedBlocks(messages, calls)

  for (const message of messages) {
    if (message.role !== 'tool') continue
    const call = calls.get(message.source?.callId)
    if (call !== undefined) {
      const args = parseArguments(call.arguments)
      if (args !== null) {
        const found = { paths: [], commands: [] }
        walkArguments(args, ARGUMENT_WALK_DEPTH, found)
        for (const path of found.paths) {
          const tools = facts.files.get(path) ?? new Set()
          tools.add(call.name)
          facts.files.set(path, tools)
        }
        for (const command of found.commands) {
          if (!facts.commands.includes(command)) facts.commands.push(command)
        }
      }
    }
    if (message.isError === true) {
      const text = oneLine(textOf(message), config.pinnedLineMaxChars)
      facts.openIssues.push(`[${call?.name ?? 'tool'}] ${text.length === 0 ? '(no message)' : text}`)
    }
  }

  return {
    ...facts,
    handoff: pins.length > 0 ? pins : previous.handoff,
    window: previous.window + 1,
  }
}

/**
 * Render one bullet list, clipped to a byte budget.
 * @param {readonly string[]} lines - bullet bodies without the marker.
 * @param {number} maxBytes - UTF-8 budget for the whole section body.
 * @returns {string} the rendered section body.
 */
function renderBullets(lines, maxBytes) {
  if (lines.length === 0 || maxBytes <= 0) return NONE
  const rendered = []
  let used = 0
  for (const line of lines) {
    const bullet = `- ${line}`
    const size = Buffer.byteLength(bullet, 'utf8') + 1
    if (used + size > maxBytes) {
      const marker = '- … further lines omitted'
      if (maxBytes - used >= Buffer.byteLength(marker, 'utf8') + 1) rendered.push(marker)
      break
    }
    rendered.push(bullet)
    used += size
  }
  return rendered.length === 0 ? NONE : rendered.join('\n')
}

/**
 * Assemble the note text.
 *
 * The handoff claims its budget first because it is the only model-authored
 * content the fresh window gets; the factual appendix takes what remains.
 * Framing is never part of the allocatable budget, so the closing tag cannot be
 * lost.
 * @param {object} facts - output of {@link collectFacts}.
 * @param {import('./config.js').ResolvedConfig} config - resolved policy.
 * @returns {string} the complete note text for the checkpoint message.
 */
function renderNote(facts, config) {
  const files = [...facts.files.entries()]
    .slice(0, config.fileListMax)
    .map(([path, tools]) => `${path} (${[...tools].join(', ')})`)
  const commands = facts.commands.slice(0, config.commandListMax)
  const recorded = [...files, ...commands.map(command => `ran: ${command}`), ...facts.openIssues]

  const lead = 'Sticky window note. The conversation before the current turn was evicted to reclaim context '
    + 'and is now only reachable through `history_query`. This note is what a fresh window inherits: continue '
    + 'from it directly, build on it, and do not acknowledge it.'
  const tail = 'Call `sticky_note` with action `read` to see this list again, or `update` to replace it. '
    + 'Call `history_query` to list archived windows or read one evicted message by id.'
  const header = `${NOTE_OPEN_TAG} version="1" window="${facts.window}" evicted-messages="${facts.evicted}">`
  const close = '</sticky-note>'
  const headings = config.derivedAppendix ? [HANDOFF_HEADING, FACTS_HEADING] : [HANDOFF_HEADING]

  let available = Math.max(0, config.noteMaxBytes - Buffer.byteLength(
    [lead, tail, header, close, ...headings].join('\n\n'), 'utf8',
  ))

  const handoff = facts.handoff.length === 0 ? NO_NOTE : null
  const handoffBody = handoff ?? renderBullets(facts.handoff, Math.min(config.handoffMaxBytes, available))
  available -= Buffer.byteLength(handoffBody, 'utf8') + 2
  const sections = [`${HANDOFF_HEADING}\n${handoffBody}`]
  if (config.derivedAppendix) {
    const body = renderBullets(recorded, Math.min(config.recordedMaxBytes, available))
    sections.push(`${FACTS_HEADING}\n${body}`)
  }

  return `${lead}\n\n${header}\n${sections.join('\n\n')}\n${close}\n\n${tail}`
}

/**
 * Build the note that replaces one evicted span.
 *
 * The handoff is read from the whole session, not from the evicted messages:
 * a model that writes its note and then rolls over in the same turn would
 * otherwise lose it, because that turn is exactly what a rollover keeps. The
 * evicted span still supplies the note when the caller has nothing newer.
 * @param {readonly object[]} messages - the evicted messages, in surface order.
 * @param {import('./config.js').ResolvedConfig} config - resolved policy.
 * @param {{ handoff?: readonly string[] }} [overrides] - the newest handoff known outside the span.
 * @returns {{ text: string, window: number, evicted: number }} the rendered note and its facts.
 */
export function buildStickyNote(messages, config, overrides = {}) {
  const evicted = messages.filter(message => message.role !== 'system').length
  const facts = collectFacts(messages, config)
  const handoff = overrides.handoff !== undefined && overrides.handoff.length > 0
    ? overrides.handoff
    : facts.handoff
  return { text: renderNote({ ...facts, handoff, evicted }, config), window: facts.window, evicted }
}
