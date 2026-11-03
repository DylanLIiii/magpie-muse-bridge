// Integration test: the plugin driving a real `muse` binary against a fake
// Meta upstream, so no Meta sign-in is needed and nothing leaves the machine.
//
//   MUSE_TEST_BIN=/path/to/muse node test-real-muse.mjs
//
// Skips (exit 0) when no muse binary is given or found on PATH.
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { echoTool, findMuseBin, inputText, startHarness } from "./test-harness.mjs"

const bin = findMuseBin()
if (!bin) {
  console.log("skip: no muse binary (set MUSE_TEST_BIN)")
  process.exit(0)
}

const h = await startHarness({ bin })
const { tmp, requests, plugin, _test, call, step, results } = h

try {
  let a1
  await step("plain text turn", async () => {
    const r = await call({ messages: [{ role: "user", content: "first question about apples" }] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.stop, "end_turn")
    assert.equal(r.content[0].text, "REPLY users=1 history=no")
    assert.deepEqual(r.usage, { input_tokens: 60, output_tokens: 7, cache_read_input_tokens: 40, output_tokens_details: { thinking_tokens: 3 } })
    a1 = r.content[0].text
  })

  await step("next turn resumes the muse session", async () => {
    const r = await call({ messages: [
      { role: "user", content: "first question about apples" },
      { role: "assistant", content: [{ type: "text", text: a1 }] },
      { role: "user", content: "second question about pears" },
    ] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.content[0].text, "REPLY users=2 history=no")
    const input = requests.at(-1).body.input
    assert.ok(input.some((item) => item.role === "user" && inputText(item).includes("first question about apples")))
  })

  await step("diverged history replays into a new session", async () => {
    const r = await call({ messages: [
      { role: "user", content: "first question about apples" },
      { role: "assistant", content: [{ type: "text", text: "an answer muse never gave" }] },
      { role: "user", content: "third question about plums" },
    ] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    assert.equal(r.content[0].text, "REPLY users=1 history=yes")
  })

  await step("tool call round trip through MCP", async () => {
    const system = "You are a test agent."
    const first = { role: "user", content: "please CALL_ONE now" }
    const r1 = await call({ system, tools: [echoTool], messages: [first] })
    assert.equal(r1.status, 200, JSON.stringify(r1.error))
    assert.equal(r1.stop, "tool_use")
    const use = r1.content.find((block) => block.type === "tool_use")
    assert.equal(use.name, "echo")
    assert.deepEqual(use.input, { text: "PING" })
    const tools = requests.at(-1).body.tools
    assert.ok(tools.some((tool) => tool.name === "mcp__magpie" && tool.tools?.some((t) => t.name === "echo")), JSON.stringify(tools).slice(0, 400))
    const r2 = await call({ system, tools: [echoTool], messages: [
      first,
      { role: "assistant", content: r1.content },
      { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "ECHO:PING" }] },
    ] })
    assert.equal(r2.status, 200, JSON.stringify(r2.error))
    assert.equal(r2.stop, "end_turn")
    assert.equal(r2.content[0].text, "GOT:ECHO:PING")
  })

  await step("two calls in one model step", async () => {
    const system = "You are a parallel test agent."
    const messages = [{ role: "user", content: "please CALL_TWO now" }]
    const shape = []
    for (let round = 0; round < 4; round++) {
      const r = await call({ system, tools: [echoTool], messages })
      assert.equal(r.status, 200, JSON.stringify(r.error))
      const uses = r.content.filter((block) => block.type === "tool_use")
      if (r.stop === "end_turn") {
        assert.match(r.content.at(-1).text, /^GOT:/)
        break
      }
      shape.push(uses.length)
      messages.push({ role: "assistant", content: r.content })
      messages.push({ role: "user", content: uses.map((use) => ({ type: "tool_result", tool_use_id: use.id, content: `ECHO:${use.input.text}` })) })
    }
    assert.deepEqual(shape.reduce((a, b) => a + b, 0), 2)
    results.push(`     (tool_use per response: ${JSON.stringify(shape)})`)
  })

  await step("OpenCode-style schemas reach the model intact", async () => {
    const complex = {
      name: "edit",
      description: "Edit a file",
      input_schema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        additionalProperties: false,
        properties: {
          filePath: { type: "string", description: "Absolute path" },
          edits: { type: "array", items: { type: "object", properties: { oldString: { type: "string" }, newString: { type: "string" } }, required: ["oldString", "newString"] } },
          mode: { type: "string", enum: ["replace", "append"] },
          limit: { anyOf: [{ type: "number" }, { type: "null" }] },
        },
        required: ["filePath", "edits"],
      },
    }
    const r = await call({ system: "Schema agent.", tools: [echoTool, complex], messages: [{ role: "user", content: "describe the schema tool please" }] })
    assert.equal(r.status, 200, JSON.stringify(r.error))
    const ns = requests.at(-1).body.tools.find((tool) => tool.name === "mcp__magpie")
    const edit = ns.tools.find((tool) => tool.name === "edit")
    assert.ok(edit, JSON.stringify(ns).slice(0, 400))
    const params = edit.parameters || edit.input_schema
    assert.deepEqual(params.properties.mode.enum, ["replace", "append"])
    assert.deepEqual(params.required, ["filePath", "edits"])
  })

  if (process.env.MUSE_TEST_SLOW === "1") {
    await step("tool result after 75s (tool_timeout_sec)", async () => {
      const system = "Slow agent."
      const first = { role: "user", content: "please CALL_ONE slowly" }
      const r1 = await call({ system, tools: [echoTool], messages: [first] })
      assert.equal(r1.stop, "tool_use", JSON.stringify(r1))
      await new Promise((resolve) => setTimeout(resolve, 75_000))
      const use = r1.content.find((block) => block.type === "tool_use")
      const r2 = await call({ system, tools: [echoTool], messages: [
        first,
        { role: "assistant", content: r1.content },
        { role: "user", content: [{ type: "tool_result", tool_use_id: use.id, content: "LATE" }] },
      ] })
      assert.equal(r2.status, 200, JSON.stringify(r2.error))
      assert.equal(r2.content.at(-1).text, "GOT:LATE")
    })
  }

  await step("rejected key maps to 401 + X-Magpie-Sign-In: expired", async () => {
    const r = await call({ messages: [{ role: "user", content: "please FAIL401 now and explain" }] })
    assert.equal(r.status, 401, JSON.stringify(r))
    assert.equal(r.headers.get("x-magpie-sign-in"), "expired")
  })

  await step("auth.json rewrite is carried back to the user's file", async () => {
    const real = path.join(tmp, "user-config", "muse", "auth.json")
    fs.writeFileSync(real, JSON.stringify({ providers: { meta: { mechanism: "oauth", access_token: "old" } } }))
    const config = path.join(tmp, "conv-config")
    _test.linkAuth(config)
    const link = path.join(config, "muse", "auth.json")
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    fs.rmSync(link)
    fs.writeFileSync(link, JSON.stringify({ providers: { meta: { mechanism: "oauth", access_token: "new" } } }))
    _test.syncAuth(config)
    assert.equal(JSON.parse(fs.readFileSync(real, "utf8")).providers.meta.access_token, "new")
    assert.ok(fs.lstatSync(link).isSymbolicLink())
    fs.rmSync(real)
  })

  await step("authorize fails clearly when muse is signed out", async () => {
    delete process.env.META_API_KEY
    const result = await plugin.auth.methods[0].authorize()
    process.env.META_API_KEY = "dummy-test-key"
    assert.equal(result.type, "failed")
    assert.match(result.error, /not signed in.*not logged in/s)
  })
} finally {
  h.finish()
}
