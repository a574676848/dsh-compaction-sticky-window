/**
 * Deterministic construction of the carried sticky note.
 *
 * The note is the only thing that survives a window slide, so it is built from
 * the evicted messages themselves rather than from a model call: the same
 * input always yields the same note, which keeps replay exact and costs no
 * tokens. Sections name what a resuming reader must know — the objective, what
 * was verified, what is still open, and what to do next — and the model's own
 * pinned facts ride along verbatim.
 *
 * @module dsh-compaction-sticky-window/note
 */

/** Opening tag of the note carried inside the compaction checkpoint. */
const NOTE_OPEN_PREFIX = '<sticky-note'
/** Number of the note inside the checkpoint, used to continue the count. */
const NOTE_WINDOW_ATTRIBUTE = /window="(\d+)"/u
/** Opening tag of the block a pin call renders into the conversation. */
export const PINS_OPEN = '<sticky-note-pins>'
/** Closing tag of the block a pin call renders into the conversation. */
export const PINS_CLOSE = '</sticky-note-pins>'

/** Text shown when a section has nothing to report. */
const NONE = '- (none)'

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
function textOf(message) {
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

/**
 * Walk an argument object for path and command values.
 *
 * The walk is bounded by depth so a deeply nested or self-referential payload
 * cannot stall the compaction. Only string leaves under recognized keys count.
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

/** Deepest argument nesting the walk inspects. */
const ARGUMENT_WALK_DEPTH = 3

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
 * Read the newest pinned-fact block anywhere in the evicted messages.
 *
 * A pin call's result is a normal tool message, so the latest block in surface
 * order is authoritative: a later pin call replaced the earlier set wholesale.
 * @param {readonly object[]} messages - evicted messages in surface order.
 * @returns {string[]} pinned lines, or an empty list without a pin call.
 */
function readPinnedBlocks(messages) {
  /** @type {string[]} */
  let latest = []
  for (const message of messages) {
    const text = textOf(message)
    const start = text.lastIndexOf(PINS_OPEN)
    if (start === -1) continue
    const end = text.indexOf(PINS_CLOSE, start)
    if (end === -1) continue
    latest = text.slice(start + PINS_OPEN.length, end)
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/u, '').trim())
      .filter(line => line.length > 0)
  }
  return latest
}

/**
 * Recover the previous note's pinned section and continuation number.
 *
 * The note itself is a user message on the surface, so it is read exactly like
 * any other evicted content rather than from side storage.
 * @param {readonly object[]} messages - evicted messages in surface order.
 * @returns {{ window: number, pinned: string[] }} prior note state.
 */
function readPreviousNote(messages) {
  let window = 0
  /** @type {string[]} */
  let pinned = []
  for (const message of messages) {
    const text = textOf(message)
    const start = text.lastIndexOf(NOTE_OPEN_PREFIX)
    if (start === -1) continue
    const match = NOTE_WINDOW_ATTRIBUTE.exec(text.slice(start, start + 120))
    if (match !== null) window = Math.max(window, Number(match[1]))
    pinned = pinnedSection(text) ?? pinned
  }
  return { window, pinned }
}

/**
 * Extract the pinned-state bullets from one rendered note.
 * @param {string} text - text containing a previously rendered note.
 * @returns {string[] | null} the bullets, or null when the section is absent.
 */
