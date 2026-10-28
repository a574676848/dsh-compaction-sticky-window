/**
 * Reading and writing the pinned handoff.
 *
 * The pins' only durable home is the tool result the model's call leaves in the
 * conversation, so these helpers parse that block back out of the log rather
 * than reading any side storage.
 *
 * @module dsh-compaction-sticky-window/pins
 */

import { PINS_CLOSE, PINS_OPEN, PIN_TOOL_NAME, extractPins, textOf } from './note.js'

/**
 * Render the block a pin call leaves in the conversation.
 *
 * The block is the pins' only durable home: it is a normal tool result on the
 * surface, so the next rollover reads it back without any side storage.
 * @param {readonly string[]} pins - validated pinned facts.
 * @returns {string} the model-visible pin block.
 */
export function renderPins(pins) {
  const body = pins.map(pin => `- ${pin}`).join('\n')
  return `${PINS_OPEN}\n${body}\n${PINS_CLOSE}\nPinned ${pins.length} ${pins.length === 1 ? 'fact' : 'facts'} to the sticky note.`
}

/**
 * Normalize and bound the pinned facts of one call.
 *
 * A pin replaces the previous set, so an empty list is rejected: an accidental
 * empty call must not silently erase the state the next rollover depends on.
 * @param {readonly string[]} raw - model-supplied lines, already schema-checked.
 * @param {{ pinnedLineMaxChars: number, pinnedMaxBytes: number }} config - resolved policy.
 * @returns {string[]} trimmed, deduplicated, bounded lines.
 * @throws {Error} when no usable line remains.
 */
export function toPins(raw, config) {
  /** @type {string[]} */
  const pins = []
  const seen = new Set()
  let used = 0
  for (const entry of raw) {
    const line = entry.replace(/\s+/gu, ' ').trim().slice(0, config.pinnedLineMaxChars)
    if (line.length === 0 || seen.has(line)) continue
    const size = Buffer.byteLength(line, 'utf8') + 3
    if (used + size > config.handoffMaxBytes) {
      throw new Error(
        `sticky_note: the pinned list exceeds the ${config.handoffMaxBytes}-byte handoff budget after `
        + `${pins.length} ${pins.length === 1 ? 'entry' : 'entries'}; consolidate it and call again`,
      )
    }
    seen.add(line)
    pins.push(line)
    used += size
  }
  if (pins.length === 0) {
    throw new Error('sticky_note: provide at least one non-empty pin')
  }
  return pins
}

/**
 * Keep the pinned lines one note can actually carry.
 *
 * Read must not attest to a fact the next rollover is going to drop, so the
 * reported list is the list a note of the current budget renders.
 * @param {readonly string[]} pins - the full pinned list.
 * @param {number} maxBytes - the note's pinned-section budget.
 * @returns {string[]} the carried prefix.
 */
export function carriedPins(pins, maxBytes) {
  /** @type {string[]} */
  const carried = []
  let used = 0
  for (const pin of pins) {
    const size = Buffer.byteLength(`- ${pin}`, 'utf8') + 1
    if (used + size > maxBytes) break
    carried.push(pin)
    used += size
  }
  return carried
}

/**
 * Read the pinned list currently carried by this session.
 *
 * The newest pin block in the log is authoritative, including one already
 * carried into the note by a rollover.
 * @param {object} session - the session to read.
 * @returns {string[]} pinned lines, empty when nothing was pinned yet.
 */
export function currentPins(session) {
  const events = session.snapshotEvents()
  /** @type {Map<string, string>} */
  const calls = new Map()
  for (const event of events) {
    if (event.type === 'tool/call') calls.set(event.data.callId, event.data.name)
  }
  /** @type {string[]} */
  let pins = []
  for (const event of events) {
    if (event.type !== 'tool/result') continue
    if (calls.get(event.data.message?.source?.callId) !== PIN_TOOL_NAME) continue
    const found = extractPins(textOf(event.data.message))
    if (found !== null) pins = found
  }
  if (pins.length > 0) return pins
  for (const message of session.deriveMessages()) {
    if (message.source?.kind !== 'compact-checkpoint') continue
    const section = /## Handoff\n([\s\S]*?)(?:\n## |\n<\/sticky-note>)/u.exec(textOf(message))
    if (section === null) continue
    const lines = section[1]
      .split('\n')
      .map(line => line.replace(/^[-*]\s*/u, '').trim())
      .filter(line => line.length > 0 && line !== '(none)')
    if (lines.length > 0) pins = lines
  }
  return pins
}

