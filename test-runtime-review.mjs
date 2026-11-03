import assert from "node:assert/strict"
import { fork, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { MspError } from "@muse-code/sdk"
import { MuseSdkRuntime, normalizeRuntimeError } from "./sdk-runtime.mjs"

const fixture = fileURLToPath(new URL("./test/fixtures/runtime-review-host.mjs", import.meta.url))
function runtime(env = {}, callbacks = {}) {
  return new MuseSdkRuntime({ command: fixture, cwd: process.cwd(), env: { ...process.env, ...env }, model: "review-model", ...callbacks })
}
function start(host, overrides = {}) {
  let resolve, reject
  const done = new Promise((yes, no) => { resolve = yes; reject = no })
  const admitted = host.start({ model: "review-model", prompt: "review", images: [], replayInput: () => ({ prompt: "replay", images: [] }),
    onSession() {}, onText() {}, onActivity() {}, onComplete: resolve, onError: reject, ...overrides })
  return { done, admitted }
}
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === "ESRCH") return false; throw error }
}
async function gone(pids) {
  const deadline = Date.now() + 4000
  while (pids.some(alive) && Date.now() < deadline) await delay(20)
  assert.deepEqual(pids.filter(alive), [], "owned host/helper processes must be gone")
}

if (process.argv.includes("--exit-owner")) {
  const host = runtime({ REVIEW_PID_FILE: process.env.REVIEW_PID_FILE, REVIEW_STUBBORN: "1" })
  process.on("exit", () => host.killNow())
  await host.ensureHost()
  await host.createSession(host.host, "review-model")
  process.send(JSON.parse(readFileSync(process.env.REVIEW_PID_FILE, "utf8")))
  process.once("message", () => process.exit(0))
} else {
  test("normalizer uses actual MspError fields and preserves explicit status and quota", () => {
    const raw = new MspError({ code: -32001, message: "opaque refusal", data: { kind: "authRequired", retryable: false } })
    assert.equal(raw.kind, "authRequired")
    const auth = normalizeRuntimeError(raw)
    assert.equal(auth.statusCode, 401)
    assert.equal(auth.kind, raw.kind)
    assert.equal(auth.code, raw.code)
    assert.equal(auth.retryable, false)
    assert.deepEqual(auth.data, raw.data)
    assert.equal(auth.cause, raw)
    for (const input of [
      new MspError({ code: -32001, message: "opaque", data: { kind: "modelError", quota: { limitKind: "tierLimit" } } }),
      { message: "opaque", kind: "modelError", quota: { limitKind: "tierLimit" } },
    ]) assert.equal(normalizeRuntimeError(input).statusCode, 429)
    assert.equal(normalizeRuntimeError({ message: "opaque", kind: "authRequired", statusCode: 403 }).statusCode, 403)
    assert.equal(normalizeRuntimeError(new MspError({ code: -32001, message: "opaque", data: { kind: "authRequired", statusCode: 409 } })).statusCode, 409)
    assert.equal(normalizeRuntimeError(new Error("authentication quota 401 429")).statusCode, undefined)
  })

  for (const method of ["initialize", "model/list", "session/start", "session/resume", "turn/start"]) {
    for (const data of [{ kind: "authRequired" }, { kind: "modelError", quota: { limitKind: "tierLimit" } }]) {
      test(`${method} classifies opaque JSON-RPC ${data.kind} before output`, async () => {
        const host = runtime({ REVIEW_FAIL_METHOD: method, REVIEW_ERROR_DATA: JSON.stringify(data) })
        if (method === "session/resume") host.sessionId = "existing-session"
        try {
          const { done, admitted } = start(host)
          await assert.rejects(done, (error) => {
            assert.equal(error.statusCode, data.quota ? 429 : 401)
            assert.equal(error.kind, data.kind)
            assert.equal(error.message, "muse SDK: opaque refusal")
            assert.ok(!error.message.includes("REVIEW_SECRET"))
            assert.deepEqual(error.data, data)
            return true
          })
          await admitted
        } finally { await host.close() }
      })
    }
  }

  test("terminal notifications use the same typed classification", () => {
    for (const error of [{ kind: "authRequired", message: "opaque" }, { kind: "modelError", quota: {}, message: "opaque" }, { kind: "modelError", statusCode: 503, message: "opaque" }]) {
      const host = runtime()
      let failure
      host.sessionId = "s"
      host.active = { turnId: "t", onActivity() {}, onError(value) { failure = value } }
      host.onNotification({ method: "turn/completed", params: { sessionId: "s", turnId: "t", terminal: "failed", error } })
      assert.equal(failure.statusCode, error.statusCode ?? (error.quota ? 429 : 401))
      assert.equal(failure.kind, error.kind)
    }
  })

  for (const code of ["0", "17"]) {
    test(`onExit observes actual SDK host exit ${code} and contains callback failures`, async () => {
      let report
      const host = runtime({ REVIEW_EXIT_CODE: code }, { onExit(value) { report = value; if (code === "0") throw new Error("callback failure"); return Promise.reject(new Error("async callback failure")) } })
      try {
        const { done, admitted } = start(host)
        await assert.rejects(done, /host exited/)
        await admitted
        assert.equal(report.code, Number(code))
        assert.equal(report.signal, null)
        assert.equal(report.error, undefined)
        await delay(10)
      } finally { await host.close() }
    })
  }

  test("onExit also observes clean SDK close and spawn failure exactly once", async () => {
    const reports = []
    const host = runtime({}, { onExit: (value) => reports.push(value) })
    await host.ensureHost()
    await host.close()
    assert.equal(reports.length, 1)
    assert.equal(reports[0].code, 0)
    const missing = runtime({}, { onExit: (value) => reports.push(value) })
    missing.options.command = path.join(tmpdir(), "muse-review-command-does-not-exist")
    // The connection's failed write can win the race with spawn's ENOENT;
    // onExit must retain the actual spawn error in either ordering.
    await assert.rejects(missing.ensureHost())
    await missing.close()
    assert.equal(reports.length, 2)
    assert.equal(reports[1].error.code, "ENOENT")
  })

  test("SDK close remains bounded for a stubborn host and its MCP helpers", { skip: process.platform === "win32", timeout: 12000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runtime-close-"))
    const pidFile = path.join(dir, "pids.json")
    const host = runtime({ REVIEW_PID_FILE: pidFile, REVIEW_STUBBORN: "1" })
    try {
      await host.ensureHost()
      await host.createSession(host.host, "review-model")
      const pids = Object.values(JSON.parse(readFileSync(pidFile, "utf8")))
      const before = Date.now()
      await host.close()
      assert.ok(Date.now() - before < 9000)
      await gone(pids)
    } finally { host.killNow(); await host.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  test("onExit runs before inherited pipes close and killNow retains ownership of surviving helpers", { skip: process.platform === "win32", timeout: 7000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runtime-orphan-"))
    const pidFile = path.join(dir, "pids.json")
    let reportExit
    const exited = new Promise((resolve) => { reportExit = resolve })
    const host = runtime({ REVIEW_PID_FILE: pidFile, REVIEW_EXIT_AFTER_SESSION: "1" }, { onExit: reportExit })
    try {
      await host.ensureHost()
      await host.createSession(host.host, "review-model")
      const pids = JSON.parse(readFileSync(pidFile, "utf8"))
      const exit = await exited
      assert.equal(exit.code, 0)
      assert.ok(alive(pids.helper), "stubborn helper holds host pipes open after actual exit")
      host.killNow()
      host.killNow()
      await host.close()
      await gone(Object.values(pids))
    } finally { host.killNow(); await host.close(); rmSync(dir, { recursive: true, force: true }) }
  })

  test("synchronous process exit kills only the captured host group, including MCP helpers", { skip: process.platform === "win32", timeout: 10000 }, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "runtime-exit-"))
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    const owner = fork(fileURLToPath(import.meta.url), ["--exit-owner"], { env: { ...process.env, REVIEW_PID_FILE: path.join(dir, "pids.json") }, stdio: ["ignore", "pipe", "pipe", "ipc"] })
    let diagnostics = ""
    owner.stderr.on("data", (chunk) => { diagnostics += chunk })
    try {
      const [pids] = await once(owner, "message")
      assert.ok(Object.values(pids).every(alive))
      const exit = once(owner, "exit")
      owner.send("exit")
      const [code] = await exit
      assert.equal(code, 0, diagnostics)
      await gone(Object.values(pids))
      assert.ok(alive(unrelated.pid), "another caller's process must survive")
    } finally {
      owner.kill("SIGKILL")
      unrelated.kill("SIGKILL")
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
