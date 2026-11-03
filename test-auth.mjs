import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
import { createMuseAuth } from "./muse-auth.mjs"

const exec = promisify(execFile)
const bin = fileURLToPath(new URL("./test/fixtures/fake-muse-auth.mjs", import.meta.url))
const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-auth-tests-"))
process.env.MUSE_BRIDGE_LOGIN_DISCOVERY_MS = "500"
process.env.MUSE_BRIDGE_LOGIN_TIMEOUT_MS = "1000"
const cases = []
async function test(name, run) { await run(); cases.push(`ok   ${name}`) }
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function setup(mode = "success", extra = {}, hooks = {}) {
  const dir = fs.mkdtempSync(path.join(root, "case-"))
  const state = path.join(dir, "state"), log = path.join(dir, "log")
  let cleanups = 0, before = 0
  const env = { ...process.env, ...extra, MUSE_TEST_AUTH_MODE: mode,
    MUSE_TEST_AUTH_STATE: state, MUSE_TEST_AUTH_LOG: log }
  const auth = createMuseAuth({
    findMuse: () => bin,
    beforeLogin: async () => { before++ },
    createLoginContext: () => ({ cwd: dir, env, cleanup: async () => { cleanups++ } }),
    checkSignIn: async (_muse, { browserOnly = false } = {}) => {
      await hooks.probe?.()
      const probeEnv = { ...env }
      if (browserOnly) delete probeEnv.META_API_KEY
      try {
        const p = await exec(bin, ["usage"], { cwd: dir, env: probeEnv, timeout: 3000 })
        return { code: 0, ...p }
      } catch (e) { return { code: e.code, stdout: e.stdout, stderr: e.stderr } }
    },
  })
  return { auth, state, log, get cleanups() { return cleanups }, get before() { return before } }
}

