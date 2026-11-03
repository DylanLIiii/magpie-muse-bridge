import { spawn } from "node:child_process"

const SUCCESS = { type: "success", key: "muse" }
const liveLogins = new Set()
export const isMuseLoginPending = () => liveLogins.size > 0
process.once("exit", () => {
  for (const child of liveLogins) try { child.kill("SIGKILL") } catch {}
})
const failed = (error) => ({ type: "failed", error })
// Older Magpie hosts always expect OAuth authorize to yield a callback object.
// Throw before the flow exists; {type:failed} is only portable from callback/API.
const rejectAuthorize = (message) => { throw new Error(message) }
const timeout = (name, fallback) => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? Math.min(n, fallback) : fallback
}
const plain = (text) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n")

// Read only the CLI's display protocol, not OAuth responses or credential files.
// There is no machine-readable login mode in Muse 1.4.14.
function display(output) {
  const text = plain(output)
  const links = text.match(/https:\/\/[^\s<>"'\x00-\x1f]+/g) || []
  const url = links.map((link) => link.replace(/[),.;]+$/, "")).find((link) => {
    try {
      const u = new URL(link)
      return !u.username && !u.password && ["auth.meta.com", "accountscenter.meta.com", "www.meta.com", "meta.com"].includes(u.hostname)
    } catch { return false }
  })
  const match = /(?:enter(?: this)?|approve|confirm(?: this)?)?\s*(?:code(?: matches)?)\s*[:=]?\s*([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{6,8})(?![A-Z0-9])/i.exec(text)
  return { url, code: match?.[1] }
}

export function createMuseAuth({ findMuse, checkSignIn, createLoginContext, beforeLogin = async () => {} }) {
  let pending
  let generation = 0
  const missing = () => failed("Muse CLI not found. Install Muse Code from https://dev.meta.ai/docs/muse-code, then retry.")

  async function useExisting() {
    const muse = findMuse()
    if (!muse) return missing()
    const probe = await checkSignIn(muse)
    if (!probe.err && !probe.timedOut && probe.code === 0) return { ...SUCCESS }
    const text = `${probe.stdout || ""}\n${probe.stderr || ""}`
    if (/not logged in|not signed in|authRequired|sign in again|log in again|no login to refresh/i.test(text)) {
      return failed("Muse is not signed in (not logged in). Choose Sign in with Muse, or run muse login in your terminal.")
    }
    return failed(probe.timedOut
      ? "Muse sign-in check timed out. Check the connection or any Keychain prompt and retry."
      : "Muse could not verify its sign-in. Check muse usage in a terminal; your CLI credentials were not changed.")
  }

  async function authorize(_inputs, context = {}) {
    const own = ++generation
    const muse = findMuse()
    if (!muse) return rejectAuthorize(missing().error)
    if (context.signal?.aborted) return rejectAuthorize("Muse sign-in was cancelled.")
    if (pending) await pending.stop("Muse sign-in was replaced by a newer attempt.")
    try { await beforeLogin() } catch (error) { return rejectAuthorize(error.message) }
    if (context.signal?.aborted) return rejectAuthorize("Muse sign-in was cancelled.")
    if (own !== generation) return rejectAuthorize("Muse sign-in was replaced by a newer attempt.")
    let login
    try { login = await createLoginContext() } catch { return rejectAuthorize("Could not prepare Muse sign-in. Check the local config directory permissions.") }
    if (own !== generation || context.signal?.aborted) {
      await login.cleanup()
      return rejectAuthorize("Muse sign-in was cancelled or replaced.")
    }
    const env = { ...login.env }
    // Browser login must not be masked by an inherited pay-as-you-go API key.
    // The bridge's inference environment is unchanged; tell the user about it.
    const keyOverrides = Boolean(env.META_API_KEY)
    delete env.META_API_KEY
    delete env.MUSE_LOGIN
    let child
    try { child = spawn(muse, ["login"], { cwd: login.cwd, env, stdio: ["pipe", "pipe", "pipe"] }) }
    catch { await login.cleanup(); return rejectAuthorize("Could not start Muse sign-in. Check MUSE_PATH and retry.") }
    liveLogins.add(child)

    let output = "", exited = false, failure, discoverResolve, completionResolve, stopping
    let discoveryTimer, lifetimeTimer, callbackSignal, callbackAbort
    const discovery = new Promise((resolve) => { discoverResolve = resolve })
    const completion = new Promise((resolve) => { completionResolve = resolve })
    const settleDiscovery = (value) => { discoverResolve?.(value); discoverResolve = null }
    const attempt = {
      stop(message) {
        if (stopping) return stopping
        failure = message
        settleDiscovery(failed(message))
        if (!exited) {
          try { child.kill("SIGKILL") } catch {}
          child.stdin.destroy()
        }
        stopping = completion.then(() => {})
        return stopping
      },
    }
    pending = attempt
    const authorizeAbort = () => { void attempt.stop("Muse sign-in was cancelled.") }
    context.signal?.addEventListener("abort", authorizeAbort, { once: true })
    child.stdin.on("error", () => {})
    const read = (chunk) => {
      output = (output + chunk).slice(-32 * 1024)
      const info = display(output)
      if (info.url && info.code) settleDiscovery(info)
      // With piped input the CLI can ask for Enter before beginning its poll.
      // Magpie owns browser opening; stdin is not a credential input channel.
      if (/Press Enter to open it in your browser:/i.test(plain(output)) && !attempt.entered) {
        attempt.entered = true
        child.stdin.write("\n")
      }
    }
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8")
    child.stdout.on("data", read); child.stderr.on("data", read)
    child.on("error", () => { failure = "Could not start Muse sign-in. Check MUSE_PATH and retry." })
    child.once("close", async (code) => {
      exited = true
      liveLogins.delete(child)
      clearTimeout(discoveryTimer); clearTimeout(lifetimeTimer)
      context.signal?.removeEventListener("abort", authorizeAbort)
      callbackSignal?.removeEventListener("abort", callbackAbort)
      // Do not expose CLI output: successful login can print credential details.
      let result = failure ? failed(failure) : code === 0 ? { ...SUCCESS }
        : failed("Muse sign-in was declined, expired, or failed. Retry Sign in with Muse; CLI credentials remain owned by Muse.")
      try {
        await login.cleanup()
        if (result.type === "success") {
          const probe = await checkSignIn(muse, { browserOnly: true })
          if (probe.err || probe.timedOut || probe.code !== 0) {
            result = failed("Muse login ended but the account could not be verified. Run muse usage to check account onboarding or the connection, then retry.")
          }
        }
      } catch { result = failed("Muse sign-in cleanup or verification failed. Check muse usage and retry.") }
      // A replacement/cancellation can arrive while cleanup or the CLI-owned
      // verification was awaited. Never let a stale success authenticate Magpie.
      if (failure || own !== generation) result = failed(failure || "Muse sign-in was replaced by a newer attempt.")
      if (pending === attempt) pending = null
      output = ""
      settleDiscovery(result)
      completionResolve(result)
    })
    discoveryTimer = setTimeout(() => { void attempt.stop("Muse did not display a supported sign-in URL and code. Run muse login in a terminal, then choose Use existing Muse sign-in.") }, timeout("MUSE_BRIDGE_LOGIN_DISCOVERY_MS", 30_000))
    lifetimeTimer = setTimeout(() => { void attempt.stop("Muse sign-in timed out. Start a new sign-in attempt.") }, timeout("MUSE_BRIDGE_LOGIN_TIMEOUT_MS", 9 * 60_000))
    const info = await discovery
    clearTimeout(discoveryTimer)
    // Magpie cancels its authorize context after displaying the URL. Its
    // callback gets a different signal; do not bind the old signal to polling.
    context.signal?.removeEventListener("abort", authorizeAbort)
    if (info.type) return rejectAuthorize(info.error || "Muse sign-in ended before an authorization flow was available.")
    let callbackResult
    return {
      url: info.url,
      instructions: `Approve code ${info.code} in the Muse sign-in page. Muse saves your login locally; no account token is stored in Magpie.${keyOverrides ? " META_API_KEY is set for Magpie; remove it from the plugin host environment to use the browser account for model requests." : ""}`,
      method: "auto",
      callback(_code, next = {}) {
        if (callbackResult) return callbackResult
        callbackSignal = next.signal
        callbackAbort = () => { void attempt.stop("Muse sign-in was cancelled.") }
        if (callbackSignal?.aborted) callbackAbort()
        else callbackSignal?.addEventListener("abort", callbackAbort, { once: true })
        callbackResult = completion.then((result) => callbackSignal?.aborted ? failed("Muse sign-in was cancelled.")
          : own !== generation ? failed("Muse sign-in was replaced by a newer attempt.") : result)
          .finally(() => callbackSignal?.removeEventListener("abort", callbackAbort))
        return callbackResult
      },
    }
  }

  return {
    provider: "muse-bridge", single: true,
    methods: [
      { type: "oauth", label: "Sign in with Muse", authorize },
      { type: "api", keyless: true, label: "Use existing Muse sign-in", authorize: useExisting },
    ],
    // Magpie has no auth.logout hook. Disconnect only removes its marker;
    // users run muse logout themselves to clear the shared official CLI login.
  }
}
