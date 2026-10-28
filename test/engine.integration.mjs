/**
 * End-to-end test of one rollover through the real compaction transaction.
 *
 * A hand-built Cordis Context supplies the two services the transaction reads,
 * and a real `Session` records the durable events. Everything else — range
 * selection, tool-pair boundaries, the `compaction/*` bracket, the shrink check,
 * and surface replacement — is the shipped implementation, so a passing test
 * shows the note actually lands where the summarizing backend used to write.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { StickyWindowCompactionEngine } from '../index.js'
import { PINS_CLOSE, PINS_OPEN } from '../src/note.js'

/**
 * Price one message the way the transaction's estimator does.
 * @param {object} message - a derived conversation message.
 * @returns {number} an estimated token count.
 */
function price(message) {
  return Math.ceil(Buffer.byteLength(JSON.stringify(message), 'utf8') / 4)
}

/**
 * Build the token-meter double over the session's own surface.
 * @returns {object} a meter exposing the two methods compaction reads.
 */
function createMeter() {
  return {
    measure(session) {
      const nodes = session.surface.nodes.map(seq => {
        const tokens = price(session.deriveEventMessage(session.eventAt(seq)))
        return { seq, tokens, heuristicTokens: tokens }
      })
      const totalTokens = nodes.reduce((sum, node) => sum + node.tokens, 0)
      return {
        logRevision: session.seq,
        baseline: { kind: 'none', tokens: 0 },
        surfaceDeltaTokens: totalTokens,
        totalTokens,
        surfaceTokens: totalTokens,
        nodes,
      }
    },
    estimateMessage: price,
  }
}

/**
 * Build a session whose tool calls are paired and whose sizes make the note
 * comfortably smaller than the span it replaces.
 * @param {number} rounds - number of request/tool rounds to append.
 * @returns {Session} an open-turn session ready to compact.
 */
function buildSession(rounds) {
  const session = Session.create(SessionId('sticky-window-integration'))
  session.append('turn/start', { turn: 1 })
  for (let round = 0; round < rounds; round += 1) {
    session.append('step/start', { turn: 1, step: round + 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `Round ${round}: update module ${round} and keep the public API stable` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: round + 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `Editing src/module-${round}.ts` },
          { type: 'tool-call', id: `call-${round}`, name: 'edit', arguments: JSON.stringify({ file_path: `src/module-${round}.ts` }) },
        ],
        source: { kind: 'model', provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/result', {
      turn: 1,
      step: round + 1,
      message: createMessage({
        role: 'tool',
        content: [{ type: 'text', text: `Applied edit to src/module-${round}.ts ${'x'.repeat(400)}` }],
        source: { kind: 'tool', callId: `call-${round}` },
        toolCallId: `call-${round}`,
      }),
    }, { surfaceOp: 'append' })
  }
  return session
}

test('a rollover replaces the evicted span with the sticky note', async () => {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })

  const engine = new StickyWindowCompactionEngine(ctx, {
    auto: false,
    thresholdRatio: 0.8,
    retainRatio: 0.35,
  })
  const session = buildSession(12)
  const nodes = [...session.surface.nodes]
  const before = session.deriveMessages()

  const result = await engine.compactRegion(nodes[0], nodes[nodes.length - 3], { session, options: {} })

  // The transaction replaced the span with our note, not a model summary.
  assert.match(JSON.stringify(result.summary), /<sticky-note/u)
  assert.equal(result.shadowedSeqs.length, nodes.length - 2)

  // The note is what the model now sees in place of the evicted messages.
  const after = session.deriveMessages()
  const checkpoint = after.find(message => message.source?.kind === 'compact-checkpoint')
  assert.ok(checkpoint, 'a compact-checkpoint message is on the surface')
  const text = checkpoint.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
  assert.match(text, /<sticky-note version="1" window="1"/u)
  assert.match(text, /## Handoff/u)
  assert.match(text, /## Recorded facts\n- src\/module-0\.ts \(edit\)/u)
  assert.ok(after.length < before.length, 'the surface shrank')

  // The transaction recorded exactly one closed bracket and nothing threw.
  const types = session.snapshotEvents().map(event => event.type)
  assert.equal(types.filter(type => type === 'compaction/start').length, 1)
  assert.equal(types.filter(type => type === 'compaction/summary').length, 1)
  assert.equal(types.filter(type => type === 'compaction/end').length, 1)

  // The pin tool was registered as an effect of constructing the engine.
  assert.deepEqual(
    registered.map(tool => tool.name).sort(),
    ['context_status', 'history_query', 'new_context', 'sticky_note'],
  )
})

