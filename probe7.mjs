const { Context } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/cordis/lib/index.js")
const { createMessage, createUserMessage } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/dsh-llm/lib/index.js")
const { Session, SessionId } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/dsh-session/lib/index.js")
const { StickyWindowCompactionEngine } = await import("file:///E:/zbg/dsh-compaction-sticky-window/index.js")
const price = m => Math.ceil(Buffer.byteLength(JSON.stringify(m), "utf8") / 4)
const meter = { measure(s) { const nodes = s.surface.nodes.map(seq => { const t = price(s.deriveEventMessage(s.eventAt(seq))); return { seq, tokens: t, heuristicTokens: t } }); const total = nodes.reduce((a, n) => a + n.tokens, 0); return { logRevision: s.seq, baseline: { kind: "none", tokens: 0 }, surfaceDeltaTokens: total, totalTokens: total, surfaceTokens: total, nodes } }, estimateMessage: price }

const s = Session.create(SessionId("dup"))
s.append("turn/start", { turn: 1 }); s.append("step/start", { turn: 1, step: 1 })
for (let i = 0; i < 6; i++) s.append("user/message", createUserMessage({ content: [{ type: "text", text: `req ${i} ${"x".repeat(200)}` }], source: { kind: "user" } }), { surfaceOp: "append" })
s.append("request/header", { reason: "initial", header: { config: { provider: "mock", model: "mock" } } })
const used = meter.measure(s).totalTokens

// root realm = host plane engine (patch: tools on, notices default true)
const ctx = new Context()
ctx.provide("tokenMeter", meter)
ctx.provide("tools", { register: () => () => {} })
ctx.provide("llm", { resolveModelInfo: () => Promise.resolve({ context: { contextWindow: Math.ceil((used + 500) / 0.8) }, defaultMaxTokens: 0 }) })
const hostEngine = new StickyWindowCompactionEngine(ctx, { auto: false, headroomTokens: 0, maxTokens: 1, warnTokens: 2000 })

// preset realm = the row shipped in presets/sticky-window.patch.yml (tools/guidance off, notices NOT set)
const realm = typeof ctx.isolate === "function" ? ctx.isolate("compaction") : ctx.extend({})
const presetEngine = new StickyWindowCompactionEngine(realm, {
  auto: false, headroomTokens: 0, maxTokens: 1, warnTokens: 2000,
  noteTool: false, sensingTool: false, historyTool: false, newContextTool: false, guidance: false,
})

const payload = { agent: { session: s, options: {} }, messages: [], turn: 1, step: 2, signal: new AbortController().signal, modelSelection: { provider: "mock", model: "mock" } }
const decision = await realm.waterfall("agent/pre-step", payload, () => Promise.resolve({ kind: "enter", messages: [] }))
console.log("engines: host + preset | notices injected in ONE step:", decision.messages.length)
console.log("distinct texts:", new Set(decision.messages.map(m => m.content.map(b => b.text).join())).size)

