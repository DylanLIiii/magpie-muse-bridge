// Explicitly opt in: this uses the host's real Muse credential and model quota.
// No fake upstream or replacement credentials are installed.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { echoTool, parseSSE } from "./test-harness.mjs"

if (process.env.MUSE_TEST_LIVE !== "1") {
  console.log("skip: set MUSE_TEST_LIVE=1 to use the real Muse account and quota")
  process.exit(0)
}
if (process.env.MUSE_BRIDGE_BASE_URL) {
  throw new Error("Unset MUSE_BRIDGE_BASE_URL: this test must reach the real Meta backend")
}
if (process.env.MUSE_TEST_LIVE_ORIGIN) {
  throw new Error("This test requires the local plugin so it can dispose pending MCP turns on failure; gateway mode is not supported")
}
if (process.env.META_API_KEY) {
  throw new Error("Unset META_API_KEY to test the Muse browser sign-in; an environment API key would mask it")
}
const authPath = process.env.MUSE_AUTH_PATH || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "muse/auth.json")
let browserLogin = false
try { browserLogin = JSON.parse(fs.readFileSync(authPath, "utf8"))?.providers?.meta?.mechanism === "oauth" } catch {}
assert.ok(browserLogin, "This subscription smoke test requires an existing Muse browser sign-in; run `muse login` first")

const model = process.env.MUSE_TEST_MODEL || "muse-wonder-1.0"
const transport = process.env.MUSE_BRIDGE_TRANSPORT || "sdk"
const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" }
const { MuseBridgePlugin, _test: state } = await import("./index.mjs")
const request = (await (await MuseBridgePlugin()).auth.loader()).fetch
const marker = `MUSE_LIVE_${randomUUID().replaceAll("-", "").slice(0, 12)}`
const user = (content) => ({ role: "user", content })
const assistant = (content) => ({ role: "assistant", content })
const text = (r) => r.content.filter(b => b.type === "text").map(b => b.text).join("").trim()

async function call(body) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error("Live request exceeded 60 seconds")), 60_000)
  const started = Date.now()
  try {
    const res = await request("muse://local/v1/messages", {
      method: "POST", headers, signal: controller.signal,
      body: JSON.stringify({
        model,
        max_tokens: 256, stream: true, output_config: { effort: "minimal" }, ...body,
      }),
    })
    const raw = await res.text()
    assert.equal(res.status, 200, `HTTP ${res.status}: ${raw}`)
    assert.match(res.headers.get("content-type") || "", /text\/event-stream/, raw)
    const parsed = parseSSE(raw)
    assert.equal(parsed.error, null, `HTTP 200 SSE error: ${JSON.stringify(parsed.error)}`)
    console.log(`  response completed in ${Date.now() - started}ms; stop=${parsed.stop}`)
    return parsed
  } finally { clearTimeout(timer) }
}

async function step(name, fn) {
  console.log(`RUN ${name}`)
  await fn()
  console.log(`PASS ${name}`)
}

console.log(`Real Muse smoke test: model=${model}, transport=plugin ${transport}`)
console.log("Credential: existing Muse CLI browser sign-in (META_API_KEY unset)")
try {
  const first = user(`Remember this identifier: ${marker}. Reply with only that exact identifier.`)
  let reply
  await step("plain response and usage", async () => {
    reply = await call({ messages: [first] })
    assert.equal(reply.stop, "end_turn")
    assert.equal(text(reply), marker)
    assert.ok(reply.usage?.input_tokens > 0 && reply.usage?.output_tokens > 0, "Expected real token usage")
  })
  await step("second turn recalls conversation history", async () => {
    const r = await call({ messages: [first, assistant(reply.content), user("Repeat the exact identifier from my previous message. Output only the identifier.")] })
    assert.equal(r.stop, "end_turn")
    assert.equal(text(r), marker)
  })
  await step("MCP tool_use and tool_result round trip", async () => {
    const system = "Call the requested echo tool immediately. After receiving its result, output only that result."
    const messages = [user(`Call mcp__magpie__echo with {"text":"${marker}"}. Then return only the tool result.`)]
    const firstTool = await call({ system, tools: [echoTool], messages })
    assert.equal(firstTool.stop, "tool_use")
    const uses = firstTool.content.filter(b => b.type === "tool_use")
    assert.equal(uses.length, 1)
    assert.equal(uses[0].name, "echo")
    assert.deepEqual(uses[0].input, { text: marker })
    const verified = `VERIFIED_${marker}`
    const r = await call({ system, tools: [echoTool], messages: [
      ...messages, assistant(firstTool.content),
      user([{ type: "tool_result", tool_use_id: uses[0].id, content: verified }]),
    ] })
    assert.equal(r.stop, "end_turn")
    assert.equal(text(r), verified)
  })
} catch (error) {
  console.error(`FAIL ${error.message}`)
  process.exitCode = 1
} finally {
  const conversations = [...state.pool.values()]
  for (const conv of conversations) conv.dispose()
  await Promise.all(conversations.map(conv => conv.runtimeClosing))
}
