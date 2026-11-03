// Failure-path integration tests against the real muse CLI: client aborts,
// muse crashing mid-turn, and upstream rate limits. Every scenario checks
// that the muse process tree (including the MCP helper) is gone afterwards
// and that the conversation recovers on the next request.
//
//   MUSE_TEST_BIN=/path/to/muse node test-failures.mjs
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { echoTool, findMuseBin, processTree, sleep, startHarness, waitFor, waitGone } from "./test-harness.mjs"

const realBin = findMuseBin()
if (!realBin) {
  console.log("skip: muse CLI not found (set MUSE_TEST_BIN)")
  process.exit(0)
}

// A wrapper used as MUSE_PATH: it exits at once with an error when the
// current turn of the prompt says CRASH_EARLY, and otherwise execs the real
// muse (so the bridge's child pid is muse itself).
const wrapperDir = fs.mkdtempSync(path.join(os.tmpdir(), "muse-wrapper-"))
const wrapper = path.join(wrapperDir, "muse")
fs.writeFileSync(wrapper, `#!/bin/bash
prompt=""
prev=""
for arg in "$@"; do
  [ "$prev" = "--prompt-file" ] && prompt="$arg"
  prev="$arg"
done
if [ -n "$prompt" ]; then
  if grep -q "<current_turn>" "$prompt"; then current=$(sed -n '/<current_turn>/,$p' "$prompt"); else current=$(cat "$prompt"); fi
  case "$current" in
    *CRASH_EARLY*) echo "muse: simulated crash before any output" >&2; exit 3 ;;
  esac
fi
exec ${JSON.stringify(realBin)} "$@"
`, { mode: 0o755 })

// TOOL_BATCH_MS is stretched so a tool_use response stays open long enough
// to abort it while the MCP call is still pending.
const h = await startHarness({ bin: wrapper, env: { MUSE_BRIDGE_TOOL_BATCH_MS: "1500" } })
const { _test, request, call, step, requests } = h

// Incremental SSE reader over a Response body.
function sseReader(res) {
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  const events = []
  return {
    events,
    reader,
    // Read until predicate(event) holds; returns that event.
    async until(predicate) {
      for (;;) {
        let at
        while ((at = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, at)
          buf = buf.slice(at + 2)
          const data = chunk.split("\n").find((line) => line.startsWith("data: "))
          if (!data) continue
          const event = JSON.parse(data.slice(6))
          events.push(event)
          if (predicate(event)) return event
        }
        const { value, done } = await reader.read()
        if (done) throw new Error(`stream ended before the expected event; saw ${events.map((e) => e.type).join(",")}`)
        buf += decoder.decode(value, { stream: true })
      }
    },
  }
}

// muse hung up on the upstream before the response finished.
async function assertUpstreamDropped(record) {
  await waitFor(() => record.closed, 3000, "upstream request to close")
  assert.equal(record.finished, false)
}

const liveConv = () => [..._test.pool.values()].find((conv) => conv.turn && !conv.turn.exited)

// Snapshot the live turn's process tree (muse + MCP helper).
function liveTree() {
  const conv = liveConv()
  assert.ok(conv?.turn?.child?.pid, "no live muse turn")
  return { conv, pids: processTree(conv.turn.child.pid) }
}

async function assertCleanedUp(pids, conv) {
  await waitGone(pids)
  await waitFor(() => _test.liveTurns.size === 0, 8000, "liveTurns to drain")
  assert.equal(conv.turn, null, "conversation still holds a turn")
  assert.equal(_test.toolCalls.size, 0, "tool calls left registered")
}

// The rejected promise from an aborted read; the stream must error, not hang.
async function expectAborted(promise) {
  const outcome = await Promise.race([
    promise.then(() => "ended", () => "rejected"),
    sleep(5000).then(() => "hung"),
  ])
  assert.equal(outcome, "rejected", "an aborted stream must error")
}

