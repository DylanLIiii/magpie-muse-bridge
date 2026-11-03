// Opt-in real Magpie plugin-host integration, using a local fake Muse CLI.
// No real sign-in, browser, model call, or user's Magpie settings are used.
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"

if (process.env.MUSE_TEST_MAGPIE_AUTH !== "1") {
  console.log("skip: set MUSE_TEST_MAGPIE_AUTH=1 to test the installed Magpie auth host")
  process.exit(0)
}
const exec = promisify(execFile)
const root = fs.mkdtempSync(path.join(os.tmpdir(), "muse-magpie-auth-"))
const repo = path.dirname(fileURLToPath(import.meta.url))
const dirs = Object.fromEntries(["config", "cache", "data", "state", "run", "bin"].map(k => [k, path.join(root, k)]))
for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true })
fs.mkdirSync(path.join(dirs.config, "magpie"))
fs.writeFileSync(path.join(dirs.config, "magpie/settings.json"), JSON.stringify({ signInLinkOnly: true, noAccountDiscovery: true, noStats: true, noUsageStats: true }))
// Older Magpie releases don't support signInLinkOnly. Their browser launcher
// looks up open/xdg-open in PATH; these child-local shims prevent any UI/network.
for (const name of ["open", "xdg-open"]) fs.writeFileSync(path.join(dirs.bin, name), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
const env = { ...process.env,
  PATH: dirs.bin + path.delimiter + process.env.PATH,
  XDG_CONFIG_HOME: dirs.config, XDG_CACHE_HOME: dirs.cache,
  XDG_DATA_HOME: dirs.data, XDG_STATE_HOME: dirs.state, XDG_RUNTIME_DIR: dirs.run,
  MAGPIE_NO_ACCOUNTS: "1", MAGPIE_PLUGIN_MARKET: "off",
  MUSE_PATH: path.join(repo, "test/fixtures/fake-muse-auth.mjs"),
  MUSE_TEST_AUTH_STATE: path.join(root, "muse-sign-in"), MUSE_TEST_AUTH_LOG: path.join(root, "muse-calls"),
  MUSE_BRIDGE_LOGIN_DISCOVERY_MS: "5000", MUSE_BRIDGE_LOGIN_TIMEOUT_MS: "10000",
}
delete env.META_API_KEY; delete env.MUSE_AUTH_PATH
if (process.env.MAGPIE_TEST_BUN) env.MAGPIE_BUN = process.env.MAGPIE_TEST_BUN
const magpie = process.env.MAGPIE_TEST_BIN || "magpie"
async function run(args, input = "") {
  try {
    const command = exec(magpie, args, { cwd: repo, env, timeout: 60000, maxBuffer: 1024 * 1024 })
    command.child.stdin.end(input)
    return await command
  }
  catch (error) { throw new Error(`Magpie ${args.slice(0, 3).join(" ")} failed: ${error.stderr || error.message}`) }
}
try {
  await run(["plugin", "add", repo])
  const signedIn = await run(["plugin", "login", "muse-bridge", "1"], "2\n")
  assert.match(signedIn.stdout + signedIn.stderr, /ABCD-EFGH/)
  const authPath = path.join(dirs.config, "magpie/plugin-auth.json")
  const saved = fs.readFileSync(authPath, "utf8")
  assert.ok(saved.includes('"muse"'), "Magpie must save the bridge connection marker")
  assert.ok(!saved.includes("access_token"), "Magpie must not store Muse CLI credentials")
  await run(["plugin", "login", "muse-bridge", "2"])
  const reused = await run(["plugin", "login", "muse-bridge", "1"], "1\n")
  assert.match(reused.stdout + reused.stderr, /How would you like to sign in to Muse/)
  assert.match(reused.stdout + reused.stderr, /Use existing Muse sign-in/)
  const calls = fs.readFileSync(env.MUSE_TEST_AUTH_LOG, "utf8").trim().split("\n").map(JSON.parse)
  assert.equal(calls.filter(r => r.args[0] === "login").length, 1, "existing sign-in must not restart browser auth")
  await run(["plugin", "logout", "muse-bridge"])
  assert.equal(fs.existsSync(env.MUSE_TEST_AUTH_STATE), true, "Magpie disconnect must preserve official CLI login")
  env.MUSE_TEST_AUTH_MODE = "early-failure"
  await assert.rejects(() => run(["plugin", "login", "muse-bridge", "1"], "2\n"), (error) => {
    assert.match(error.message, /declined, expired, or failed/)
    assert.doesNotMatch(error.message, /callback is not a function/)
    return true
  })
  console.log("ok   installed Magpie login-source choice, browser flow, marker save, existing reuse, disconnect, and early auth failure with fake Muse")
} finally { fs.rmSync(root, { recursive: true, force: true }) }
