const { Context } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/cordis/lib/index.js")
const { createMessage, createUserMessage } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/dsh-llm/lib/index.js")
const { Session, SessionId } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/dsh-session/lib/index.js")
const { StickyWindowCompactionEngine } = await import("file:///E:/zbg/dsh-compaction-sticky-window/index.js")

const price = m => Math.ceil(Buffer.byteLength(JSON.stringify(m), "utf8") / 4)
const meter = { measure(s) { const nodes = s.surface.nodes.map(seq => { const t = price(s.deriveEventMessage(s.eventAt(seq))); return { seq, tokens: t, heuristicTokens: t } }); const total = nodes.reduce((a, n) => a + n.tokens, 0); return { logRevision: s.seq, baseline: { kind: "none", tokens: 0 }, surfaceDeltaTokens: total, totalTokens: total, surfaceTokens: total, nodes } }, estimateMessage: price }

const ctx = new Context()
ctx.provide("tokenMeter", meter)
ctx.provide("tools", { register: () => () => {} })
let modelInfoCalls = 0
const s = Session.create(SessionId("h5"))
s.append("turn/start", { turn: 1 }); s.append("step/start", { turn: 1, step: 1 })
for (let i = 0; i < 6; i++) {
  s.append("user/message", createUserMessage({ content: [{ type: "text", text: `req ${i} ${"x".repeat(200)}` }], source: { kind: "user" } }), { surfaceOp: "append" })
}
s.append("request/header", { reason: "initial", header: { config: { provider: "mock", model: "mock" } } })
const used = meter.measure(s).totalTokens
ctx.provide("llm", { resolveModelInfo: () => { modelInfoCalls += 1; return Promise.resolve({ context: { contextWindow: Math.ceil((used + 500) / 0.8) }, defaultMaxTokens: 0 }) } })
const engine = new StickyWindowCompactionEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 1, warnTokens: 2000 })

const payload = { agent: { session: s, options: {} }, messages: [], turn: 1, step: 2, signal: new AbortController().signal, modelSelection: { provider: "mock", model: "mock" } }
const rejectNext = () => Promise.resolve({ kind: "reject" })
const enterNext = () => Promise.resolve({ kind: "enter", messages: [] })

const r1 = await ctx.waterfall("agent/pre-step", payload, rejectNext)
console.log("H5 step rejected, notice delivered?", r1.messages?.length ?? "n/a")
const r2 = await ctx.waterfall("agent/pre-step", payload, enterNext)
console.log("H5 next step, notice delivered?", r2.messages.length, "(0 means the stage was consumed by the rejected step)")
console.log("resolveModelInfo calls so far:", modelInfoCalls, "for 2 pre-steps")
console.log("ctx.compaction present:", ctx.compaction !== undefined, "| engine is ours:", ctx.compaction === engine)
