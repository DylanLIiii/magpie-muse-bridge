import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { createMuseUsage, translateMuseUsage } from "./muse-usage.mjs"

async function test(name, run) { await run(); console.log(`ok   ${name}`) }
const empty = { schemaVersion: 1, allowance: null, reason: "server_sent_no_usage" }
const successfulProbe = (value = empty) => ({ code: 0, stdout: JSON.stringify(value) })
// Identity-free CLI 1.4.13 capture, same schema as 1.4.14:
// https://github.com/hemsoft-dev/hs-pi-dashboard/blob/3bcd9b975ff7506a39a942990545559dfafaf08c/internal/usage/testdata/muse/measured.json
const measured = JSON.parse(fs.readFileSync(new URL("./test/fixtures/muse-usage-v1.json", import.meta.url), "utf8"))

await test("captured Muse allowance maps USED percentages, tier, reset times and snapshot time", () => {
  const result = translateMuseUsage(measured)
  assert.equal(result.plan, "Muse Code Power Usage")
  assert.equal(result.windows[0].used, 15); assert.equal(result.windows[1].used, 5)
  assert.equal(result.windows[0].resetsAt, new Date(1793053104000).toISOString())
  assert.equal(result.windows[1].resetsAt, new Date(1793577600000).toISOString())
  assert.equal(result.windows[0].span, undefined, "do not assume a rolling-window duration")
  assert.equal(result.windows[1].span, 604800)
  assert.deepEqual(result.windows[2], { name: "As of", display: new Date(1793037245064).toISOString(), aside: true })
  assert.ok(result.windows.every(w => w.amount === undefined && w.limit === undefined))
})
await test("genuine zero and overspent windows are preserved, with optional duration and weekly window", () => {
  for (const usedPercent of [0, 125]) {
    const result = translateMuseUsage({ schemaVersion: 1, allowance: { window: { usedPercent, windowDurationMins: 300 }, weekly: null } })
    assert.equal(result.windows.length, 1); assert.equal(result.windows[0].used, usedPercent)
    assert.equal(result.windows[0].span, 18000); assert.equal(result.windows[0].resetsAt, undefined)
  }
})
await test("missing or malformed percentages and timestamps stay unknown", () => {
  for (const usedPercent of [undefined, null, "0", NaN, Infinity, -1]) {
    const result = translateMuseUsage({ schemaVersion: 1, allowance: { window: { usedPercent, resetsAtMs: "not-a-date", windowDurationMins: Infinity } } })
    assert.equal(result.windows[0].used, undefined)
    assert.equal(result.windows[0].resetsAt, undefined); assert.equal(result.windows[0].span, undefined)
    assert.ok(result.windows[0].display)
  }
})

