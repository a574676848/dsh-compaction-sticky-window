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
  assert.match(text, /## Objective\n- Round 11/u)
  assert.match(text, /src\/module-0\.ts \(edit\)/u)
  assert.ok(after.length < before.length, 'the surface shrank')

  // The transaction recorded exactly one closed bracket and nothing threw.
  const types = session.snapshotEvents().map(event => event.type)
  assert.equal(types.filter(type => type === 'compaction/start').length, 1)
  assert.equal(types.filter(type => type === 'compaction/summary').length, 1)
  assert.equal(types.filter(type => type === 'compaction/end').length, 1)

  // The pin tool was registered as an effect of constructing the engine.
  assert.deepEqual(registered.map(tool => tool.name).sort(), ['context_status', 'history_query', 'sticky_note'])
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

