// Default: real @muse-code/sdk transport + deterministic MSP host + real MCP
// helper. MUSE_TEST_BIN runs the same happy-path checks with the real Muse host
// against test-harness's local fake Meta upstream (no login or paid inference).
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { startHarness, echoTool } from "./test-harness.mjs"

const real = Boolean(process.env.MUSE_TEST_BIN)
const fixture = fileURLToPath(new URL("./test/fixtures/fake-muse.mjs", import.meta.url))
const h = await startHarness({ bin: process.env.MUSE_TEST_BIN || fixture, env: {
  MUSE_BRIDGE_TRANSPORT: "sdk",
  MUSE_BRIDGE_TURN_TIMEOUT_MS: real ? "30000" : "3000",
  MUSE_BRIDGE_TOOL_TIMEOUT_MS: process.env.MUSE_TEST_SLOW === "1" ? "180000" : "3000",
  MUSE_BRIDGE_FIRST_EVENT_MS: "8000",
} })
const { call, request, step, readLogs, _test } = h
const user = (text) => ({ role: "user", content: text })
const assistant = (content) => ({ role: "assistant", content })
const getConv = (text) => [..._test.pool.values()].find((c) => c.expected?.some((m) => m.role === "user" && m.content === text))
const successful = (r) => { assert.equal(r.status, 200, JSON.stringify(r.error)); assert.equal(r.stop, "end_turn", JSON.stringify(r)) }
const result = (use, text) => ({ type: "tool_result", tool_use_id: use.id, content: text })
const orderedTool = {
  name: "ordered",
  description: "A tool whose schema is used to test canonical comparison",
  input_schema: {
    type: "object",
    properties: { alpha: { type: "string" }, beta: { type: "number" } },
    required: ["alpha"],
  },
}

