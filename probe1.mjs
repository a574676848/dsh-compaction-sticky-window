const { Context } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/cordis/lib/index.js")
const { default: Engine } = await import("file:///E:/zbg/dsh-compaction-sticky-window/index.js")

console.log("--- H1: does the Config schema keep the new keys? ---")
const accepted = Engine.Config({ warnTokens: 100, fallbackTokens: 200, notices: false, noteMaxBytes: 4096 })
console.log("output:", JSON.stringify(accepted))

console.log("\n--- H2/H4/H5: behavioural probes ---")
const { createMessage, createUserMessage } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/dsh-llm/lib/index.js")
const { Session, SessionId } = await import("file:///E:/zbg/dsh-compaction-sticky-window/node_modules/@deepseek-ai/dsh-session/lib/index.js")
const { noteSavedThisWindow } = await import("file:///E:/zbg/dsh-compaction-sticky-window/src/window.js")
const { collectArchive, currentWindowNumber } = await import("file:///E:/zbg/dsh-compaction-sticky-window/src/history.js")
const { PINS_OPEN, PINS_CLOSE } = await import("file:///E:/zbg/dsh-compaction-sticky-window/src/note.js")

function s(id) {
  const x = Session.create(SessionId(id))
  x.append("turn/start", { turn: 1 })
  x.append("step/start", { turn: 1, step: 1 })
  return x
}
function addCall(x, callId, name, args = "{}") {
  x.append("tool/call", { turn: 1, step: 1, callId, name, arguments: args })
}
function addResult(x, callId, text, isError) {
  x.append("tool/result", {
    turn: 1, step: 1,
    message: createMessage({ role: "tool", content: [{ type: "text", text }], source: { kind: "tool", callId }, toolCallId: callId, ...(isError ? { isError: true } : {}) }),
  }, { surfaceOp: "append" })
}

// H2: a rejected pin call still counts as "saved"
const a = s("h2")
addCall(a, "pin-1", "sticky_note", JSON.stringify({ action: "update", pins: ["x"] }))
addResult(a, "pin-1", "Error: sticky_note: the pinned list exceeds the 4096-byte handoff budget after 3 entries", true)
console.log("H2 failed-pin gate:", JSON.stringify(noteSavedThisWindow(a)))

// control: a successful pin
const b = s("h2b")
addCall(b, "pin-2", "sticky_note")
addResult(b, "pin-2", `${PINS_OPEN}\n- ok\n${PINS_CLOSE}`)
console.log("H2 good-pin gate:", JSON.stringify(noteSavedThisWindow(b)))

// H4: phantom window - summary with no replacement
const c = s("h4")
c.append("user/message", createUserMessage({ content: [{ type: "text", text: "live message still on the surface" }], source: { kind: "user" } }), { surfaceOp: "append" })
const liveSeq = c.surface.nodes[c.surface.nodes.length - 1]
c.append("compaction/summary", {
  compactionId: "cid", summary: [{ type: "text", text: "s" }],
  shadowedRange: { start: liveSeq, end: liveSeq }, shadowedSeqs: [liveSeq], shadowedTokenCount: 1,
  provider: "p", model: "m",
})
const arch = collectArchive(c)
console.log("H4 phantom windows:", arch.windows.length, "items:", arch.items.size, "| window counter:", currentWindowNumber(c))
console.log("H4 note reported as archived while still live:", [...arch.items.values()].map(i => i.text))
