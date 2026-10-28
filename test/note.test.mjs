/**
 * Behaviour tests for the deterministic note builder and its configuration.
 *
 * These cover the two things that decide whether a rollover is safe: the note
 * must carry the facts a resuming reader needs, and it must stay inside the
 * budget the transaction will accept.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveNoteConfig } from '../src/config.js'
import { PINS_CLOSE, PINS_OPEN, buildStickyNote } from '../src/note.js'

/** Resolved policy used by every test unless it says otherwise. */
const config = resolveNoteConfig({})

/**
 * Build one user message.
 * @param {string} text - message text.
 * @param {{ kind: string }} [source] - message source.
 * @returns {object} a user message.
 */
function user(text, source = { kind: 'user' }) {
  return { role: 'user', content: [{ type: 'text', text }], source }
}

/**
 * Build one assistant message with optional tool calls.
 * @param {string} text - visible text.
 * @param {object[]} [calls] - tool-call blocks.
 * @returns {object} an assistant message.
 */
function assistant(text, calls = []) {
  return {
    role: 'assistant',
    content: [...(text.length > 0 ? [{ type: 'text', text }] : []), ...calls],
    source: { kind: 'model' },
  }
}

/**
 * Build one tool-call block.
 * @param {string} id - call id.
 * @param {string} name - tool name.
 * @param {object} args - arguments serialized as JSON.
 * @returns {object} a tool-call block.
 */
function call(id, name, args) {
  return { type: 'tool-call', id, name, arguments: JSON.stringify(args) }
}

/**
 * Build one tool-result message.
 * @param {string} callId - answering call id.
 * @param {string} text - result text.
 * @param {boolean} [isError] - whether the call failed.
 * @returns {object} a tool-role message.
 */
function tool(callId, text, isError = false) {
  return {
    role: 'tool',
    content: [{ type: 'text', text }],
    source: { kind: 'tool', callId },
    toolCallId: callId,
    ...(isError ? { isError: true } : {}),
  }
}

test('carries the objective, verified state, open issues, and next action', () => {
  const messages = [
    { role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } },
    user('Refactor the parser'),
    assistant('', [call('c1', 'edit', { file_path: 'src/parser.ts' })]),
    tool('c1', 'ok'),
    assistant('', [call('c2', 'bash', { command: 'pnpm test' })]),
    tool('c2', 'AssertionError: expected 1', true),
    user('Also fix the lexer'),
    assistant('Lexer fix in progress'),
  ]

  const { text, window, evicted } = buildStickyNote(messages, config)

  assert.equal(window, 1)
  assert.equal(evicted, 7)
  assert.match(text, /## Objective\n- Also fix the lexer\n- Refactor the parser/u)
  assert.match(text, /src\/parser\.ts \(edit\)/u)
  assert.match(text, /ran: pnpm test/u)
  assert.match(text, /\[bash\] AssertionError: expected 1/u)
  assert.match(text, /## Next action\n- Lexer fix in progress/u)
  assert.match(text, /## Pinned state\n- \(none\)/u)
})

test('continues the window count and carries the previous pinned section', () => {
  const priorNote = `<sticky-note version="1" window="3" evicted-messages="9">
## Objective
- earlier

## Pinned state
- Never rewrite migrations
- Ship behind a flag
</sticky-note>`

  const { text, window } = buildStickyNote([user(priorNote, { kind: 'compact-checkpoint' }), user('next')], config)

  assert.equal(window, 4)
  assert.match(text, /## Pinned state\n- Never rewrite migrations\n- Ship behind a flag/u)
})

test('a later pin call replaces the pinned list wholesale', () => {
  const pinBlock = pins => ({ role: 'tool', content: [{ type: 'text', text: `${PINS_OPEN}\n${pins.map(p => `- ${p}`).join('\n')}\n${PINS_CLOSE}` }], source: { kind: 'tool', callId: 'p' }, toolCallId: 'p' })

  const { text } = buildStickyNote([pinBlock(['first']), pinBlock(['second', 'third'])], config)

  assert.match(text, /## Pinned state\n- second\n- third/u)
  assert.doesNotMatch(text, /- first/u)
})

test('an explicit pin call outranks the previous note section', () => {
  const note = '<sticky-note version="1" window="1">\n## Pinned state\n- stale\n</sticky-note>'
  const pins = { role: 'tool', content: [{ type: 'text', text: `${PINS_OPEN}\n- fresh\n${PINS_CLOSE}` }], source: { kind: 'tool', callId: 'p' }, toolCallId: 'p' }

  const { text } = buildStickyNote([user(note, { kind: 'compact-checkpoint' }), pins], config)

  assert.match(text, /## Pinned state\n- fresh/u)
  assert.doesNotMatch(text, /- stale/u)
})

test('stays inside the configured byte budget', () => {
  const messages = Array.from({ length: 400 }, (_, index) => user(`request ${index} ${'x'.repeat(200)}`))
  const small = resolveNoteConfig({ noteMaxBytes: 1024 })

  const { text } = buildStickyNote(messages, small)

  assert.ok(Buffer.byteLength(text, 'utf8') <= 1024, `note is ${Buffer.byteLength(text, 'utf8')} bytes`)
  assert.match(text, /note truncated at its configured budget/u)
})

test('reports no objective and no next action without inventing one', () => {
  const { text } = buildStickyNote([assistant('', [call('c1', 'read', { path: 'a.ts' })]), tool('c1', 'contents')], config)

  assert.match(text, /## Objective\n- \(none\)/u)
  assert.match(text, /## Next action\n- \(none\)/u)
  assert.match(text, /a\.ts \(read\)/u)
})

test('rejects unknown config keys and bad budgets', () => {
  assert.throws(() => resolveNoteConfig({ noteMaxByte: 100 }), /unknown config key "noteMaxByte"/u)
  assert.throws(() => resolveNoteConfig({ noteMaxBytes: 0 }), /noteMaxBytes must be a positive integer/u)
  assert.throws(() => resolveNoteConfig({ noteTool: 'yes' }), /noteTool must be a boolean/u)
})
