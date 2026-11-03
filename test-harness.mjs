// Shared harness for the real-muse integration tests: a fake Meta Responses
// upstream on 127.0.0.1, the plugin loaded against it, and helpers to call
// the bridge and inspect the muse process tree.
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

export function findMuseBin() {
  return process.env.MUSE_TEST_BIN || (() => {
    try { return execFileSync("sh", ["-c", "command -v muse"], { encoding: "utf8" }).trim() } catch { return "" }
  })()
}

export function inputText(item) {
  if (typeof item.content === "string") return item.content
  if (Array.isArray(item.content)) return item.content.map((part) => part.text || "").join("")
  return ""
}

// Markers only count in the turn being asked now, not in replayed history.
function currentTurn(text) {
  const at = text.lastIndexOf("<current_turn>")
  return at >= 0 ? text.slice(at) : text
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Fake Meta Responses upstream. What it answers depends on the last input
// item: a function_call_output gets "GOT:<outputs>"; otherwise markers in the
// current user turn pick CALL_ONE / CALL_TWO / FAIL401, or a plain REPLY
// describing what muse sent (user message count, whether history was
// replayed in text). Extra markers:
//   SLOW_TEXT   stream the text as many deltas, 200ms apart
//   SLOW_START  wait 3s before answering at all
//   RATE429xN   answer 429 to the first N attempts of this prompt (N=* always)
//   STALL       send response.created, then nothing until the client hangs up
//   STALL_TEXT  send one text delta, then stall the same way
//
// It is a raw TCP server speaking just enough HTTP/1.1 (one request per
// connection, `connection: close`), because Bun's node:http server never
// reports a client hang-up; a socket "close" does, on both runtimes.

// Read one HTTP request off a socket: { method, url, headers, body }.
function readRequest(socket, onRequest) {
  let buf = Buffer.alloc(0)
  let head = null
  const onData = (chunk) => {
    buf = Buffer.concat([buf, chunk])
    if (!head) {
      const end = buf.indexOf("\r\n\r\n")
      if (end < 0) return
      const lines = buf.subarray(0, end).toString("latin1").split("\r\n")
      const [method, url] = lines[0].split(" ")
      const headers = {}
      for (const line of lines.slice(1)) {
        const at = line.indexOf(":")
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim()
      }
      head = { method, url, headers }
      buf = buf.subarray(end + 4)
    }
    let body
    if (/chunked/i.test(head.headers["transfer-encoding"] || "")) {
      const parts = []
      let at = 0
      for (;;) {
        const eol = buf.indexOf("\r\n", at)
        if (eol < 0) return
        const size = parseInt(buf.subarray(at, eol).toString("latin1"), 16)
        if (size === 0) break
        if (buf.length < eol + 2 + size + 2) return
        parts.push(buf.subarray(eol + 2, eol + 2 + size))
        at = eol + 2 + size + 2
      }
      body = Buffer.concat(parts)
    } else {
      const length = Number(head.headers["content-length"] || 0)
      if (buf.length < length) return
      body = buf.subarray(0, length)
    }
    socket.off("data", onData)
    onRequest({ ...head, body: body.toString("utf8") })
  }
  socket.on("data", onData)
}

// The small slice of http.ServerResponse the upstream uses.
function rawResponse(socket) {
  return {
    writeHead(status, headers = {}) {
      const lines = [`HTTP/1.1 ${status} ${status === 200 ? "OK" : "Error"}`, "connection: close"]
      for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`)
      socket.write(lines.join("\r\n") + "\r\n\r\n")
    },
    write(text) { if (!socket.destroyed) socket.write(text) },
    end(text) {
      if (socket.destroyed) return
      if (text) socket.write(text)
      socket.end()
    },
  }
}

function startUpstream(requests) {
  const rateCounts = new Map()
  const sockets = new Set()
  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on("error", () => {})
    socket.on("close", () => sockets.delete(socket))
    readRequest(socket, async ({ url, body: raw }) => {
      const res = rawResponse(socket)
      const jsonBody = (status, value, headers = {}) => {
        const text = JSON.stringify(value)
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers })
        res.end(text)
      }
      if (url.endsWith("/muse-code/models")) {
        jsonBody(200, { object: "list", data: ["muse-spark-1.3", "muse-spark-1.2"].map((id) => ({
          id, object: "model", created: 0, owned_by: "meta",
          metadata: { "muse-code": {
            name: id, family: "meta", is_hidden: false, attachment: true, reasoning: true, temperature: false, tool_call: true,
            modalities: { input: ["text", "image"], output: ["text"] }, options: { include: [] }, variants: {},
            description: "test", limit: { context: 128000, output: 32000 },
          } },
        })) })
        return
      }
      if (!url.endsWith("/responses")) {
        jsonBody(404, { error: { message: "not found" } })
        return
      }
      const body = JSON.parse(raw)
      const record = { body, closed: false, finished: false, status: 200 }
      requests.push(record)
      socket.on("close", () => { record.closed = true })
      const input = Array.isArray(body.input) ? body.input : []
      const users = input.filter((item) => item.role === "user" && item.type !== "function_call_output")
      const lastUser = inputText(users.at(-1) || {})
      const current = currentTurn(lastUser)
      const last = input.at(-1)
      const rate = current.match(/RATE429x(\d+|\*)/)
      if (rate && last?.type !== "function_call_output") {
        const seen = rateCounts.get(current) || 0
        rateCounts.set(current, seen + 1)
        if (rate[1] === "*" || seen < Number(rate[1])) {
          record.status = 429
          jsonBody(429, { error: { message: "rate limit exceeded: too many requests", type: "rate_limit_error" } }, { "retry-after": "0" })
          return
        }
      }
      if (last?.type !== "function_call_output" && current.includes("FAIL401")) {
        record.status = 401
        jsonBody(401, { error: { message: "invalid token", type: "authentication_error" } })
        return
      }
      if (current.includes("SLOW_START")) await sleep(3000)
      if (record.closed) return
      res.writeHead(200, { "content-type": "text/event-stream" })
      let seq = 0
      const id = "resp_" + requests.length
      const created = Math.floor(Date.now() / 1000)
      const response = (status, output, extra = {}) => ({ id, object: "response", created_at: created, status, model: body.model, output, parallel_tool_calls: true, tool_choice: "auto", tools: [], ...extra })
      const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`)
      send("response.created", { response: response("in_progress", []) })
      send("response.in_progress", { response: response("in_progress", []) })
      const stalling = last?.type !== "function_call_output" && /STALL(?!_TEXT)/.test(current)
      if (stalling) return
      const output = []
      const calls = last?.type === "function_call_output" ? []
        : current.includes("CALL_TWO") ? ["A", "B"]
        : current.includes("CALL_ONE") ? ["PING"] : []
      if (calls.length) {
        calls.forEach((text, index) => {
          const item = { id: `fc_${requests.length}_${index}`, type: "function_call", status: "completed", call_id: `call_${requests.length}_${index}`, name: "mcp__magpie__echo", arguments: JSON.stringify({ text }) }
          send("response.output_item.added", { output_index: index, item: { ...item, status: "in_progress", arguments: "" } })
          send("response.function_call_arguments.delta", { item_id: item.id, output_index: index, delta: item.arguments })
          send("response.function_call_arguments.done", { item_id: item.id, output_index: index, arguments: item.arguments })
          send("response.output_item.done", { output_index: index, item })
          output.push(item)
        })
      } else {
        const outputs = input.filter((item) => item.type === "function_call_output")
          .slice(-2).map((item) => typeof item.output === "string" ? item.output : JSON.stringify(item.output))
        const text = last?.type === "function_call_output"
          ? `GOT:${outputs.join("|")}`
          : `REPLY users=${users.length} history=${lastUser.includes("<conversation_history>") ? "yes" : "no"}`
        const part = { type: "output_text", text, annotations: [], logprobs: [] }
        const item = { id: "msg_" + requests.length, type: "message", role: "assistant", status: "completed", content: [part] }
        send("response.output_item.added", { output_index: 0, item: { ...item, status: "in_progress", content: [] } })
        send("response.content_part.added", { item_id: item.id, output_index: 0, content_index: 0, part: { ...part, text: "" } })
        if (last?.type !== "function_call_output" && current.includes("STALL_TEXT")) {
          send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "partial ", logprobs: [] })
          return
        }
        const deltas = current.includes("SLOW_TEXT") ? [...Array.from({ length: 40 }, (_, i) => `chunk${i} `), text] : [text]
        for (const [index, delta] of deltas.entries()) {
          if (record.closed) return
          if (index > 0) await sleep(200)
          if (record.closed) return
          send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta, logprobs: [] })
        }
        part.text = deltas.join("")
        send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: part.text, logprobs: [] })
        send("response.content_part.done", { item_id: item.id, output_index: 0, content_index: 0, part })
        send("response.output_item.done", { output_index: 0, item })
        output.push(item)
      }
      send("response.completed", { response: response("completed", output, { usage: { input_tokens: 100, output_tokens: 7, total_tokens: 107, input_tokens_details: { cached_tokens: 40 }, output_tokens_details: { reasoning_tokens: 3 } } }) })
      record.finished = true
      res.end()
    })
  })
  server.closeAll = () => {
    server.close()
    for (const socket of sockets) socket.destroy()
  }
  return server
}

