import { spawnMspConnection } from "@muse-code/sdk"

const SDK_VERSION = "1.4.14"
const START_TIMEOUT_MS = 30_000
// Host capabilities are separate from the main model's empty tool preset.
// Disable the bundled reminder children so a provider request doesn't silently
// become additional observer inference. Keep these version-pinned with the host.
const REMINDERS = ["memory", "skill-reminder", "todo-reminder", "goal-reminder", "verify-reminder", "scope-reminder"]

function runtimeError(message, kind) {
  const error = new Error(`muse SDK: ${message}`)
  if (kind === "authRequired") error.statusCode = 401
  if (kind === "quota" || kind === "quotaExceeded") error.statusCode = 429
  return error
}

// One bounded, SDK-owned host per bridge conversation. The HTTP/tool-result
// boundary belongs to index.mjs; the MCP call remains live inside this host.
export class MuseSdkRuntime {
  constructor({ command, cwd, env, model, baseURL, onStderr, onWarning }) {
    this.options = { command, cwd, env, model, baseURL, onStderr, onWarning }
    this.host = null
    this.handshake = null
    this.sessionId = null
    this.active = null
    this.closed = false
    this.starting = null
    this.closing = null
  }

  async deadline(promise, label) {
    let timer
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(runtimeError(`${label} timed out`)), START_TIMEOUT_MS)
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  async ensureHost() {
    if (this.closed) throw runtimeError("host was closed")
    if (this.host) return this.host
    if (this.starting) return this.starting
    this.starting = this.openHost()
    try { return await this.starting } finally { this.starting = null }
  }

  async openHost() {
    const args = ["serve", "--preset", "empty", "--disable-request-user-input", "--contributor-mode", "off"]
    args.push("--provider", "meta", "--model", this.options.model)
    args.push("-c", `runtime_capabilities=${JSON.stringify(Object.fromEntries(
      REMINDERS.map((name) => [`plugin:tbh-reminders:reminder:${name}`, { enabled: false }]),
    ))}`)
    if (this.options.baseURL) args.push("-c", `endpoint_transport.base_url=${JSON.stringify(this.options.baseURL)}`)
    const handshake = spawnMspConnection({
      command: this.options.command, args,
      cwd: this.options.cwd, env: this.options.env,
      shutdownTimeoutMs: 3_000,
      onStderr: this.options.onStderr,
    })
    this.handshake = handshake
    // Subscribe before initialize/session/start: notification delivery can precede
    // the matching command reply. Never send model input before the handshake.
    handshake.onNotification((notification) => this.onNotification(notification))
    handshake.onProtocolError((error) => this.fail(error))
    handshake.exited.then((exit) => {
      if (this.handshake !== handshake) return
      this.host = null
      this.handshake = null
      if (!this.closed && this.active) {
        this.fail(runtimeError(`host exited (code=${exit.code}, signal=${exit.signal})`))
      }
    }, (error) => { if (!this.closed) this.fail(error) })
    try {
      const host = await this.deadline(handshake.initialize({
        clientInfo: { name: "magpie_muse_bridge", version: "0.2.0" },
        capabilities: { requestedCapabilities: ["sessionMcp"] },
      }), "initialize")
      if (this.closed) throw runtimeError("closed during initialize")
      if (!host.initializeResult.grantedCapabilities?.includes("sessionMcp")) {
        throw runtimeError("host did not grant sessionMcp; Muse Code 1.4.12+ with session MCP support is required")
      }
      const version = host.initializeResult.serverInfo?.version
      if (version && !version.startsWith(SDK_VERSION)) {
        this.options.onWarning?.(`SDK ${SDK_VERSION} is paired with host ${version}; pin matching versions`)
      }
      if (host.fingerprintWarning) this.options.onWarning?.(host.fingerprintWarning.message)
      this.host = host
      return host
    } catch (error) {
      const tail = handshake.child.stderrTail.slice(-5).join("\n")
      throw runtimeError(`${error.message}${tail ? `\n${tail}` : ""}`, error.kind)
    }
  }

  command(method, params, options) {
    // Ambiguous admission is not automatically resubmitted. A lost host invalidates
    // the active bridge turn; caller history is replayed on the next request.
    return this.deadline(this.host.connection.command(method, params, { maxAttempts: 1, ...options }), method)
  }