try {
  let first, firstId, runtime
  await step("SDK streams final text and real provider usage without duplicate final text", async () => {
    first = await call({ messages: [user("sdk apples")] })
    successful(first)
    assert.equal(first.content[0].text, "REPLY users=1 history=no")
    assert.deepEqual(first.usage, { input_tokens: 60, output_tokens: 7, cache_read_input_tokens: 40, output_tokens_details: { thinking_tokens: 3 } })
    const conv = getConv("sdk apples")
    firstId = conv.sessionId; runtime = conv.runtime
    assert.ok(firstId)
    assert.equal(runtime.host.initializeResult.experimentalApi, false)
    if (real) assert.equal(h.requests.filter((r) => r.body?.input).length, 1, "plain turn must not spawn observer inference")
  })
  let second
  await step("second turn reuses the same SDK host and native session", async () => {
    second = await call({ messages: [user("sdk apples"), assistant(first.content), user("sdk pears")] })
    const r = second
    successful(r)
    assert.equal(r.content[0].text, "REPLY users=2 history=no")
    assert.equal(getConv("sdk apples").sessionId, firstId)
    assert.equal(getConv("sdk apples").runtime, runtime)
  })
  await step("model changes reuse the SDK session through session/setModel", async () => {
    const conv = getConv("sdk apples"), id = conv.sessionId, host = conv.runtime
    const r = await call({ model: "muse-spark-1.2", output_config: { effort: "high" },
      messages: [user("sdk apples"), assistant(first.content), user("sdk pears"), assistant(second.content), user("sdk model switch")] })
    successful(r)
    assert.equal(conv.sessionId, id); assert.equal(conv.runtime, host)
    assert.equal(conv.model, "muse-spark-1.2")
    const logs = readLogs()
    if (!real) {
      assert.ok(logs.some(row => row.type === "rpc" && row.method === "session/setModel" && row.params.model.modelId === "muse-spark-1.2"))
      assert.ok(logs.some(row => row.type === "rpc" && row.method === "turn/start" && row.params.reasoningEffort === "high"))
      assert.equal(logs.filter(row => row.type === "rpc" && row.method === "session/start" && row.params.modelId === "muse-spark-1.2").length, 0)
    }
  })
  await step("changed caller history creates a fresh SDK session with replay", async () => {
    const r = await call({ messages: [user("sdk apples"), assistant([{ type: "text", text: "edited answer" }]), user("sdk plums")] })
    successful(r)
    assert.equal(r.content[0].text, "REPLY users=1 history=yes")
    assert.notEqual(getConv("sdk apples").sessionId, firstId)
  })
  await step("SDK MCP call parks across HTTP requests and continues the same turn", async () => {
    const messages = [user("sdk CALL_ONE")]
    const r = await call({ tools: [echoTool], messages })
    assert.equal(r.status, 200, JSON.stringify(r.error)); assert.equal(r.stop, "tool_use")
    const use = r.content.find((b) => b.type === "tool_use")
    assert.equal(use.name, "echo"); assert.deepEqual(use.input, { text: "PING" })
    const conv = getConv("sdk CALL_ONE"), id = conv.sessionId, turn = conv.turn
    assert.ok(turn && !turn.done)
    const settings = JSON.parse(fs.readFileSync(path.join(conv.dirs.config, "muse/settings.json"), "utf8"))
    assert.ok(settings.mcpServers.magpie.tool_timeout_sec >= 63)
    const next = await call({ tools: [echoTool], messages: [...messages, assistant(r.content), { role: "user", content: [result(use, "PONG SDK")] }] })
    successful(next); assert.equal(next.content[0].text, "GOT:PONG SDK")
    assert.equal(conv.sessionId, id); assert.equal(conv.turn, null)
    assert.equal(_test.toolCalls.size, 0)
  })
  await step("MCP tool-result errors are returned to Muse as tool errors", async () => {
    const messages = [user("sdk error CALL_ONE")]
    const r = await call({ tools: [echoTool], messages })
    assert.equal(r.stop, "tool_use", JSON.stringify(r))
    const use = r.content.find((b) => b.type === "tool_use")
    const next = await call({ tools: [echoTool], messages: [...messages, assistant(r.content), {
      role: "user", content: [{ ...result(use, "EXPECTED TOOL FAILURE"), is_error: true }],
    }] })
    successful(next); assert.match(next.content[0].text, /EXPECTED TOOL FAILURE/)
  })
  await step("parallel SDK tools correlate results and reject conflicting duplicates", async () => {
    const messages = [user("sdk CALL_TWO")]
    let r = await call({ tools: [echoTool], messages }), count = 0
    for (let i = 0; i < 4 && r.stop === "tool_use"; i++) {
      const uses = r.content.filter((b) => b.type === "tool_use")
      count += uses.length
      assert.ok(uses.length)
      const results = uses.map((u) => result(u, `ECHO:${u.input.text}`))
      const bad = await call({ tools: [echoTool], messages: [...messages, assistant(r.content), { role: "user", content: [...results, result(uses[0], "CONFLICT")] }] })
      assert.equal(bad.status, 409)
      messages.push(assistant(r.content), { role: "user", content: results })
      r = await call({ tools: [echoTool], messages })
    }
    successful(r); assert.equal(count, 2); assert.match(r.content[0].text, /^GOT:/)
  })
  await step("changed tool schema reloads the SDK session", async () => {
    const messages = [user("sdk schema change")]
    const a = await call({ tools: [echoTool], messages }); successful(a)
    const id = getConv("sdk schema change").sessionId
    const b = await call({ tools: [{ ...echoTool, description: "new schema description" }], messages: [...messages, assistant(a.content), user("continue")] })
    successful(b); assert.notEqual(getConv("sdk schema change").sessionId, id)
    assert.match(b.content[0].text, /history=yes/)
  })
  await step("equivalent tool schemas with reordered object keys keep the SDK session", async () => {
    const messages = [user("sdk equivalent schema")]
    const a = await call({ tools: [orderedTool], messages }); successful(a)
    const conv = getConv("sdk equivalent schema"), id = conv.sessionId
    const equivalent = {
      ...orderedTool,
      input_schema: {
        required: ["alpha"],
        properties: { beta: { type: "number" }, alpha: { type: "string" } },
        type: "object",
      },
    }
    const b = await call({ tools: [equivalent], messages: [...messages, assistant(a.content), user("continue equivalent schema")] })
    successful(b); assert.equal(conv.sessionId, id); assert.doesNotMatch(b.content[0].text, /history=yes/)
  })
  await step("SDK current-turn images are sent as image parts", async () => {
    const r = await call({ messages: [{ role: "user", content: [{ type: "text", text: "sdk image" }, {
      type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFgAJ/wlvq3AAAAABJRU5ErkJggg==" },
    }] }] }); successful(r)
    if (real) assert.ok(h.requests.some((r) => JSON.stringify(r.body.input).includes("input_image")))
  })
  if (real) {
    if (process.env.MUSE_TEST_SLOW === "1") {
      await step("real SDK tool call remains pending across a 75-second client operation", async () => {
        const messages = [user("SDK slow CALL_ONE")]
        const r = await call({ tools: [echoTool], messages }); assert.equal(r.stop, "tool_use")
        const conv = getConv("SDK slow CALL_ONE"), id = conv.sessionId
        await new Promise((resolve) => setTimeout(resolve, 75000))
        assert.ok(conv.turn && !conv.turn.done)
        const use = r.content.find((b) => b.type === "tool_use")
        const next = await call({ tools: [echoTool], messages: [...messages, assistant(r.content), {
          role: "user", content: [result(use, "LONG SDK RESULT")],
        }] })
        successful(next); assert.equal(next.content[0].text, "GOT:LONG SDK RESULT"); assert.equal(conv.sessionId, id)
      })
    }
    await step("real host exposes only configured MCP tools with empty preset", async () => {
      const calls = h.requests.filter((r) => r.body?.input)
      assert.ok(calls.length)
      for (const r of calls) {
        for (const tool of r.body.tools || []) {
          assert.equal(tool.name, "mcp__magpie", JSON.stringify(r.body.tools))
          // The equivalent-schema regression uses a second local tool later;
          // every advertised nested tool must be one the caller supplied for
          // that request, not a bundled Muse tool.
          assert.ok(tool.tools?.every((t) => ["echo", "ordered"].includes(t.name)))
        }
      }
    })
    await step("durable SDK session resumes after an idle host shutdown", async () => {
      const messages = [user("sdk durable resume")]
      const a = await call({ messages }); successful(a)
      const conv = getConv("sdk durable resume"), id = conv.sessionId
      await conv.runtime.host.close()
      const b = await call({ messages: [...messages, assistant(a.content), user("continued after host shutdown")] })
      successful(b); assert.equal(conv.sessionId, id); assert.equal(b.content[0].text, "REPLY users=2 history=no")
    })
    await step("real SDK host exposes an upstream auth failure as HTTP 401", async () => {
      const r = await call({ messages: [user("SDK upstream FAIL401")] })
      assert.equal(r.status, 401, JSON.stringify(r)); assert.equal(r.headers.get("X-Magpie-Sign-In"), "expired")
      successful(await call({ messages: [user("after real auth failure")] }))
    })
  } else {
    await step("an accepted queued turn waits for its own events without resubmitting", async () => {
      const r = await call({ messages: [user("SDK_QUEUE")] })
      successful(r); assert.equal(r.content[0].text, "REPLY users=1 history=no")
    })
    await step("SDK JPEG aliases are normalized before model admission", async () => {
      const r = await call({ messages: [{ role: "user", content: [
        { type: "text", text: "SDK_CHECK_JPEG" },
        { type: "image", source: { type: "base64", media_type: "image/jpg", data: "ZmFrZSBqcGVnIGZvciBNU1AgZml4dHVyZQ==" } },
      ] }] })
      successful(r)
    })
    await step("SDK refresh writes back immediately on successful and failed turns", async () => {
      for (const text of ["SDK_REFRESH_AUTH", "SDK_REFRESH_AUTH SDK_AUTH"]) {
        const r = await call({ messages: [user(text)] })
        assert.equal(r.status, text.includes("SDK_AUTH") ? 401 : 200)
        const target = path.join(process.env.XDG_CONFIG_HOME, "muse/auth.json")
        assert.ok(JSON.parse(fs.readFileSync(target, "utf8")).fixtureCredential)
        const conv = [..._test.pool.values()].find(c => c.convKey === _test.conversationKey({ messages: [user(text)] }, "muse-spark-1.3"))
        assert.ok(fs.lstatSync(path.join(conv.dirs.config, "muse/auth.json")).isSymbolicLink())
      }
    })
    await step("SDK idle exit synchronizes refreshed sign-in without eviction", async () => {
      const a = await call({ messages: [user("idle auth fixture")] }); successful(a)
      const conv = getConv("idle auth fixture")
      const local = path.join(conv.dirs.config, "muse/auth.json")
      fs.unlinkSync(local)
      fs.writeFileSync(local, JSON.stringify({ fixtureCredential: "idle-host-refresh" }))
      await conv.runtime.host.close()
      const target = path.join(process.env.XDG_CONFIG_HOME, "muse/auth.json")
      assert.equal(JSON.parse(fs.readFileSync(target, "utf8")).fixtureCredential, "idle-host-refresh")
      assert.ok(fs.lstatSync(local).isSymbolicLink())
    })
    await step("lost ephemeral session replays full caller history in the same request", async () => {
      const messages = [user("SDK ephemeral history")]
      const a = await call({ messages }); successful(a)
      const conv = getConv("SDK ephemeral history"), id = conv.sessionId
      await conv.runtime.host.close()
      const b = await call({ messages: [...messages, assistant(a.content), user("after missing session")] })
      successful(b); assert.notEqual(conv.sessionId, id)
      assert.equal(b.content[0].text, "REPLY users=1 history=yes")
    })
    await step("resume refusal for an owned session never starts a duplicate turn", async () => {
      const messages = [user("SDK busy resume")]
      const a = await call({ messages }); successful(a)
      const conv = getConv("SDK busy resume")
      conv.runtime.options.env.MUSE_SDK_TEST_RESUME_BUSY = "1"
      await conv.runtime.host.close()
      const b = await call({ messages: [...messages, assistant(a.content), user("must not replay")] })
      assert.equal(b.status, 502); assert.match(b.error.error.message, /different host/)
    })
    await step("reused host diagnostics belong to the current failing turn", async () => {
      const messages = [user("SDK stderr history")]
      const a = await call({ messages }); successful(a)
      const b = await call({ messages: [...messages, assistant(a.content), user("SDK_STDERR SDK_AUTH")] })
      assert.equal(b.status, 401); assert.match(b.error.error.message, /diagnostic for the current SDK turn/)
    })
    await step("SDK usage uses counted prompt totals and never adds terminal usage twice", async () => {
      const r = await call({ messages: [user("SDK_USAGE")] }); successful(r)
      assert.deepEqual(r.usage, { input_tokens: 120, output_tokens: 14, cache_read_input_tokens: 60,
        cache_creation_input_tokens: 10, output_tokens_details: { thinking_tokens: 6 } })
    })
    await step("auth and quota failures before output become HTTP 401/429", async () => {
      for (const [marker, status] of [["SDK_AUTH", 401], ["SDK_QUOTA", 429]]) {
        const r = await call({ messages: [user(marker)] }); assert.equal(r.status, status, JSON.stringify(r))
        if (status === 401) assert.equal(r.headers.get("X-Magpie-Sign-In"), "expired")
        assert.equal(_test.liveTurns.size, 0)
      }
    })
    await step("host death invalidates the turn and the next request recovers", async () => {
      const r = await call({ messages: [user("SDK_CRASH")] }); assert.equal(r.status, 502)
      assert.equal(_test.liveTurns.size, 0)
      successful(await call({ messages: [user("after host death")] }))
    })
    await step("mid-stream host loss or event gaps emit an error instead of a final answer", async () => {
      for (const marker of ["SDK_PARTIAL_CRASH", "SDK_GAP"]) {
        const r = await call({ messages: [user(marker)] })
        assert.equal(r.status, 200); assert.ok(r.error, JSON.stringify(r)); assert.notEqual(r.stop, "end_turn")
        assert.equal(_test.liveTurns.size, 0)
      }
      successful(await call({ messages: [user("after incomplete stream")] }))
    })
    await step("unsupported SDK requests are surfaced without exec fallback", async () => {
      const r = await call({ messages: [user("SDK_UNSUPPORTED")] }); assert.equal(r.status, 502)
      assert.equal(_test.liveTurns.size, 0)
    })
    await step("SDK capability denial fails closed before model admission", async () => {
      process.env.MUSE_SDK_TEST_DENY_CAP = "1"
      try {
        const r = await call({ messages: [user("capability denial")] })
        assert.equal(r.status, 502); assert.match(r.error.error.message, /sessionMcp/)
      } finally { delete process.env.MUSE_SDK_TEST_DENY_CAP }
    })
    await step("abort before model output releases SDK turn and host", async () => {
      const controller = new AbortController()
      const pending = request({ messages: [user("SDK_STALL")] }, { signal: controller.signal })
      setTimeout(() => controller.abort(), 100)
      const r = await pending; assert.equal(r.status, 499)
      assert.equal(_test.liveTurns.size, 0)
      successful(await call({ messages: [user("after abort")] }))
    })
    await step("SDK timeout releases the host and a subsequent turn recovers", async () => {
      const r = await call({ messages: [user("timeout SDK_STALL")] })
      assert.equal(r.status, 502); assert.match(r.error.error.message, /timed out/)
      assert.equal(_test.liveTurns.size, 0)
      successful(await call({ messages: [user("timeout recovered")] }))
    })
    await step("abandoning a pending MCP result closes the call and host", async () => {
      const controller = new AbortController()
      const res = await request({ tools: [echoTool], messages: [user("abandoned CALL_ONE")] }, { signal: controller.signal })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let stream = ""
      while (!stream.includes('"type":"tool_use"')) {
        const chunk = await reader.read(); assert.equal(chunk.done, false)
        stream += decoder.decode(chunk.value)
      }
      assert.ok(_test.toolCalls.size > 0)
      controller.abort()
      await reader.cancel().catch(() => {})
      assert.equal(_test.toolCalls.size, 0); assert.equal(_test.liveTurns.size, 0)
      successful(await call({ messages: [user("tool abort recovered")] }))
    })
  }
} finally {
  const conversations = [..._test.pool.values()]
  for (const conv of conversations) conv.dispose()
  await Promise.all(conversations.map((conv) => conv.runtimeClosing))
  h.finish()
}
