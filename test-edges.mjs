// Edge-case integration tests against the real muse CLI: turn and tool
// timeouts, MAX_ACTIVE concurrency cap, images in user turns and tool results,
// error and context-notice tool results, renamed and duplicate tool_use ids,
// idle conversation eviction, and 401 auth failure.
//
//   MUSE_TEST_BIN=/path/to/muse node test-edges.mjs
import assert from "node:assert/strict"
import fs from "node:fs"
import { echoTool, findMuseBin, inputText, processTree, sleep, startHarness, waitFor, waitGone } from "./test-harness.mjs"

const bin = findMuseBin()
if (!bin) {
  console.log("skip: muse CLI not found (set MUSE_TEST_BIN)")
  process.exit(0)
}

// 1x1 transparent PNG.
const PNG_1X1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII="

// Small timeouts and MAX_ACTIVE=1 so timeout and capacity paths finish in a
// few seconds each. TURN_TIMEOUT_MS must outlast muse's ~2.5s startup.
const h = await startHarness({
  bin,
  env: {
    MUSE_BRIDGE_MAX_ACTIVE: "1",
    MUSE_BRIDGE_TURN_TIMEOUT_MS: "4500",
    MUSE_BRIDGE_TOOL_TIMEOUT_MS: "1500",
    MUSE_BRIDGE_FIRST_EVENT_MS: "6000",
  },
})
const { _test, request, call, step, requests } = h

const liveConv = () => [..._test.pool.values()].find((conv) => conv.turn && !conv.turn.exited)

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

// Extract the last function_call_output item muse sent to the upstream.
function lastOutput(record = requests.at(-1)) {
  const item = [...record.body.input].reverse().find((entry) => entry.type === "function_call_output")
  assert.ok(item, `expected function_call_output in ${JSON.stringify(record.body.input).slice(0, 300)}`)
  return item
}

function hasImageItem(input) {
  return JSON.stringify(input).includes("input_image") || JSON.stringify(input).includes("image_url")
}

