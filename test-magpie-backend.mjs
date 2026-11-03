// Opt-in integration test: real `muse exec --json` + bridge + MCP helper
// against the local Magpie gateway at http://127.0.0.1:3425/v1.
//
//   MUSE_TEST_MAGPIE=1 MUSE_TEST_BIN=/path/to/muse node test-magpie-backend.mjs
//
// Skips by default so `npm test` never spends real tokens.
import assert from "node:assert/strict"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { echoTool, findMuseBin, parseSSE, waitFor } from "./test-harness.mjs"

if (process.env.MUSE_TEST_MAGPIE !== "1") {
  console.log("skip: set MUSE_TEST_MAGPIE=1 to run against http://127.0.0.1:3425")
  process.exit(0)
}

const bin = findMuseBin()
if (!bin) {
  console.log("skip: muse CLI not found (set MUSE_TEST_BIN)")
  process.exit(0)
}

const MAGPIE_ORIGIN = process.env.MUSE_TEST_MAGPIE_ORIGIN || "http://127.0.0.1:3425"
const CANDIDATES = ["auto/claude-haiku-5-5", "auto/deepseek-v4.1-flash"]

// Confirm the gateway is up and pick a cheap non-muse-bridge model from
// /muse-code/models.
const catalogRes = await fetch(`${MAGPIE_ORIGIN}/muse-code/models`)
assert.equal(catalogRes.status, 200, `GET ${MAGPIE_ORIGIN}/muse-code/models failed: ${catalogRes.status}`)
const catalog = await catalogRes.json()
const ids = new Set((catalog.data || []).map((entry) => entry.id))
const model = CANDIDATES.find((id) => ids.has(id))
assert.ok(model, `none of ${CANDIDATES.join(", ")} found in ${MAGPIE_ORIGIN}/muse-code/models`)
assert.ok(!model.includes("muse-bridge"), `refusing to loop through muse-bridge model ${model}`)

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "muse-bridge-magpie-"))