test('the summary record names this backend and claims no model call', async () => {
  const ctx = new Context()
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: () => () => {} })
  const engine = new StickyWindowCompactionEngine(ctx, { auto: false })
  const session = buildSession(8)
  const nodes = [...session.surface.nodes]

  await engine.compactRegion(nodes[0], nodes[nodes.length - 3], { session, options: {} })

  const summary = session.snapshotEvents().find(event => event.type === 'compaction/summary')
  assert.equal(summary.data.provider, 'dsh-compaction-sticky-window')
  assert.equal(summary.data.model, 'deterministic-note')
  assert.equal(summary.data.llmStreamCall, undefined)
  assert.ok(summary.data.shadowedTokenCount > 0)
  assert.ok(session.surface.nodes.length > 1)
})

test('an archived window is listable, searchable, and readable after a rollover', async () => {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })
  const engine = new StickyWindowCompactionEngine(ctx, { auto: false })
  const session = buildSession(6)
  const nodes = [...session.surface.nodes]
  await engine.compactRegion(nodes[0], nodes[nodes.length - 3], { session, options: {} })

  const history = registered.find(tool => tool.name === 'history_query')
  const exec = { agent: { session } }

  const windows = await history.execute({ action: 'windows' }, exec)
  assert.equal(windows.total, 1)
  assert.equal(windows.windows[0].window, 1)
  assert.equal(windows.windows[0].items, 16)

  const search = await history.execute({ action: 'search', query: 'src/module-2.ts' }, exec)
  assert.ok(search.total > 0, 'the evicted file path is still findable')
  assert.match(search.hits[0].snippet, /module-2/u)

  const read = await history.execute({ action: 'read', id: search.hits[0].id }, exec)
  assert.equal(read.found, true)
  assert.match(read.item.text, /module-2/u)

  const missing = await history.execute({ action: 'read', id: 'w9:9' }, exec)
  assert.equal(missing.found, false)
})

test('context_status prices the remaining budget against the rollover line', async () => {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })
  ctx.provide('llm', {
    resolveModelInfo: () => Promise.resolve({ context: { contextWindow: 100_000 }, defaultMaxTokens: 8000 }),
  })
  const engine = new StickyWindowCompactionEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 1 })
  const session = buildSession(2)
  session.append('request/header', {
    reason: 'initial',
    header: { config: { provider: 'mock', model: 'mock' } },
  })

  const status = registered.find(tool => tool.name === 'context_status')
  const value = await status.execute({}, { agent: { session } })

  assert.equal(value.available, true)
  assert.equal(value.contextWindow, 100_000)
  assert.equal(value.rolloverAtTokens, 80_000)
  assert.equal(value.remainingTokens, 80_000 - value.usedTokens)
  assert.equal(value.window, 1)
  assert.equal(value.source, 'local-estimate')
  assert.match(value.advice, /room to continue|rollover is close/u)
})

test('context_status refuses to invent a budget without a routed request', async () => {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })
  const engine = new StickyWindowCompactionEngine(ctx, { auto: false })
  const session = buildSession(1)

  const status = registered.find(tool => tool.name === 'context_status')
  const value = await status.execute({}, { agent: { session } })

  assert.equal(value.available, false)
  assert.match(value.reason, /No request has been routed/u)
})

test('context_status reports a trigger refusal instead of a plausible number', async () => {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })
  ctx.provide('llm', {
    resolveModelInfo: () => Promise.resolve({ context: { contextWindow: 1000 }, defaultMaxTokens: 0 }),
  })
  // Headroom exceeds the whole window, so the transaction refuses to compact.
  const engine = new StickyWindowCompactionEngine(ctx, { auto: false, headroomTokens: 5000, maxTokens: 1 })
  const session = buildSession(2)
  session.append('request/header', {
    reason: 'initial',
    header: { config: { provider: 'mock', model: 'mock' } },
  })

  const status = registered.find(tool => tool.name === 'context_status')
  const value = await status.execute({}, { agent: { session } })

  assert.equal(value.available, false)
  assert.match(value.reason, /leaving no pressure budget|leaving no message budget/u)
})