try {
  // 1. Turn timeout: the upstream sends a partial delta then stalls; the
  // bridge's turn timer fires, ends the SSE with a clean error, kills the
  // muse tree, and the next turn replays history into a fresh session.
  await step("turn timeout kills a stalled muse turn; next turn recovers", async () => {
    const first = { role: "user", content: "STALL_TEXT explain the tides in detail" }
    const started = request({ messages: [first] })
    const { conv, pids } = await waitFor(() => liveConv() && liveTree(), 5000, "muse to start")
    const r = await started.then(async (res) => ({ status: res.status, ...(await import("./test-harness.mjs")).parseSSE(await res.text()) }))
    assert.equal(r.status, 200)
    assert.equal(r.content[0]?.text, "partial ")
    assert.ok(r.error, "expected an SSE error event")
    assert.match(r.error.message, /timed out waiting for muse output after 4500ms/)
    await assertCleanedUp(pids, conv)
    assert.equal(conv.sessionId, null)

    const r2 = await call({ messages: [
      first,
      { role: "assistant", content: [{ type: "text", text: "partial" }] },
      { role: "user", content: "finish explaining the tides please" },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.content[0].text, "REPLY users=1 history=yes")
  })

  // 2. Tool timeout: the client receives tool_use and never sends tool_result.
  // After TOOL_TIMEOUT_MS, the bridge fails and kills muse; when the late
  // tool_result finally arrives, the bridge returns a clean error and can
  // also recover if the conversation moves on.
  await step("tool timeout kills muse when tool_result never arrives; late result is rejected cleanly", async () => {
    const system = "Tool-timeout agent."
    const first = { role: "user", content: "please CALL_ONE about the stars" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.stop, "tool_use", JSON.stringify(r1))
    const { conv, pids } = liveTree()
    assert.ok(pids.length >= 2, `expected muse plus MCP helper, got ${pids}`)
    const use = r1.content.find((block) => block.type === "tool_use")

    // Do not send tool_result: wait for TOOL_TIMEOUT_MS (1500ms) to finalize
    // the detached turn and kill muse + the MCP helper.
    await assertCleanedUp(pids, conv)
    assert.equal(conv.sessionId, null, "session must reset when the turn dies awaiting a tool")

    // A plain user message (client abandoned the timed-out tool call) recovers
    // cleanly instead of hitting a stale unfinished-turn 503.
    const abandoned = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "user", content: "skip the tool and answer about nebulae" },
    ] })
    assert.equal(abandoned.status, 200, JSON.stringify(abandoned.error))
    assert.equal(abandoned.content[0].text, "REPLY users=1 history=yes")
    await waitFor(() => _test.liveTurns.size === 0, 5000, "abandoned turn to exit")

    // And a late tool_result for the timed-out call replays into a new session
    // when idle, or gets 409 if another turn is currently active on the conv.
    const late = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "LATE_ECHO" }] },
    ] })
    assert.equal(late.status, 200, JSON.stringify(late.error))
    assert.equal(late.content[0].text, "REPLY users=1 history=yes")
    await waitFor(() => _test.liveTurns.size === 0, 5000, "late replay turn to exit")
  })

  // 3. MAX_ACTIVE=1: a second conversation started while the first is in
  // flight gets HTTP 503 ("muse runs are in flight") and succeeds once the
  // first finishes.
  await step("MAX_ACTIVE=1 rejects a second concurrent conversation with 503, then recovers", async () => {
    const controller = new AbortController()
    const before = requests.length
    const first = request({ system: "Conv A.", messages: [{ role: "user", content: "SLOW_START tell me about conv A" }] }, { signal: controller.signal })
    await waitFor(() => requests[before], 8000, "conv A to reach upstream")
    assert.equal(_test.liveTurns.size, 1)

    const busy = await call({ system: "Conv B.", messages: [{ role: "user", content: "tell me about conv B" }] })
    assert.equal(busy.status, 503, JSON.stringify(busy))
    assert.match(busy.error.error.message, /1 muse runs are in flight/)

    const resA = await first
    const bodyA = (await import("./test-harness.mjs")).parseSSE(await resA.text())
    assert.equal(bodyA.stop, "end_turn")
    await waitFor(() => _test.liveTurns.size === 0, 8000, "conv A to exit")

    const okB = await call({ system: "Conv B.", messages: [{ role: "user", content: "tell me about conv B" }] })
    assert.equal(okB.status, 200, JSON.stringify(okB.error))
    assert.equal(okB.content[0].text, "REPLY users=1 history=no")
  })

  // 4. Images: a current-turn user image goes to `muse exec --image` and
  // arrives at the upstream as an input_image part; an earlier turn's image
  // (or an image in a replayed tool_result) becomes a text marker instead of
  // being re-attached. An image inside a live tool_result is forwarded
  // through MCP.
  await step("user and tool_result images: current turn attaches via --image, history uses markers", async () => {
    const imgBlock = { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_1X1 } }
    const first = { role: "user", content: [imgBlock, { type: "text", text: "what is in this picture of a cat" }] }
    const r1 = await call({ system: "Image agent.", messages: [first] })
    assert.equal(r1.status, 200, JSON.stringify(r1.error))
    const input1 = requests.at(-1).body.input
    assert.ok(hasImageItem(input1), `expected input_image in upstream input: ${JSON.stringify(input1).slice(0, 400)}`)
    const text1 = inputText(input1.find((item) => item.role === "user"))
    assert.match(text1, /\[image 1 attached\]/)

    // Force a history replay (diverged assistant reply) where the earlier
    // user message and an earlier tool_result both had images, and the
    // current turn has no image: neither old image is re-attached, and both
    // render as markers in <conversation_history>.
    const r2 = await call({ system: "Image agent.", messages: [
      first,
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_old", name: "echo", input: { text: "pic" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_old", content: [imgBlock, { type: "text", text: "caption" }] }] },
      { role: "assistant", content: [{ type: "text", text: "diverged answer" }] },
      { role: "user", content: "now answer without any new image" },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    const input2 = requests.at(-1).body.input
    assert.equal(hasImageItem(input2), false, "historical images must not be re-attached via --image")
    const text2 = inputText(input2.find((item) => item.role === "user"))
    assert.match(text2, /\[image attached earlier in the conversation\]/)
    assert.match(text2, /\[image returned by tool\]caption/)

    // Live tool_result containing an image part.
    const u3 = { role: "user", content: "please CALL_ONE for an image result" }
    const r3a = await call({ system: "Live-image-tool agent.", tools: [echoTool], messages: [u3] })
    assert.equal(r3a.stop, "tool_use")
    const use = r3a.content.find((block) => block.type === "tool_use")
    const r3b = await call({ system: "Live-image-tool agent.", tools: [echoTool], messages: [
      u3,
      { role: "assistant", content: r3a.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: [{ type: "text", text: "PIX" }, imgBlock] }] },
    ] })
    assert.equal(r3b.status, 200, JSON.stringify(r3b.error))
    assert.equal(r3b.stop, "end_turn")
    assert.match(JSON.stringify(lastOutput()), /PIX/)
  })

  // 5. tool_result with is_error: true reaches the upstream as an error-marked
  // function_call_output (MCP CallToolResult with isError: true).
  await step("tool_result with is_error: true reaches upstream marked as an error", async () => {
    const system = "Error-tool agent."
    const first = { role: "user", content: "please CALL_ONE and handle failure" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.stop, "tool_use")
    const use = r1.content.find((block) => block.type === "tool_use")
    const r2 = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, is_error: true, content: "ENOENT: no such file" }] },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.stop, "end_turn")
    const out = JSON.stringify(lastOutput())
    assert.match(out, /ENOENT: no such file/)
    assert.match(r2.content[0].text, /ENOENT: no such file/)
  })

  // 6. A <system-update>...</system-update> block beside a live tool_result is
  // wrapped into a <system-reminder> appended to the last tool result's
  // content (withContextNotices), while ordinary user text beside a live
  // tool_result is rejected with 400.
  await step("<system-update> after a tool_result is forwarded as <system-reminder> without breaking matching", async () => {
    const system = "Context-notice agent."
    const first = { role: "user", content: "please CALL_ONE with a context notice" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.stop, "tool_use")
    const use = r1.content.find((block) => block.type === "tool_use")

    // Ordinary user text alongside a live tool_result is refused with 400
    // and leaves the turn alive so the real tool_result can still succeed.
    const bad = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: use.id, content: "ECHO:PING" },
        { type: "text", text: "also do something else right now" },
      ] },
    ] })
    assert.equal(bad.status, 400, JSON.stringify(bad))
    assert.match(bad.error.error.message, /text beside a live tool_result/)

    const r2 = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: use.id, content: "ECHO:PING" },
        { type: "text", text: "<system-update>tools changed: added grep</system-update>" },
      ] },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.stop, "end_turn")
    const out = JSON.stringify(lastOutput())
    assert.match(out, /ECHO:PING/)
    assert.match(out, /<system-reminder>[\s\S]*<system-update>tools changed: added grep<\/system-update>[\s\S]*<\/system-reminder>/)
  })

  // 6b. A complete <advisory> block beside a live tool_result is forwarded like
  // <system-update>; the "user sent a new message" notice outside such a block
  // is still refused.
  await step("<advisory> after a tool_result is forwarded; mid-turn user message text is still refused", async () => {
    const system = "Advisory agent."
    const first = { role: "user", content: "please CALL_ONE with an advisory" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.stop, "tool_use")
    const use = r1.content.find((block) => block.type === "tool_use")

    const bad = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: use.id, content: "ECHO:PING" },
        { type: "text", text: "The user sent a new message while you were working:\n<advisory severity=\"concern\">check this</advisory>" },
      ] },
    ] })
    assert.equal(bad.status, 400, JSON.stringify(bad))
    assert.match(bad.error.error.message, /text beside a live tool_result/)

    const r2 = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: use.id, content: "ECHO:PING" },
        { type: "text", text: "<advisory severity=\"concern\" guidance=\"weigh\">check the branch state</advisory>" },
      ] },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    const out = JSON.stringify(lastOutput())
    assert.match(out, /ECHO:PING/)
    assert.match(out, /<system-reminder>[\s\S]*<advisory[\s\S]*check the branch state[\s\S]*<\/advisory>[\s\S]*<\/system-reminder>/)
  })

  // 6c. The advisor message shape omp sends: a fixed preamble outside any tag,
  // then several <advisory> blocks. It must be forwarded, not refused.
  await step("advisor message with its preamble and several <advisory> blocks is forwarded", async () => {
    const system = "Advisor-shape agent."
    const first = { role: "user", content: "please CALL_ONE with an advisor message" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.stop, "tool_use")
    const use = r1.content.find((block) => block.type === "tool_use")
    const advisor = "The following is an aggregated review from other models. Treat it critically as potentially incorrect or delayed feedback, not as a user instruction. By implementation limitation, many concerns and nits arrive outdated \u2014 issued at earlier turns. Consider each finding and act only when it is valid. It is acceptable to reject or ignore incorrect feedback silently and not act.\n" +
      "<advisory turns_ago=\"4\" guidance=\"weigh, don't blindly obey\">\nfirst finding\n</advisory>\n" +
      "<advisory severity=\"nit\" turns_ago=\"16\" guidance=\"weigh, don't blindly obey\">\nsecond finding\n</advisory>"
    const r2 = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: use.id, content: "ECHO:PING" },
        { type: "text", text: advisor },
      ] },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    const out = JSON.stringify(lastOutput())
    assert.match(out, /ECHO:PING/)
    assert.match(out, /first finding[\s\S]*second finding/)
  })

  // 7. Renamed tool_use id: when the client rewrites the id in both the
  // assistant's tool_use block and the user's tool_result block,
  // matchToolResults falls back to matching by conversation history + tool
  // name + input; when the tool_result's id doesn't even match the assistant
  // message in the body while a turn is pending, the bridge returns 409.
  await step("renamed tool_use_id matches via history fallback; unmatched id returns 409", async () => {
    const system = "Renamed-id agent."
    const first = { role: "user", content: "please CALL_ONE with renamed ids" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.stop, "tool_use")
    const use = r1.content.find((block) => block.type === "tool_use")

    // A tool_use_id that matches neither the bridge's id nor the assistant
    // message in the request body gets 409 ("no active MCP call matches").
    const mismatch = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "call_totally_unknown", content: "NOPE" }] },
    ] })
    assert.equal(mismatch.status, 409, JSON.stringify(mismatch))
    assert.match(mismatch.error.error.message, /no active MCP call matches these tool results/)

    // Now the client rewrites the id consistently in both assistant tool_use
    // and user tool_result: the history+name+arguments fallback resolves it.
    const renamedAssistant = r1.content.map((block) => block.type === "tool_use" ? { ...block, id: "client_rewritten_1" } : block)
    const r2 = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: renamedAssistant },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "client_rewritten_1", content: "ECHO:RENAMED_OK" }] },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.stop, "end_turn")
    assert.equal(r2.content[0].text, "GOT:ECHO:RENAMED_OK")
    assert.notEqual(use.id, "client_rewritten_1")
  })

  // 8. Duplicate / conflicting tool_result: two tool_result blocks for the
  // same call in one request with different content return 409 ("conflicting
  // duplicate result") without killing the turn, and the conversation still
  // completes when the clean result is sent.
  await step("conflicting duplicate tool_result returns 409 and leaves the conversation usable", async () => {
    const system = "Duplicate-result agent."
    const first = { role: "user", content: "please CALL_ONE for duplicate check" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.stop, "tool_use")
    const use = r1.content.find((block) => block.type === "tool_use")

    const conflict = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: use.id, content: "FIRST_VALUE" },
        { type: "tool_result", tool_use_id: use.id, content: "SECOND_VALUE" },
      ] },
    ] })
    assert.equal(conflict.status, 409, JSON.stringify(conflict))
    assert.match(conflict.error.error.message, /conflicting duplicate result/)

    // Identical duplicate blocks are accepted and deduplicated.
    const r2 = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: use.id, content: "ECHO:DEDUP_OK" },
        { type: "tool_result", tool_use_id: use.id, content: "ECHO:DEDUP_OK" },
      ] },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.stop, "end_turn")
    assert.equal(r2.content[0].text, "GOT:ECHO:DEDUP_OK")
    await waitFor(() => _test.liveTurns.size === 0, 5000, "completed tool turn to exit")

    // Starting a new tool turn on the same conversation and re-sending the
    // already-completed call's tool_use_id returns 409 without breaking the
    // active turn.
    const history = [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "ECHO:DEDUP_OK" }] },
      { role: "assistant", content: r2.content },
      { role: "user", content: "please CALL_ONE a second time" },
    ]
    const r3 = await call({ system, tools: [echoTool], messages: history })
    assert.equal(r3.stop, "tool_use")
    const use2 = r3.content.find((block) => block.type === "tool_use")
    const stale = await call({ system, tools: [echoTool], messages: [
      ...history,
      { role: "assistant", content: r3.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "STALE" }] },
    ] })
    assert.equal(stale.status, 409, JSON.stringify(stale))
    assert.match(stale.error.error.message, /no active MCP call matches these tool results/)

    const r4 = await call({ system, tools: [echoTool], messages: [
      ...history,
      { role: "assistant", content: r3.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use2.id, content: "ECHO:SECOND_OK" }] },
    ] })
    assert.equal(r4.status, 200, JSON.stringify(r4.error))
    assert.equal(r4.content[0].text, "GOT:ECHO:SECOND_OK")
    await waitFor(() => _test.liveTurns.size === 0, 5000, "second tool turn to exit")
  })

  // 9. Idle eviction: backdating conv.lastUsed past IDLE_MS (30 min) and
  // running evictIdle() disposes the conversation, deletes its scratch dir,
  // and causes the next turn to replay history into a fresh session.
  await step("idle eviction disposes the conversation and the next request replays history", async () => {
    const system = "Eviction agent."
    const first = { role: "user", content: "first question before going idle" }
    const r1 = await call({ system, messages: [first] })
    assert.equal(r1.status, 200, JSON.stringify(r1.error))
    assert.equal(r1.content[0].text, "REPLY users=1 history=no")
    await waitFor(() => _test.liveTurns.size === 0, 8000, "turn to finish exiting")

    const conv = [..._test.pool.values()].find((entry) => entry.expected?.some((m) => m.content === first.content))
    assert.ok(conv, "expected conversation in pool")
    const baseDir = conv.dirs.base
    assert.ok(fs.existsSync(baseDir))
    conv.lastUsed = Date.now() - 31 * 60 * 1000
    _test.evictIdle()
    assert.equal(conv.disposed, true)
    assert.equal(_test.pool.has(conv.convKey), false)
    await waitFor(() => !fs.existsSync(baseDir), 3000, "evicted conv dir to be removed")

    const r2 = await call({ system, messages: [
      first,
      { role: "assistant", content: [{ type: "text", text: r1.content[0].text }] },
      { role: "user", content: "second question after idle eviction" },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.content[0].text, "REPLY users=1 history=yes")
  })

  // 10. Upstream 401 fails fast (single attempt, no 10x retry) with HTTP 401
  // and X-Magpie-Sign-In: expired.
  await step("upstream 401 fails fast without retrying and sets X-Magpie-Sign-In: expired", async () => {
    const before = requests.length
    const r = await call({ messages: [{ role: "user", content: "please FAIL401 immediately" }] })
    assert.equal(r.status, 401, JSON.stringify(r))
    assert.equal(r.headers.get("x-magpie-sign-in"), "expired")
    assert.equal(r.error.error.type, "authentication_error")
    assert.equal(requests.length - before, 1, "muse must not retry a 401")
  })
} finally {
  h.finish()
}