// muse 1.4.13 sends MCP tools to /v1/responses inside a
// `{ type: "namespace", name: "mcp__magpie", tools: [...] }` wrapper, but its
// stream parser ignores `function_call.namespace` and requires
// `function_call.name` to be the flat `mcp__magpie__<tool>`. Magpie's
// /v1/responses translator (internal/gateway/responses.go:1746) splits a
// namespaced tool back into `{ name: "<tool>", namespace: "mcp__magpie" }`
// for Codex. Flattening the namespace on the way into Magpie keeps
// `function_call.name` as `mcp__magpie__<tool>` while still exercising real
// Magpie /v1/responses streaming and tool calls end to end.
let upstreamCalls = 0
const forwarder = http.createServer((req, res) => {
  const chunks = []
  req.on("data", (chunk) => chunks.push(chunk))
  req.on("end", async () => {
    let body = Buffer.concat(chunks)
    if (req.method === "POST" && req.url?.endsWith("/responses") && body.length) {
      upstreamCalls++
      const parsed = JSON.parse(body.toString("utf8"))
      if (Array.isArray(parsed.tools)) {
        parsed.tools = parsed.tools.flatMap((tool) => tool?.type === "namespace" && Array.isArray(tool.tools)
          ? tool.tools.map((inner) => ({ ...inner, name: `${tool.name}__${inner.name}` }))
          : [tool])
      }
      body = Buffer.from(JSON.stringify(parsed))
    }
    const headers = { ...req.headers, host: new URL(MAGPIE_ORIGIN).host, "content-length": String(body.length) }
    const up = await fetch(`${MAGPIE_ORIGIN}${req.url}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    })
    res.writeHead(up.status, { "content-type": up.headers.get("content-type") || "application/json" })
    if (!up.body) { res.end(); return }
    for await (const chunk of up.body) res.write(chunk)
    res.end()
  })
})
await new Promise((resolve) => forwarder.listen(0, "127.0.0.1", resolve))

process.env.XDG_CONFIG_HOME = path.join(tmp, "user-config")
process.env.TMPDIR = path.join(tmp, "tmpdir")
process.env.MUSE_PATH = bin
process.env.MUSE_NO_AUTO_UPDATE = "1"
process.env.META_API_KEY = "magpie-local"
process.env.MUSE_BRIDGE_BASE_URL = `http://127.0.0.1:${forwarder.address().port}/v1`
fs.mkdirSync(process.env.TMPDIR, { recursive: true })
fs.mkdirSync(path.join(tmp, "user-config", "muse"), { recursive: true })

const { MuseBridgePlugin, _test } = await import("./index.mjs")
const plugin = await MuseBridgePlugin()
const { fetch: bridgeFetch } = await plugin.auth.loader()

let requestCount = 0
const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 }

async function call(body) {
  requestCount++
  const res = await bridgeFetch("muse://local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-work-dir": encodeURIComponent(tmp) },
    body: JSON.stringify({ model, max_tokens: 256, stream: true, ...body }),
  })
  if (!res.headers.get("content-type")?.includes("text/event-stream")) {
    return { status: res.status, headers: res.headers, error: await res.json() }
  }
  const parsed = parseSSE(await res.text())
  if (parsed.usage) {
    totals.input_tokens += parsed.usage.input_tokens || 0
    totals.output_tokens += parsed.usage.output_tokens || 0
    totals.cache_read_input_tokens += parsed.usage.cache_read_input_tokens || 0
  }
  return { status: res.status, headers: res.headers, ...parsed }
}

const results = []
async function step(name, fn) {
  const started = Date.now()
  try {
    await fn()
    results.push(`ok   ${name} (${Date.now() - started}ms)`)
  } catch (error) {
    results.push(`FAIL ${name}: ${error.stack || error}`)
  }
}

try {
  const firstUser = {
    role: "user",
    content: "In one short sentence, explain why binary search requires a sorted array, and include the exact word MIDPOINT.",
  }
  let firstAssistant

  await step(`plain text turn + streaming usage (${model})`, async () => {
    const r = await call({ system: "You are a concise test assistant.", messages: [firstUser] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.stop, "end_turn")
    const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    assert.match(text, /midpoint/i, `expected MIDPOINT in ${JSON.stringify(text)}`)
    assert.ok(r.usage && r.usage.input_tokens > 0 && r.usage.output_tokens > 0, `expected positive usage, got ${JSON.stringify(r.usage)}`)
    firstAssistant = r.content
  })

  await step("second turn in the same conversation resumes the muse session", async () => {
    const r = await call({
      system: "You are a concise test assistant.",
      messages: [
        firstUser,
        { role: "assistant", content: firstAssistant },
        { role: "user", content: "What was the exact capitalized keyword I asked you to include in your previous sentence? Reply with that single word only." },
      ],
    })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.stop, "end_turn")
    const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    assert.match(text, /midpoint/i, `expected recalled keyword MIDPOINT in ${JSON.stringify(text)}`)
    assert.ok(r.usage && r.usage.input_tokens > 0 && r.usage.output_tokens > 0, `expected positive usage, got ${JSON.stringify(r.usage)}`)
  })

  await step("MCP tool call round trip through the bridge", async () => {
    const system = "Do not write any text before calling a tool. Call the requested tool immediately, then reply with only the tool output."
    const userPrompt = {
      role: "user",
      content: "Invoke mcp__magpie__echo with {\"text\": \"MAGPIE_ECHO_739\"} right now with no commentary before the call, then output the tool result.",
    }
    const r1 = await call({ system, tools: [echoTool], messages: [userPrompt] })
    assert.equal(r1.status, 200, JSON.stringify(r1.error))
    assert.equal(r1.stop, "tool_use", `expected tool_use, got ${JSON.stringify(r1)}`)
    const use = r1.content.find((block) => block.type === "tool_use")
    assert.ok(use, "expected tool_use block")
    assert.equal(use.name, "echo")
    assert.deepEqual(use.input, { text: "MAGPIE_ECHO_739" })

    const r2 = await call({
      system,
      tools: [echoTool],
      messages: [
        userPrompt,
        { role: "assistant", content: r1.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "PONG_739_VERIFIED" }] },
      ],
    })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.stop, "end_turn", JSON.stringify(r2))
    const text = r2.content.filter((b) => b.type === "text").map((b) => b.text).join("")
    assert.match(text, /PONG_739_VERIFIED/, `expected echoed tool output in ${JSON.stringify(text)}`)
    assert.ok(r2.usage && r2.usage.input_tokens > 0 && r2.usage.output_tokens > 0, `expected positive usage, got ${JSON.stringify(r2.usage)}`)
  })

  await waitFor(() => _test.liveTurns.size === 0, 8000, "liveTurns to drain")
  results.push(`     (model=${model} bridge_requests=${requestCount} upstream_responses=${upstreamCalls} input_tokens=${totals.input_tokens} output_tokens=${totals.output_tokens} cache_read_input_tokens=${totals.cache_read_input_tokens})`)
} finally {
  forwarder.close()
  for (const conv of [..._test.pool.values()]) conv.dispose()
  setTimeout(() => fs.rmSync(tmp, { recursive: true, force: true }), 500)
  console.log(results.join("\n"))
  const failed = results.some((line) => line.startsWith("FAIL"))
  setTimeout(() => process.exit(failed ? 1 : 0), 800)
}