try {
  await test("Magpie offers browser sign-in and keyless existing-login methods", async () => {
    const { auth } = setup()
    assert.equal(auth.single, true); assert.equal(auth.provider, "muse-bridge")
    assert.equal(auth.methods[0].type, "oauth")
    assert.equal(auth.methods[1].type, "api"); assert.equal(auth.methods[1].keyless, true)
  })
  await test("existing-login detection is CLI-owned and does not start a login", async () => {
    const s = setup()
    const method = s.auth.methods[1]
    assert.equal((await method.authorize()).type, "failed")
    fs.writeFileSync(s.state, "signed in")
    assert.deepEqual(await method.authorize(), { type: "success", key: "muse" })
    assert.equal(s.before, 0)
    assert.ok(fs.readFileSync(s.log, "utf8").split("\n").filter(Boolean).every(l => JSON.parse(l).args[0] === "usage"))
  })
  await test("the primary UI method explicitly offers existing and browser login", async () => {
    const s = setup()
    fs.writeFileSync(s.state, "signed in")
    const method = s.auth.methods[0]
    const prompt = method.prompts[0]
    assert.equal(prompt.type, "select")
    assert.deepEqual(prompt.options.map(o => o.value), ["existing", "browser"])
    const flow = await method.authorize({ [prompt.key]: "existing" })
    assert.equal(flow.url, ""); assert.equal(flow.method, "auto")
    assert.deepEqual(await flow.callback(), { type: "success", key: "muse" })
    assert.deepEqual(await flow.callback(), { type: "success", key: "muse" })
    assert.equal(s.before, 0); assert.equal(s.cleanups, 0)
    const calls = fs.readFileSync(s.log, "utf8").trim().split("\n").map(JSON.parse)
    assert.deepEqual(calls.map(row => row.args), [["usage"]])
  })
  await test("choosing existing login while signed out never starts browser login", async () => {
    const s = setup()
    const flow = await s.auth.methods[0].authorize({ loginSource: "existing" })
    const r = await flow.callback()
    assert.equal(r.type, "failed"); assert.match(r.error, /not signed in/)
    assert.equal(s.before, 0); assert.equal(s.cleanups, 0)
    assert.deepEqual(fs.readFileSync(s.log, "utf8").trim().split("\n").map(JSON.parse).map(r => r.args), [["usage"]])
  })
  await test("existing-login UI callbacks respect cancellation and replacement", async () => {
    let entered, release
    const inProbe = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const s = setup("success", {}, { probe: async () => { entered(); await gate } })
    fs.writeFileSync(s.state, "signed in")
    const method = s.auth.methods[0]
    const initial = new AbortController()
    const flow = await method.authorize({ loginSource: "existing" }, { signal: initial.signal })
    initial.abort() // authorize's context ends when the UI receives the flow
    const completion = new AbortController()
    const result = flow.callback(undefined, { signal: completion.signal })
    await inProbe
    const newer = await method.authorize({ loginSource: "existing" })
    release()
    assert.match((await result).error, /replaced/)
    const aborted = new AbortController(); aborted.abort()
    assert.match((await newer.callback(undefined, { signal: aborted.signal })).error, /cancelled/)
    const third = await method.authorize({ loginSource: "existing" })
    assert.equal((await third.callback()).type, "success")
  })
  await test("CLI URL and device code reach Magpie; only a non-secret marker is saved", async () => {
    const s = setup()
    const flow = await s.auth.methods[0].authorize({ loginSource: "browser" })
    assert.equal(flow.method, "auto"); assert.equal(flow.url, "https://auth.meta.com/device")
    assert.match(flow.instructions, /code ABCD-EFGH/)
    assert.deepEqual(await flow.callback(), { type: "success", key: "muse" })
    assert.deepEqual(await flow.callback(), { type: "success", key: "muse" })
    assert.equal(s.cleanups, 1)
    assert.deepEqual(JSON.parse(fs.readFileSync(s.log, "utf8").split("\n")[0]).args, ["login"])
  })
  await test("authorize and completion use different cancellation contexts", async () => {
    const s = setup(), initial = new AbortController()
    const flow = await s.auth.methods[0].authorize(undefined, { signal: initial.signal })
    initial.abort()
    assert.equal((await flow.callback(undefined, { signal: new AbortController().signal })).type, "success")
  })
  await test("cancelling completion kills and reaps login without saving a marker", async () => {
    const s = setup("timeout"), abort = new AbortController()
    const flow = await s.auth.methods[0].authorize()
    const pending = flow.callback(undefined, { signal: abort.signal })
    abort.abort()
    const r = await pending
    assert.equal(r.type, "failed"); assert.match(r.error, /cancelled/)
    assert.equal(s.cleanups, 1); assert.equal(fs.existsSync(s.state), false)
  })
  await test("URL discovery timeout cleans up a CLI that prints nothing", async () => {
    const s = setup("silent")
    await assert.rejects(() => s.auth.methods[0].authorize(), /supported sign-in URL/)
    await delay(30); assert.equal(s.cleanups, 1)
  })
  await test("device approval timeout is bounded even without callback signals", async () => {
    const s = setup("timeout")
    const flow = await s.auth.methods[0].authorize()
    const r = await flow.callback()
    assert.equal(r.type, "failed"); assert.match(r.error, /timed out/); assert.equal(s.cleanups, 1)
  })
  await test("abandoned authorization has an independent total deadline", async () => {
    const s = setup("timeout")
    await s.auth.methods[0].authorize()
    await delay(1100)
    assert.equal(s.cleanups, 1)
  })
  await test("a new sign-in replaces and reaps the previous CLI attempt", async () => {
    const s = setup("timeout")
    const first = await s.auth.methods[0].authorize()
    const second = await s.auth.methods[0].authorize()
    assert.equal((await first.callback()).type, "failed")
    const abort = new AbortController(); abort.abort()
    assert.equal((await second.callback(undefined, { signal: abort.signal })).type, "failed")
    assert.equal(s.cleanups, 2)
  })
  await test("concurrent authorize calls never create two active CLI logins", async () => {
    const s = setup("timeout")
    const first = s.auth.methods[0].authorize()
    const second = s.auth.methods[0].authorize()
    const results = await Promise.allSettled([first, second])
    assert.equal(results[0].status, "rejected")
    const flow = results[1].value
    assert.equal(flow.method, "auto")
    const abort = new AbortController(); abort.abort()
    await flow.callback(undefined, { signal: abort.signal })
    const calls = fs.readFileSync(s.log, "utf8").trim().split("\n").map(JSON.parse)
    assert.equal(calls.filter(row => row.args[0] === "login").length, 1)
  })
  await test("an attempt replaced during verification cannot save a stale success", async () => {
    let entered, release
    const inProbe = new Promise(resolve => { entered = resolve })
    const gate = new Promise(resolve => { release = resolve })
    const s = setup("success", {}, { probe: async () => { entered(); await gate } })
    const first = await s.auth.methods[0].authorize()
    const firstResult = first.callback()
    await inProbe
    const secondResult = s.auth.methods[0].authorize()
    release()
    const previous = await firstResult
    assert.equal(previous.type, "failed"); assert.match(previous.error, /replaced/)
    const second = await secondResult
    assert.deepEqual(await second.callback(), { type: "success", key: "muse" })
  })
  await test("early rejection, declined approval and false success cannot authenticate", async () => {
    for (const mode of ["early-failure", "declined", "false-success"]) {
      const s = setup(mode)
      const flow = await s.auth.methods[0].authorize().catch(error => ({ type: "failed", error: error.message }))
      const r = flow.callback ? await flow.callback() : flow
      assert.equal(r.type, "failed", mode); assert.equal(s.cleanups, 1)
    }
  })
  await test("API key cannot mask verification of a failed browser login", async () => {
    const s = setup("false-success", { META_API_KEY: "fake-local-key" })
    const flow = await s.auth.methods[0].authorize()
    assert.match(flow.instructions, /META_API_KEY/)
    assert.equal((await flow.callback()).type, "failed")
    const rows = fs.readFileSync(s.log, "utf8").trim().split("\n").map(JSON.parse)
    assert.ok(rows.every(r => !r.apiKeyPresent))
  })
  await test("missing binary and pre-cancelled login fail without creating context", async () => {
    const auth = createMuseAuth({ findMuse: () => null })
    await assert.rejects(() => auth.methods[0].authorize(), /not found/)
    const s = setup(), abort = new AbortController(); abort.abort()
    await assert.rejects(() => s.auth.methods[0].authorize(undefined, { signal: abort.signal }), /cancelled/)
    assert.equal(s.cleanups, 0); assert.equal(s.before, 0)
  })
  await test("plugin owner exit synchronously terminates an unfinished login CLI", async () => {
    const dir = fs.mkdtempSync(path.join(root, "owner-")), log = path.join(dir, "log")
    const moduleURL = new URL("./muse-auth.mjs", import.meta.url).href
    const code = `import {createMuseAuth} from ${JSON.stringify(moduleURL)};
      const auth=createMuseAuth({findMuse:()=>${JSON.stringify(bin)},
        createLoginContext:()=>({cwd:${JSON.stringify(dir)},env:process.env,cleanup:async()=>{}})});
      await auth.methods[0].authorize(); process.exit(0);`
    await exec(process.execPath, ["--input-type=module", "-e", code], {
      env: { ...process.env, MUSE_TEST_AUTH_MODE: "timeout", MUSE_TEST_AUTH_LOG: log }, timeout: 5000,
    })
    const pid = JSON.parse(fs.readFileSync(log, "utf8").split("\n")[0]).pid
    let alive = true
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid, 0); await delay(10) } catch (error) {
        if (error.code !== "ESRCH") throw error
        alive = false
      }
    }
    assert.equal(alive, false, "unfinished Muse login process must not outlive the plugin")
  })
  console.log(cases.join("\n"))
} finally { fs.rmSync(root, { recursive: true, force: true }) }
