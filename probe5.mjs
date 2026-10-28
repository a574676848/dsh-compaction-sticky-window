const { Context } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/cordis/lib/index.js")
const { createMessage, createUserMessage } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/dsh-llm/lib/index.js")
const { Session, SessionId } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/dsh-session/lib/index.js")
const { StickyWindowCompactionEngine } = await import("file:///E:/zbg/dsh-compaction-sticky-window/index.js")

const price = m => Math.ceil(Buffer.byteLength(JSON.stringify(m), "utf8") / 4)
const meter = { measure(s) { const nodes = s.surface.nodes.map(seq => { const t = price(s.deriveEventMessage(s.eventAt(seq))); return { seq, tokens: t, heuristicTokens: t } }); const total = nodes.reduce((a, n) => a + n.tokens, 0); return { logRevision: s.seq, baseline: { kind: "none", tokens: 0 }, surfaceDeltaTokens: total, totalTokens: total, surfaceTokens: total, nodes } }, estimateMessage: price }
const ctx = new Context()
ctx.provide("tokenMeter", meter)
const registered = []
ctx.provide("tools", { register: t => { registered.push(t); return () => {} } })
const engine = new StickyWindowCompactionEngine(ctx, { auto: false })

const s = Session.create(SessionId("h2e2e"))
s.append("turn/start", { turn: 1 }); s.append("step/start", { turn: 1, step: 1 })
for (let i = 0; i < 4; i++) {
  s.append("user/message", createUserMessage({ content: [{ type: "text", text: `secret detail ${i} ${"x".repeat(200)}` }], source: { kind: "user" } }), { surfaceOp: "append" })
}
// a sticky_note call that FAILED validation: assistant tool-call block + call event + error result
s.append("assistant/message", { stream: [], turn: 1, step: 1, message: createMessage({ role: "assistant", content: [{ type: "tool-call", id: "pin-x", name: "sticky_note", arguments: "{}" }], source: { kind: "model", provider: "mock", model: "mock" } }) }, { surfaceOp: "append" })
s.append("tool/call", { turn: 1, step: 1, callId: "pin-x", name: "sticky_note", arguments: "{}" })
s.append("tool/result", { turn: 1, step: 1, message: createMessage({ role: "tool", content: [{ type: "text", text: "Error: sticky_note: the pinned list exceeds the 4096-byte handoff budget after 12 entries; consolidate it and call again" }], source: { kind: "tool", callId: "pin-x" }, toolCallId: "pin-x", isError: true }) }, { surfaceOp: "append" })
s.append("turn/end", { turn: 1, reason: { kind: "completed" } })
s.append("turn/start", { turn: 2 }); s.append("step/start", { turn: 2, step: 1 })
s.append("user/message", createUserMessage({ content: [{ type: "text", text: "go on" }], source: { kind: "user" } }), { surfaceOp: "append" })

const nc = registered.find(t => t.name === "new_context")
const out = await nc.execute({}, { agent: { session: s, options: {} } })
console.log("new_context after a FAILED pin:", JSON.stringify(out))
const note = s.deriveMessages().find(m => m.source?.kind === "compact-checkpoint")
const text = note?.content.filter(b => b.type === "text").map(b => b.text).join("\n") ?? ""
console.log("note admits no handoff:", /no note was written/.test(text))
console.log("note carries any previous content:", /secret detail/.test(text))
console.log("live messages after rollover:", s.deriveMessages().length)

