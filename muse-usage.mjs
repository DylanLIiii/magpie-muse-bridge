const unavailable = (error) => ({ error, windows: [], signIn: "kept" })
const positive = (v) => typeof v === "number" && Number.isFinite(v) && v > 0
const timestamp = (v) => positive(v) && Number.isFinite(new Date(v).getTime()) ? new Date(v).toISOString() : undefined

function usageWindow(name, value, span) {
  if (!value || typeof value !== "object") return
  const result = { name }
  if (typeof value.usedPercent === "number" && Number.isFinite(value.usedPercent) && value.usedPercent >= 0) {
    result.used = value.usedPercent // official USED percentage; may exceed 100
  } else {
    result.display = "Muse has not reported a valid usage percentage."
  }
  const reset = timestamp(value.resetsAtMs)
  if (reset) result.resetsAt = reset
  if (positive(span)) result.span = span
  return result
}

export function translateMuseUsage(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.schemaVersion !== 1) {
    return unavailable("Muse returned an unsupported usage format. Update the bridge and Muse Code, then refresh.")
  }
  if (value.allowance === null) {
    const explanations = {
      server_sent_no_usage: "Muse has not returned usage data for this subscription yet.",
      api_key: "Muse is using an API key; subscription allowance is unavailable.",
      no_allowance: "Muse has not reported a subscription allowance for this account.",
    }
    return { signIn: "kept", windows: [{ name: "Muse subscription", display: explanations[value.reason] || "Muse subscription allowance is unavailable." }] }
  }
  const allowance = value.allowance
  if (!allowance || typeof allowance !== "object" || Array.isArray(allowance)) {
    return unavailable("Muse did not return a supported subscription allowance. Check muse usage in a terminal.")
  }
  const minutes = allowance.window?.windowDurationMins
  const windows = [
    usageWindow("Current window", allowance.window, positive(minutes) ? minutes * 60 : undefined),
    usageWindow("Weekly", allowance.weekly, 7 * 24 * 60 * 60),
  ].filter(Boolean)
  if (!windows.length) return unavailable("Muse did not return any subscription usage windows. Check muse usage in a terminal.")
  const observed = timestamp(allowance.asOfMs)
  if (observed) windows.push({ name: "As of", display: observed, aside: true })
  const result = { windows }
  if (typeof allowance.tier === "string" && allowance.tier.trim()) result.plan = allowance.tier.trim()
  return result
}

// Magpie caches the account's usage. Share overlapping reads without keeping a
// second cache that could hide a refreshed CLI login or a reset usage window.
export function createMuseUsage({ findMuse, readUsage, isSigningIn = () => false }) {
  let pending
  return function usage() {
    pending ??= read().finally(() => { pending = undefined })
    return pending
  }

  async function read() {
    if (isSigningIn()) return unavailable("Muse sign-in is in progress. Refresh the allowance after it finishes.")
    const muse = findMuse()
    if (!muse) return unavailable("Muse CLI not found. Install Muse Code or set MUSE_PATH, then refresh.")
    let probe
    try { probe = await readUsage(muse) }
    catch { return unavailable("Muse could not read subscription usage. Check muse usage in a terminal, then refresh.") }
    if (probe.timedOut) return unavailable("Muse usage check timed out. Check the connection or Keychain prompt, then refresh.")
    let parsed
    try { parsed = JSON.parse(probe.stdout) } catch {}
    // Some CLI failures still carry a schema-v1 allowance response on stdout.
    // Preserve that explicit result rather than guessing usage from stderr.
    if (!probe.err && parsed?.schemaVersion === 1 && Object.hasOwn(parsed, "allowance")) return translateMuseUsage(parsed)
    if (probe.err || probe.code !== 0) {
      const text = `${probe.stdout || ""}\n${probe.stderr || ""}`
      if (/not logged in|not signed in|authRequired|sign in again|log in again|no login to refresh/i.test(text)) {
        return { ...unavailable("Muse is not signed in. Use Sign in with Muse or run muse login in a terminal."), signIn: "expired" }
      }
      return unavailable("Muse could not read subscription usage. Check muse usage in a terminal, then refresh.")
    }
    return parsed === undefined
      ? unavailable("Muse returned invalid usage JSON. Update Muse Code and check muse usage --json in a terminal.")
      : translateMuseUsage(parsed)
  }
}