// Parse an Anthropic SSE body into content blocks, stop reason, usage, error.
export function parseSSE(text) {
  const content = []
  let stop = null
  let usage = null
  let error = null
  for (const chunk of text.split("\n\n")) {
    const data = chunk.split("\n").find((line) => line.startsWith("data: "))
    if (!data) continue
    const event = JSON.parse(data.slice(6))
    if (event.type === "content_block_start") content[event.index] = { ...event.content_block, partial: "" }
    if (event.type === "content_block_delta") {
      const block = content[event.index]
      if (event.delta.type === "text_delta") block.text += event.delta.text
      else block.partial += event.delta.partial_json
    }
    if (event.type === "content_block_stop") {
      const block = content[event.index]
      if (block.type === "tool_use") block.input = JSON.parse(block.partial || "{}")
      delete block.partial
    }
    if (event.type === "message_delta") { stop = event.delta.stop_reason; usage = event.usage }
    if (event.type === "error") error = event.error
  }
  return { content, stop, usage, error }
}

// pid -> ppid for every process, from one `ps` snapshot.
function processTable() {
  const out = execFileSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" })
  const table = new Map()
  for (const line of out.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number)
    if (pid) table.set(pid, ppid)
  }
  return table
}

// pid plus all of its live descendants.
export function processTree(pid) {
  const table = processTable()
  const tree = [pid]
  for (let i = 0; i < tree.length; i++) {
    for (const [child, parent] of table) if (parent === tree[i] && !tree.includes(child)) tree.push(child)
  }
  return tree.filter((p) => table.has(p))
}