function pinnedSection(text) {
  const heading = '## Pinned state'
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
 * Gather every section's raw material from the evicted messages.
 * @param {readonly object[]} messages - evicted messages in surface order.
 * @param {import('./config.js').NoteConfig} config - resolved note policy.
 * @returns {object} collected facts before rendering.
 */
function collectFacts(messages, config) {
  const calls = indexToolCalls(messages)
  /** @type {{ objective: string[], files: Map<string, Set<string>>, commands: string[], openIssues: string[] }} */
  const facts = { objective: [], files: new Map(), commands: [], openIssues: [] }
  const pins = readPinnedBlocks(messages)
  const previous = readPreviousNote(messages)
  let nextAction = ''

  for (const message of messages) {
    switch (message.role) {
      case 'user': {
        if (message.source?.kind === 'user') {
          const text = oneLine(textOf(message), config.pinnedLineMaxChars)
          if (text.length > 0) facts.objective.push(text)
        }
        break
      }
      case 'assistant': {
        const text = oneLine(textOf(message), config.pinnedLineMaxChars)
        if (text.length > 0) nextAction = text
        break
      }
      case 'tool': {
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
        break
      }
      default:
        break
    }
  }

  facts.objective = facts.objective.slice(-config.objectiveMessages).reverse()
  return {
    ...facts,
    nextAction,
    pinned: pins.length > 0 ? pins : previous.pinned,
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
  if (lines.length === 0) return NONE
  const rendered = []
  let used = 0
  for (const line of lines) {
    const bullet = `- ${line}`
    const size = Buffer.byteLength(bullet, 'utf8') + 1
    if (used + size > maxBytes) {
      rendered.push('- … further lines omitted')
      break
    }
    rendered.push(bullet)
    used += size
  }
  return rendered.join('\n')
}

/**
 * Assemble the note text from collected facts.
 * @param {object} facts - output of {@link collectFacts}.
 * @param {import('./config.js').NoteConfig} config - resolved note policy.
 * @returns {string} the complete note text for the checkpoint message.
 */
function renderNote(facts, config) {
  const files = [...facts.files.entries()]
    .slice(0, config.fileListMax)
    .map(([path, tools]) => `${path} (${[...tools].join(', ')})`)
  const commands = facts.commands.slice(0, config.commandListMax)

  const sections = [
    ['## Objective', renderBullets(facts.objective, config.objectiveMaxBytes)],
    ['## Verified state', renderBullets([...files, ...commands.map(c => `ran: ${c}`)], config.verifiedMaxBytes)],
    ['## Open issues', renderBullets(facts.openIssues, config.openIssueMaxBytes)],
    ['## Next action', renderBullets(facts.nextAction.length === 0 ? [] : [facts.nextAction], config.objectiveMaxBytes)],
    ['## Pinned state', renderBullets(facts.pinned, config.pinnedMaxBytes)],
  ]

  const header = `${NOTE_OPEN_PREFIX} version="1" window="${facts.window}" evicted-messages="${facts.evicted}">`
  const body = sections.map(([heading, content]) => `${heading}\n${content}`).join('\n\n')
  const lead = 'Sticky window note. Everything before the retained messages was evicted to reclaim context; '
    + 'this note is the durable state carried forward. Treat it as established background, continue directly, and do not acknowledge it.'
  const tail = 'Pin decisions this note cannot infer with the `sticky_note` tool before the next eviction.'
  const text = `${lead}\n\n${header}\n${body}\n</sticky-note>\n\n${tail}`
  return clipToBudget(text, config.noteMaxBytes)
}

/**
 * Hard-clip the finished note, keeping the closing tag readable.
 * @param {string} text - complete note text.
 * @param {number} maxBytes - total UTF-8 budget.
 * @returns {string} the note, clipped when it exceeded the budget.
 */
function clipToBudget(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  const marker = '\n… (note truncated at its configured budget)'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'))
  // Slice on a character boundary: a lone surrogate would corrupt the note.
  let clipped = ''
  for (const char of text) {
    if (Buffer.byteLength(clipped + char, 'utf8') > budget) break
    clipped += char
  }
  return clipped + marker
}

/**
 * Build the note that replaces one evicted span.
 * @param {readonly object[]} messages - the evicted messages, in surface order.
 * @param {import('./config.js').NoteConfig} config - resolved note policy.
 * @returns {{ text: string, window: number, evicted: number }} the rendered note and its facts.
 */
export function buildStickyNote(messages, config) {
  const evicted = messages.filter(message => message.role !== 'system').length
  const facts = collectFacts(messages, config)
  return { text: renderNote({ ...facts, evicted }, config), window: facts.window, evicted }
}