/**
 * Append one ``sticky_note`` call and its result, the way the loop records it.
 * @param {Session} session - session receiving the pair.
 * @param {number} turn - owning turn number.
 * @param {string[]} pins - pinned lines.
 * @returns {void}
 */
function appendPin(session, turn, pins) {
  const callId = `pin-${turn}`
  const args = JSON.stringify({ action: 'update', pins })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'sticky_note', arguments: args }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'sticky_note', arguments: args })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createMessage({
      role: 'tool',
      content: [{ type: 'text', text: `${PINS_OPEN}\n${pins.map(pin => `- ${pin}`).join('\n')}\n${PINS_CLOSE}` }],
      source: { kind: 'tool', callId },
      toolCallId: callId,
    }),
  }, { surfaceOp: 'append' })
}

/**
 * Open a second turn on a session built by {@link buildSession}.
 * @param {Session} session - session to extend.
 * @returns {void}
 */
function openSecondTurn(session) {
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  session.append('step/start', { turn: 2, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Continue with the current turn' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

test('new_context refuses to roll over before a note is saved', async () => {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })
  const engine = new StickyWindowCompactionEngine(ctx, { auto: false })
  const session = buildSession(6)
  openSecondTurn(session)

  const rollover = registered.find(tool => tool.name === 'new_context')
  const value = await rollover.execute({}, { agent: { session, options: {} } })

  assert.equal(value.rolled, false)
  assert.match(value.detail, /No note is saved in this window/u)
  assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0)
})

test('new_context rolls over to a fresh window that keeps only the note and the turn', async () => {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })
  const engine = new StickyWindowCompactionEngine(ctx, { auto: false })
  const session = buildSession(6)
  appendPin(session, 1, ['Keep the public API stable', 'Parser refactor is half done'])
  openSecondTurn(session)

  const before = [...session.surface.nodes].length
  const rollover = registered.find(tool => tool.name === 'new_context')
  const value = await rollover.execute({}, { agent: { session, options: {} } })

  assert.equal(value.rolled, true)
  assert.ok(value.evicted >= 18, `evicted ${value.evicted} messages`)

  // The fresh window is the note plus the current turn, not a retained tail.
  const after = session.deriveMessages()
  assert.ok(after.length <= 4, `fresh window has ${after.length} messages`)
  const note = after.find(message => message.source?.kind === 'compact-checkpoint')
  assert.ok(note, 'the note is on the surface')
  const text = note.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.match(text, /- Keep the public API stable/u)
  assert.match(text, /- Parser refactor is half done/u)
  assert.ok(after.some(message => message.role === 'user'
    && message.content.some(block => block.type === 'text' && block.text.includes('current turn'))))
  assert.ok(after.length < before, 'the surface shrank to the fresh window')
})

/**
 * Build a session whose rollover line sits a fixed distance from its own usage.
 * @param {object} meter - token meter double over the session.
 * @param {number} thresholdOffset - tokens between current usage and the line; negative crosses it.
 * @returns {{ ctx: Context, engine: object, session: Session, used: number }} the harness.
 */
function harnessAtThreshold(meter, thresholdOffset) {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', meter)
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })
  const session = buildSession(6)
  session.append('request/header', {
    reason: 'initial',
    header: { config: { provider: 'mock', model: 'mock' } },
  })
  const used = meter.measure(session).totalTokens
  const contextWindow = Math.ceil((used + thresholdOffset) / 0.8)
  ctx.provide('llm', {
    resolveModelInfo: () => Promise.resolve({ context: { contextWindow }, defaultMaxTokens: 0 }),
  })
  const engine = new StickyWindowCompactionEngine(ctx, {
    auto: false,
    headroomTokens: 0,
    maxTokens: 1,
    warnTokens: 2000,
  })
  return { ctx, engine, session, used }
}

test('an automatic rollover waits until the handoff note is saved', async () => {
  const meter = createMeter()
  // The line sits below current usage, so only the note gate stands in the way.
  const { engine, session } = harnessAtThreshold(meter, -200)
  openSecondTurn(session)
  const signal = new AbortController().signal

  const unprepared = await engine.compactIfNeeded({ session, options: {} }, 'pressure', signal)
  assert.equal(unprepared, null, 'no note means no rollover')
  assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0)

  appendPin(session, 2, ['Ready to hand off'])
  const prepared = await engine.compactIfNeeded({ session, options: {} }, 'pressure', signal)
  assert.ok(prepared !== null, 'a saved note lets the rollover happen')
  assert.match(JSON.stringify(prepared.summary), /Ready to hand off/u)
})