export function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === "EPERM" }
}

export async function waitFor(predicate, ms, what) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${ms}ms waiting for ${what}`)
    await sleep(50)
  }
}

// Wait until every pid in pids has exited.
export async function waitGone(pids, ms = 8000) {
  await waitFor(() => pids.every((pid) => !alive(pid)), ms, `processes ${pids.filter(alive).join(",")} to exit`)
}

function listSandboxes(root) {
  try {
    return fs.readdirSync(root).filter((name) => name.startsWith("muse-shell-sandbox-")).map((name) => path.join(root, name))
  } catch { return [] }
}

export const echoTool = { name: "echo", description: "Echo text back", input_schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }

// Load the plugin against a fresh fake upstream. env is applied before the
// plugin module is imported (it reads MUSE_BRIDGE_* at load time).
export async function startHarness({ bin, env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "muse-bridge-test-"))
  const requests = []
  const upstream = startUpstream(requests)
  await new Promise((resolve) => upstream.listen(0, "127.0.0.1", resolve))
  const port = upstream.address().port

  // XDG_CONFIG_HOME points the "real" auth.json at a temp dir so the user's
  // own sign-in is never touched.
  process.env.XDG_CONFIG_HOME = path.join(tmp, "user-config")
  process.env.MUSE_PATH = bin
  process.env.MUSE_BRIDGE_TRANSPORT = "exec"
  process.env.MUSE_NO_AUTO_UPDATE = "1"
  process.env.META_API_KEY = "dummy-test-key"
  process.env.MUSE_BRIDGE_BASE_URL = `http://127.0.0.1:${port}/v1`
  process.env.MUSE_SDK_TEST_LOG = path.join(tmp, "msp-control.jsonl")
  // The bridge hands its environment to muse, so TMPDIR keeps muse's scratch
  // dirs (muse-shell-sandbox-*) and the bridge root inside tmp. As a backstop,
  // finish() also removes any new empty sandbox dirs under the system temp
  // dirs, leaving those that existed before the run alone.
  const sandboxRoots = [...new Set([os.tmpdir(), "/tmp"].map((dir) => { try { return fs.realpathSync(dir) } catch { return dir } }))]
  const sandboxesBefore = new Set(sandboxRoots.flatMap(listSandboxes))
  process.env.TMPDIR = path.join(tmp, "tmpdir")
  fs.mkdirSync(process.env.TMPDIR)
  Object.assign(process.env, env)
  fs.mkdirSync(path.join(tmp, "user-config", "muse"), { recursive: true })

  const { MuseBridgePlugin, _test } = await import("./index.mjs")
  const plugin = await MuseBridgePlugin()
  const { fetch: bridgeFetch } = await plugin.auth.loader()

  const request = (body, init = {}) => bridgeFetch("muse://local/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-magpie-work-dir": encodeURIComponent(tmp) },
    body: JSON.stringify({ model: "muse-spark-1.3", max_tokens: 1024, stream: true, ...body }),
    ...init,
  })

  async function call(body, init) {
    const res = await request(body, init)
    if (!res.headers.get("content-type")?.includes("text/event-stream")) {
      return { status: res.status, headers: res.headers, error: await res.json() }
    }
    return { status: res.status, headers: res.headers, ...parseSSE(await res.text()) }
  }

  const results = []
  const readLogs = () => {
    try { return fs.readFileSync(process.env.MUSE_SDK_TEST_LOG, "utf8").split("\n").filter(Boolean).map(JSON.parse) }
    catch { return [] }
  }
  async function step(name, fn) {
    const started = Date.now()
    try {
      await fn()
      results.push(`ok   ${name} (${Date.now() - started}ms)`)
    } catch (error) {
      results.push(`FAIL ${name}: ${error.stack || error}`)
    }
  }

  function finish() {
    upstream.closeAll()
    for (const conv of [..._test.pool.values()]) conv.dispose()
    setTimeout(() => {
      fs.rmSync(tmp, { recursive: true, force: true })
      for (const dir of sandboxRoots.flatMap(listSandboxes)) {
        if (!sandboxesBefore.has(dir)) try { fs.rmdirSync(dir) } catch {}
      }
    }, 500)
    console.log(results.join("\n"))
    const failed = results.some((line) => line.startsWith("FAIL"))
    setTimeout(() => process.exit(failed ? 1 : 0), 800)
  }

  return { tmp, port, requests, readLogs, plugin, _test, request, call, step, results, finish }
}
