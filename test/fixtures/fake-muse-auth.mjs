#!/usr/bin/env node
// Local-only stand-in for Muse's login/usage commands. Never contacts Meta.
import fs from "node:fs"

const state = process.env.MUSE_TEST_AUTH_STATE
const mode = process.env.MUSE_TEST_AUTH_MODE || "success"
const args = process.argv.slice(2)
if (process.env.MUSE_TEST_AUTH_LOG) {
  fs.appendFileSync(process.env.MUSE_TEST_AUTH_LOG, JSON.stringify({
    args, pid: process.pid, apiKeyPresent: Boolean(process.env.META_API_KEY),
    authPath: process.env.MUSE_AUTH_PATH, configHome: process.env.XDG_CONFIG_HOME,
  }) + "\n")
}
if (args[0] === "usage") {
  if (process.env.META_API_KEY || (state && fs.existsSync(state))) {
    if (args.includes("--json")) {
      console.log(process.env.MUSE_TEST_USAGE_FILE
        ? fs.readFileSync(process.env.MUSE_TEST_USAGE_FILE, "utf8")
        : JSON.stringify({ schemaVersion: 1, allowance: null, reason: "server_sent_no_usage" }))
      process.exit(0)
    }
    console.log("Muse account is signed in; subscription fixture allowance available")
    process.exit(0)
  }
  console.error("Not logged in. Run muse login.")
  process.exit(1)
}
if (args[0] !== "login") process.exit(2)
if (mode === "early-failure") {
  console.error("fixture rejected the login request")
  process.exit(1)
}
if (mode === "silent") {
  setInterval(() => {}, 1000)
} else {
  // Split and ANSI-coded output exercises the adapter's stream parser.
  process.stdout.write("\u001b[36mOpen https://auth.meta.com/device")
  setTimeout(() => {
    process.stdout.write(" and enter code ABCD-EFGH\u001b[0m\n")
    if (mode === "timeout") return
    setTimeout(() => {
      if (mode === "declined") { console.error("fixture login declined"); process.exit(1) }
      if (mode !== "false-success" && state) fs.writeFileSync(state, "fixture signed in", { mode: 0o600 })
      console.log("Login complete")
      process.exit(0)
    }, 50)
  }, 10)
  if (mode === "timeout") setInterval(() => {}, 1000)
}