try {
  await step("abort before any output returns 499 and kills muse", async () => {
    const controller = new AbortController()
    const before = requests.length
    const pending = request({ messages: [{ role: "user", content: "SLOW_START tell me about the ocean" }] }, { signal: controller.signal })
    // Abort once muse is waiting on the (deliberately slow) upstream.
    const upstream = await waitFor(() => requests[before], 10000, "muse to reach the upstream")
    const { conv, pids } = liveTree()
    controller.abort()
    const res = await pending
    assert.equal(res.status, 499)
    await assertCleanedUp(pids, conv)
    assert.equal(conv.sessionId, null)
    await assertUpstreamDropped(upstream)
  })

  await step("abort while text streams kills muse; next turn replays history", async () => {
    const first = { role: "user", content: "SLOW_TEXT describe the mountains in detail" }
    const controller = new AbortController()
    const res = await request({ messages: [first] }, { signal: controller.signal })
    assert.equal(res.status, 200)
    const sse = sseReader(res)
    const delta = await sse.until((event) => event.type === "content_block_delta")
    assert.match(delta.delta.text, /^chunk0/)
    const { conv, pids } = liveTree()
    const upstream = requests.at(-1)
    controller.abort()
    await expectAborted(sse.until(() => false))
    await assertCleanedUp(pids, conv)
    assert.equal(conv.sessionId, null, "an aborted turn must not be resumed")
    await assertUpstreamDropped(upstream)

    const r = await call({ messages: [
      first,
      { role: "assistant", content: [{ type: "text", text: "chunk0" }] },
      { role: "user", content: "continue about the valleys please" },
    ] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.content[0].text, "REPLY users=1 history=yes")
  })

  await step("abort while an MCP tool call is pending kills muse and its helper", async () => {
    const system = "Abort-during-tool agent."
    const first = { role: "user", content: "please CALL_ONE about the forest" }
    const controller = new AbortController()
    const res = await request({ system, tools: [echoTool], messages: [first] }, { signal: controller.signal })
    assert.equal(res.status, 200)
    const sse = sseReader(res)
    await sse.until((event) => event.type === "content_block_stop")
    assert.equal(sse.events.find((event) => event.type === "content_block_start").content_block.type, "tool_use")
    // Inside the tool batch window: the call is out but unanswered.
    const { conv, pids } = liveTree()
    assert.ok(pids.length >= 2, `expected muse plus the MCP helper, got ${pids}`)
    assert.equal(_test.toolCalls.size, 1)
    controller.abort()
    await expectAborted(sse.until(() => false))
    await assertCleanedUp(pids, conv)

    const r = await call({ system, tools: [echoTool], messages: [first, { role: "user", content: "never mind, just answer about the trees" }] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.content[0].text, "REPLY users=1 history=yes")
  })

  await step("abort the tool-result continuation mid-stream", async () => {
    const system = "Abort-continuation agent."
    const first = { role: "user", content: "please CALL_ONE then SLOW_TEXT about the desert" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.stop, "tool_use", JSON.stringify(r1))
    const use = r1.content.find((block) => block.type === "tool_use")
    const messages = [first, { role: "assistant", content: r1.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "ECHO:PING" }] }]
    const controller = new AbortController()
    const res = await request({ system, tools: [echoTool], messages }, { signal: controller.signal })
    assert.equal(res.status, 200)
    const sse = sseReader(res)
    await sse.until((event) => event.type === "content_block_delta")
    const { conv, pids } = liveTree()
    assert.ok(pids.length >= 2, `expected muse plus the MCP helper, got ${pids}`)
    controller.abort()
    await expectAborted(sse.until(() => false))
    await assertCleanedUp(pids, conv)

    const r = await call({ system, tools: [echoTool], messages: [...messages,
      { role: "assistant", content: [{ type: "text", text: "chunk0" }] },
      { role: "user", content: "summarize the dunes now" },
    ] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.content[0].text, "REPLY users=1 history=yes")
  })

  await step("muse exiting before output gives a clean 502; next turn recovers", async () => {
    const first = { role: "user", content: "CRASH_EARLY explain the rivers" }
    const r = await call({ messages: [first] })
    assert.equal(r.status, 502, JSON.stringify(r))
    assert.match(r.error.error.message, /muse exited \(code=3 signal=null\): muse: simulated crash before any output/)
    await waitFor(() => _test.liveTurns.size === 0, 3000, "liveTurns to drain")
    const r2 = await call({ messages: [first, { role: "user", content: "try again about the lakes" }] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.content[0].text, "REPLY users=1 history=yes")
  })

  await step("muse killed mid-stream ends the SSE with an error; next turn replays", async () => {
    const first = { role: "user", content: "SLOW_TEXT explain the glaciers" }
    const res = await request({ messages: [first] })
    assert.equal(res.status, 200)
    const sse = sseReader(res)
    await sse.until((event) => event.type === "content_block_delta")
    const { conv, pids } = liveTree()
    process.kill(pids[0], "SIGKILL")
    const error = await sse.until((event) => event.type === "error")
    assert.match(error.error.message, /muse exited \(code=null signal=SIGKILL\)/)
    const { done } = await sse.reader.read()
    assert.equal(done, true, "stream must close after the error event")
    await assertCleanedUp(pids, conv)
    assert.equal(conv.sessionId, null)

    const r = await call({ messages: [first, { role: "assistant", content: [{ type: "text", text: "chunk0" }] }, { role: "user", content: "and the icebergs?" }] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.content[0].text, "REPLY users=1 history=yes")
  })

  await step("muse killed while the client runs a tool; the tool result replays", async () => {
    const system = "Crash-during-tool agent."
    const first = { role: "user", content: "please CALL_ONE about the volcano" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.stop, "tool_use", JSON.stringify(r1))
    const { conv, pids } = liveTree()
    process.kill(pids[0], "SIGKILL")
    await waitGone(pids)
    const use = r1.content.find((block) => block.type === "tool_use")
    const r2 = await call({ system, tools: [echoTool], messages: [first, { role: "assistant", content: r1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "ECHO:PING" }] }] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.content[0].text, "REPLY users=1 history=yes")
    assert.ok(inputHas(requests.at(-1), "ECHO:PING"), "the tool result must reach the new session")
    await waitFor(() => _test.liveTurns.size === 0, 8000, "liveTurns to drain")
    assert.equal(conv.turn, null)
  })

  await step("429 retried by muse succeeds", async () => {
    const before = requests.length
    const r = await call({ messages: [{ role: "user", content: "RATE429x2 tell me about the weather" }] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.content[0].text, "REPLY users=1 history=no")
    assert.deepEqual(requests.slice(before).map((record) => record.status), [429, 429, 200])
  })

  await step("persistent 429 maps to HTTP 429", async () => {
    const r = await call({ messages: [{ role: "user", content: "RATE429x* tell me about the climate" }] })
    assert.equal(r.status, 429, JSON.stringify(r))
    assert.equal(r.error.error.type, "rate_limit_error")
    assert.match(r.error.error.message, /429/)
    await waitFor(() => _test.liveTurns.size === 0, 3000, "liveTurns to drain")
  })
} finally {
  fs.rmSync(wrapperDir, { recursive: true, force: true })
  h.finish()
}

function inputHas(record, text) {
  return JSON.stringify(record.body.input).includes(text)
}