  async start({ model, effort, prompt, images, mcpServers, onSession, onText, onComplete, onError, onActivity }) {
    if (this.active) throw runtimeError("conversation already has an active turn")
    const active = { onText, onComplete, onError, onActivity, items: new Map(), usage: [], cursors: new Set() }
    this.active = active
    try {
      const host = await this.ensureHost()
      if (this.active !== active || this.closed) return
      if (!this.sessionId) {
        const catalog = await this.deadline(host.connection.request("model/list", {}), "model/list")
        const selected = catalog.models?.find((row) => row.modelId === model && row.providerId === "meta")
        if (!selected) throw runtimeError(`Meta model ${model} is not in this host's model catalog`)
        const result = await this.command("session/start", {
          workspaceRoot: this.options.cwd,
          // Empty preset exposes only the bridge MCP tools. Their actual execution
          // and permission checks remain with the requesting Magpie client.
          approvalMode: "allowAll",
          providerId: selected.providerId, modelId: selected.modelId,
          config: { mcpServers },
        })
        this.sessionId = result.session?.sessionId
        if (!this.sessionId) throw runtimeError("session/start returned no sessionId")
      } else if (this.loadedHost !== host) {
        const result = await this.command("session/resume", {
          sessionId: this.sessionId, excludeItems: true, config: { mcpServers },
        })
        if (result.session?.sessionId !== this.sessionId) throw runtimeError("session/resume returned a different session")
        if (result.pendingRequests?.length) throw runtimeError("resumed session has unfinished requests; replay caller history in a new session")
      }
      this.loadedHost = host
      onSession(this.sessionId)
      if (this.active !== active || this.closed) return
      const input = [{ type: "text", text: prompt }, ...images.map((image) => ({
        type: "image", base64Data: image.data, mediaType: image.mediaType,
      }))]
      const commandId = host.connection.mintCommandId()
      active.turnId = commandId
      const result = await this.command("turn/start", {
        sessionId: this.sessionId, input,
        ...(effort ? { reasoningEffort: effort } : {}),
      }, { commandId })
      if (result.status !== "accepted" || result.disposition === "queued" || result.disposition === "steered") {
        throw runtimeError(`turn was not started immediately (${result.status}, ${result.disposition})`)
      }
      if (result.turnId && result.turnId !== active.turnId) throw runtimeError("turn/start returned an unexpected turnId")
    } catch (error) {
      if (this.active === active) this.fail(error)
    }
  }

  onNotification({ method, params: p }) {
    const active = this.active
    if (!active || !this.sessionId || p?.sessionId !== this.sessionId) return
    if (p.turnId && p.turnId !== active.turnId) return
    active.onActivity()
    if (method === "view/gap") {
      // Do not manufacture a complete answer after dropping model output.
      this.fail(runtimeError("host reported an event gap; retry from caller history"))
    } else if (method === "item/started" || method === "item/updated" || method === "item/completed") {
      const item = p.item
      if (!item || item.turnId !== active.turnId || item.kind !== "agentMessage") return
      const state = active.items.get(item.itemId) ?? { text: "" }
      active.items.set(item.itemId, state)
      if (method === "item/completed" && typeof item.text === "string") {
        if (item.truncated) return this.fail(runtimeError("host truncated an answer; refusing a partial completed response"))
        if (!item.text.startsWith(state.text)) return this.fail(runtimeError("completed answer disagrees with streamed text"))
        const suffix = item.text.slice(state.text.length)
        state.text = item.text
        if (suffix) active.onText(suffix)
      }
    } else if (method === "item/delta" && (!p.field || p.field === "text")) {
      const item = active.items.get(p.itemId)
      if (item && typeof p.delta === "string") {
        item.text += p.delta
        active.onText(p.delta)
      }
    } else if (method === "session/tokenUsage") {
      if (p.viewCursor && active.cursors.has(p.viewCursor)) return
      if (p.viewCursor) active.cursors.add(p.viewCursor)
      active.usage.push(usageRow(p.usage, p.promptTokens))
    } else if (method === "turn/completed") {
      this.active = null
      if (p.terminal === "completed") {
        const rows = active.usage.length ? active.usage : p.usage ? [usageRow(p.usage)] : []
        active.onComplete({ models: rows })
      } else {
        active.onError(runtimeError(p.error?.message || p.reason || `turn ended: ${p.terminal}`, p.error?.quota ? "quota" : p.error?.kind))
      }
    } else if (method === "turn/unqueued") {
      this.fail(runtimeError("turn was removed before it ran"))
    } else if (method === "approval/requested" || method === "userInput/requested") {
      this.fail(runtimeError("unexpected host approval or question; configure the MCP bridge permissions before retrying"))
    }
  }

  fail(error) {
    const active = this.active
    this.active = null
    if (active) active.onError(error)
  }

  close() {
    if (this.closing) return this.closing
    this.closed = true
    const host = this.host ?? this.handshake
    const active = this.active
    this.active = null
    // Cancellation is admitted before EOF; SDK close owns the bounded process-
    // group shutdown ladder, including MCP helpers. Handle every async rejection.
    this.closing = (async () => {
      if (this.host && active?.turnId && this.sessionId) {
        this.host.connection.command("turn/cancel", {
          sessionId: this.sessionId, turnId: active.turnId,
        }, { maxAttempts: 1 }).catch(() => {})
      }
      if (host) await host.close()
    })().catch(() => {})
    return this.closing
  }
}

function usageRow(usage = {}, countedPrompt = usage.inputTokens) {
  return {
    input_tokens: Number(countedPrompt) || 0,
    cached_tokens: Number(usage.cacheReadTokens ?? usage.cachedTokens) || 0,
    cache_write_tokens: Number(usage.cacheWriteTokens) || 0,
    output_tokens: Number(usage.outputTokens) || 0,
    reasoning_tokens: Number(usage.reasoningTokens) || 0,
  }
}