await test("server-sent-no-usage is a visible unknown allowance, never zero or unlimited", () => {
  const result = translateMuseUsage(empty)
  assert.match(result.windows[0].display, /not returned usage/)
  for (const key of ["used", "amount", "limit", "balance", "unlimited"]) assert.equal(result.windows[0][key], undefined)
  assert.equal(result.signIn, "kept")
})
await test("API-key, no-allowance and new null reasons preserve sign-in with an explanation", () => {
  for (const reason of ["api_key", "no_allowance", "new_future_reason", undefined]) {
    const result = translateMuseUsage({ ...empty, reason })
    assert.equal(result.signIn, "kept"); assert.equal(result.error, undefined)
    assert.ok(result.windows[0].display); assert.equal(result.windows[0].used, undefined)
  }
})
await test("missing or unsupported schemas produce a useful error with no invented windows", () => {
  for (const value of [null, [], {}, { ...empty, schemaVersion: 2 }, { ...empty, allowance: undefined }]) {
    const result = translateMuseUsage(value)
    assert.ok(result.error); assert.deepEqual(result.windows, [])
  }
})
await test("usage queries deduplicate overlapping reads and refresh after completion", async () => {
  let calls = 0, release
  const gate = new Promise(resolve => { release = resolve })
  const usage = createMuseUsage({ findMuse: () => "/fixture/muse", readUsage: async binary => {
    assert.equal(binary, "/fixture/muse"); calls++
    await gate
    return successfulProbe()
  } })
  const a = usage(), b = usage()
  assert.equal(a, b); assert.equal(calls, 1)
  release(); await a; await usage()
  assert.equal(calls, 2)
})
await test("usage does not probe credentials while a browser sign-in is in progress", async () => {
  const usage = createMuseUsage({ isSigningIn: () => true, findMuse: () => assert.fail("must not probe"), readUsage: () => assert.fail() })
  assert.match((await usage()).error, /in progress/)
})
await test("missing CLI and timeout are visible without invalidating the sign-in", async () => {
  const missing = await createMuseUsage({ findMuse: () => null })()
  assert.match(missing.error, /not found/); assert.equal(missing.signIn, "kept")
  const timedOut = await createMuseUsage({ findMuse: () => "muse", readUsage: async () => ({ timedOut: true }) })()
  assert.match(timedOut.error, /timed out/); assert.equal(timedOut.signIn, "kept")
})
await test("only definite CLI authentication failures request sign-in again", async () => {
  for (const [stderr, expected] of [["Not logged in. Run muse login.", "expired"], ["Connection refused", "kept"]]) {
    const result = await createMuseUsage({ findMuse: () => "muse", readUsage: async () => ({ code: 1, stderr }) })()
    assert.equal(result.signIn, expected); assert.ok(result.error)
  }
})
await test("valid schema-v1 usage on a nonzero CLI exit is still displayed", async () => {
  const result = await createMuseUsage({ findMuse: () => "muse", readUsage: async () => ({ ...successfulProbe(measured), code: 1 }) })()
  assert.equal(result.windows[0].used, 15)
})
await test("invalid JSON, command failures and exceptions never expose raw output", async () => {
  for (const readUsage of [
    async () => ({ code: 0, stdout: "private-fixture-value" }),
    async () => ({ code: 1, stderr: "private-fixture-value" }),
    async () => { throw new Error("private-fixture-value") },
  ]) {
    const result = await createMuseUsage({ findMuse: () => "muse", readUsage })()
    assert.ok(result.error); assert.ok(!JSON.stringify(result).includes("private-fixture-value"))
  }
})
await test("a failed usage read can recover on the next refresh", async () => {
  let n = 0
  const usage = createMuseUsage({ findMuse: () => "muse", readUsage: async () => ++n === 1 ? { code: 1, stderr: "offline" } : successfulProbe() })
  assert.ok((await usage()).error)
  assert.equal((await usage()).error, undefined)
})
await test("the real plugin usage hook runs official CLI JSON mode in isolated settings", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-usage-tests-"))
  const keys = ["XDG_CONFIG_HOME", "MUSE_PATH", "MUSE_AUTH_PATH", "META_API_KEY", "MUSE_TEST_AUTH_STATE", "MUSE_TEST_AUTH_LOG", "MUSE_TEST_USAGE_FILE"]
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]))
  try {
    process.env.XDG_CONFIG_HOME = path.join(root, "config")
    process.env.MUSE_PATH = fileURLToPath(new URL("./test/fixtures/fake-muse-auth.mjs", import.meta.url))
    process.env.MUSE_AUTH_PATH = path.join(root, "fixture-auth.json")
    process.env.MUSE_TEST_AUTH_STATE = path.join(root, "fixture-signed-in")
    process.env.MUSE_TEST_AUTH_LOG = path.join(root, "calls.jsonl")
    delete process.env.META_API_KEY
    fs.writeFileSync(process.env.MUSE_TEST_AUTH_STATE, "fixture only")
    const { MuseBridgePlugin } = await import("./index.mjs")
    const plugin = await MuseBridgePlugin()
    assert.equal(typeof plugin.auth.usage, "function")
    const result = await plugin.auth.usage()
    assert.match(result.windows[0].display, /not returned usage/)
    process.env.MUSE_TEST_USAGE_FILE = path.join(root, "fixture-usage.json")
    fs.writeFileSync(process.env.MUSE_TEST_USAGE_FILE, JSON.stringify(measured))
    const refreshed = await plugin.auth.usage()
    assert.equal(refreshed.plan, "Muse Code Power Usage")
    assert.equal(refreshed.windows[0].used, 15)
    const calls = fs.readFileSync(process.env.MUSE_TEST_AUTH_LOG, "utf8").trim().split("\n").map(JSON.parse)
    assert.deepEqual(calls.map(c => c.args), [["usage", "--json"], ["usage", "--json"]])
    assert.notEqual(calls[0].configHome, process.env.XDG_CONFIG_HOME)
    assert.equal(calls[0].authPath, process.env.MUSE_AUTH_PATH)
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    fs.rmSync(root, { recursive: true, force: true })
  }
})