test('a warning is pushed before the rollover line and only once', async () => {
  const meter = createMeter()
  // The line sits 500 tokens above usage, inside the 2000-token warning band.
  const { ctx, session } = harnessAtThreshold(meter, 500)
  const payload = {
    agent: { session, options: {} },
    messages: [],
    turn: 1,
    step: 2,
    signal: new AbortController().signal,
    modelSelection: { provider: 'mock', model: 'mock' },
  }
  const fallback = () => Promise.resolve({ kind: 'enter', messages: [] })

  const first = await ctx.waterfall('agent/pre-step', payload, fallback)
  assert.equal(first.messages.length, 1, 'one notice is injected')
  const text = first.messages[0].content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  assert.match(text, /tokens remain before this window ends/u)

  const second = await ctx.waterfall('agent/pre-step', payload, fallback)
  assert.equal(second.messages.length, 0, 'the same stage is not repeated')
})

test('the loop closes across two windows: carry, archive, recall, sense', async () => {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })
  ctx.provide('llm', {
    resolveModelInfo: () => Promise.resolve({ context: { contextWindow: 200_000 }, defaultMaxTokens: 0 }),
  })
  const engine = new StickyWindowCompactionEngine(ctx, { auto: false, minEvictTokens: 200 })
  const session = buildSession(2)
  session.append('request/header', {
    reason: 'initial',
    header: { config: { provider: 'mock', model: 'mock' } },
  })
  const tools = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const agent = { session, options: {} }
  const noteText = () => {
    const note = session.deriveMessages().find(message => message.source?.kind === 'compact-checkpoint')
    return note === undefined ? '' : note.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  }

  appendPin(session, 1, ['Goal: refactor the parser'])
  openSecondTurn(session)
  const first = await tools.new_context.execute({}, { agent })
  assert.equal(first.rolled, true, first.detail)
  assert.match(noteText(), /- Goal: refactor the parser/u)

  // Grow the fresh window past the minimum span, then roll again.
  for (let turn = 3; turn <= 5; turn += 1) {
    session.append('turn/end', { turn: turn - 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn })
    session.append('step/start', { turn, step: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `turn ${turn} ${'z'.repeat(6000)}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  appendPin(session, 5, ['Goal: refactor the parser', 'Progress: lexer landed'])
  session.append('turn/end', { turn: 5, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 6 })
  session.append('step/start', { turn: 6, step: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `turn 6 ${'z'.repeat(6000)}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })

  const second = await tools.new_context.execute({}, { agent })
  assert.equal(second.rolled, true, second.detail)
  assert.match(noteText(), /- Progress: lexer landed/u, 'the newest handoff is carried')

  // The archive grows, and the very first evicted text is still recallable.
  const windows = await tools.history_query.execute({ action: 'windows' }, { agent })
  assert.equal(windows.total, 2)
  const found = await tools.history_query.execute({ action: 'search', query: 'Round 0' }, { agent })
  assert.ok(found.total > 0, 'the first window is searchable')
  const read = await tools.history_query.execute({ action: 'read', id: found.hits[0].id }, { agent })
  assert.equal(read.found, true)

  // The fresh window is tiny, and sensing agrees on the ordinal.
  assert.ok(session.deriveMessages().length <= 3, `fresh window has ${session.deriveMessages().length} messages`)
  const status = await tools.context_status.execute({}, { agent })
  assert.equal(status.available, true)
  assert.equal(status.window, 3)
})

test('a rollover is refused when the evictable span is smaller than the note', async () => {
  const ctx = new Context()
  /** @type {object[]} */
  const registered = []
  ctx.provide('tokenMeter', createMeter())
  ctx.provide('tools', { register: tool => { registered.push(tool); return () => {} } })
  const engine = new StickyWindowCompactionEngine(ctx, { auto: false })
  const session = buildSession(1)
  appendPin(session, 1, ['tiny'])
  openSecondTurn(session)

  const rollover = registered.find(tool => tool.name === 'new_context')
  const value = await rollover.execute({}, { agent: { session, options: {} } })

  assert.equal(value.rolled, false)
  assert.match(value.detail, /too small to be worth a window change/u)
  assert.equal(session.snapshotEvents().filter(event => event.type === 'compaction/summary').length, 0)
})


