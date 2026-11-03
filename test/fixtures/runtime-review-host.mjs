#!/usr/bin/env node
// Review-only host: official SDK framing/error paths, plus owned descendants.
import { spawn } from "node:child_process"
import { writeFileSync } from "node:fs"
import { createInterface } from "node:readline"
import { EXPECTED_SCHEMA_FINGERPRINT } from "@muse-code/sdk"

if (process.argv.includes("--stubborn-helper")) {
  process.on("SIGTERM", () => {})
  process.stdin.resume()
  setInterval(() => {}, 1000)
} else {
  const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n")
  let helper
  async function descendants() {
    if (!process.env.REVIEW_PID_FILE || helper) return
    helper = spawn(process.execPath, [new URL(import.meta.url).pathname, "--stubborn-helper"], { stdio: ["pipe", "inherit", "inherit"] })
    const mcp = spawn(process.execPath, [new URL("../../mcp-server.mjs", import.meta.url).pathname], { stdio: ["pipe", "pipe", "inherit"] })
    // Exercise a real bridge MCP helper before reporting it ready.
    const ready = new Promise((resolve, reject) => {
      const lines = createInterface({ input: mcp.stdout })
      lines.once("line", (line) => {
        try {
          const frame = JSON.parse(line)
          if (!frame.result?.serverInfo) throw new Error("MCP did not initialize")
          resolve()
        } catch (error) { reject(error) }
      })
      mcp.once("error", reject)
    })
    mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n")
    await ready
    writeFileSync(process.env.REVIEW_PID_FILE, JSON.stringify({ host: process.pid, helper: helper.pid, mcp: mcp.pid }))
  }
  if (process.env.REVIEW_STUBBORN) {
    process.on("SIGTERM", () => {})
    setInterval(() => {}, 1000)
  }
  createInterface({ input: process.stdin }).on("line", async (line) => {
    const { id, method, params = {} } = JSON.parse(line)
    if (method === process.env.REVIEW_FAIL_METHOD) {
      process.stderr.write("credential=REVIEW_SECRET_MUST_NOT_ESCAPE\n")
      send({ id, error: { code: -32001, message: "opaque refusal", data: JSON.parse(process.env.REVIEW_ERROR_DATA) } })
    } else if (method === "initialize") {
      send({ id, result: { schema: { fingerprint: EXPECTED_SCHEMA_FINGERPRINT }, grantedCapabilities: ["sessionMcp"], serverInfo: { version: "1.4.14" } } })
    } else if (method === "model/list") {
      send({ id, result: { models: [{ providerId: "meta", modelId: "review-model" }] } })
    } else if (method === "session/start" || method === "session/resume") {
      await descendants()
      send({ id, result: { session: { sessionId: params.sessionId || "review-session" } } })
      if (process.env.REVIEW_EXIT_AFTER_SESSION) setTimeout(() => process.exit(0), 20)
    } else if (method === "turn/start") {
      send({ id, result: { status: "accepted", turnId: params.commandId } })
      if (process.env.REVIEW_EXIT_CODE) setTimeout(() => process.exit(Number(process.env.REVIEW_EXIT_CODE)), 20)
    }
  }).on("close", () => {
    if (!process.env.REVIEW_STUBBORN) process.exit(0)
  })
}
