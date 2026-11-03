import { spawn } from "node:child_process"
import { Connection, MuseServeChild, MspError, ProtocolError, checkServedFingerprint } from "@muse-code/sdk"

const SDK_VERSION = "1.4.14"
const START_TIMEOUT_MS = 30_000
const SHUTDOWN_TIMEOUT_MS = 3_000

// MspError promotes JSON-RPC data.kind to .kind. Turn notifications instead
// carry a TurnError directly, including quota detail on modelError failures.
export function normalizeRuntimeError(value) {
  const message = String(value?.message ?? value)
  const error = new Error(message.startsWith("muse SDK: ") ? message : `muse SDK: ${message}`, { cause: value })
  const data = value?.data
  error.kind = value instanceof MspError ? value.kind : value?.kind ?? data?.kind
  for (const key of ["code", "data", "retryable"]) {
    if (value?.[key] !== undefined) error[key] = value[key]
  }
  error.quota = value?.quota ?? data?.quota
  error.statusCode = value?.statusCode ?? data?.statusCode
  if (error.statusCode == null) {
    if (error.kind === "authRequired") error.statusCode = 401
    else if (error.quota || error.kind === "quota" || error.kind === "quotaExceeded") error.statusCode = 429
  }
  return error
}

function runtimeError(message, kind) {
  return normalizeRuntimeError({ message, kind })
}

// The SDK handshake hides its native ChildProcess. Compose the two public SDK
// primitives instead: its spawn hook supplies the exact owned handle, while
// Connection still owns framing, request correlation and command admission.
function ownedHandshake(options, ownChild) {
  let native
  const child = MuseServeChild.spawn({
    museBin: options.command, args: options.args, cwd: options.cwd, env: options.env,
    shutdownTimeoutMs: SHUTDOWN_TIMEOUT_MS, onStderr: options.onStderr,
    spawnFn(command, args, spawnOptions) {
      native = spawn(command, args, spawnOptions)
      ownChild(native, spawnOptions.detached === true)
      return native
    },
  })
  const exited = new Promise((resolve, reject) => {
    native.once("error", reject)
    native.once("close", (code, signal) => resolve({ code, signal }))
  })
  exited.catch(() => {})
  let closing
  const transport = {
    incoming: native.stdout,
    write: (chunk) => new Promise((resolve, reject) => {
      native.stdin.write(chunk, "utf8", (error) => error ? reject(error) : resolve())
    }),
    close(flushed) {
      // Connection's public flush barrier must precede EOF, with a bound even
      // when the peer stops reading. MuseServeChild owns the subsequent ladder.
      closing ??= (async () => {
        let timer
        try {
          await Promise.race([
            flushed ?? Promise.resolve(),
            new Promise((resolve) => { timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS) }),
          ])
        } finally {
          clearTimeout(timer)
          await child.close()
        }
      })()
      return closing
    },
  }
  const connection = new Connection(transport)
  const close = async () => { await connection.close(); return await exited }
  let started = false
  return {
    child, exited, close,
    onNotification: (handler) => connection.onNotification(handler),
    onProtocolError: (handler) => connection.onProtocolError(handler),
    async initialize(params) {
      if (started) throw new ProtocolError("initialize may be sent only once per connection")
      started = true
      const result = await connection.request("initialize", params)
      if (typeof result.schema?.fingerprint !== "string") throw new ProtocolError("initialize result has no schema fingerprint")
      const fingerprintWarning = checkServedFingerprint(result.schema.fingerprint)
      connection.notify("initialized")
      await connection.flush()
      return { connection, child, exited, close, initializeResult: result, fingerprintWarning }
    },
  }
}

// One bounded, SDK-owned host per bridge conversation. The HTTP/tool-result
// boundary belongs to index.mjs; the MCP call remains live inside this host.
export class MuseSdkRuntime {
  constructor({ command, cwd, env, model, baseURL, onStderr, onWarning, onExit }) {
    this.options = { command, cwd, env, model, baseURL, onStderr, onWarning, onExit }
    this.ownedChildren = new Map()
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
    } catch (error) {
      throw normalizeRuntimeError(error)
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
    // Main tool presets do not disable reminder child inference. The official
    // SDK's real-host tests use this empty roster for a single agent loop.
    args.push("-c", 'run.reminder_roster={"agents":[]}')
    if (this.options.baseURL) args.push("-c", `endpoint_transport.base_url=${JSON.stringify(this.options.baseURL)}`)
    const handshake = ownedHandshake({
      command: this.options.command, args,
      cwd: this.options.cwd, env: this.options.env,
      onStderr: this.options.onStderr,
    }, (child, ownsGroup) => this.ownChild(child, ownsGroup))
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
      throw normalizeRuntimeError(error)
    }
  }

  ownChild(child, ownsGroup) {
    this.ownedChildren.set(child, ownsGroup)
    let reported = false
    const report = (code, signal, error) => {
      if (reported) return
      reported = true
      try {
        Promise.resolve(this.options.onExit?.({ code, signal, error })).catch(() => {})
      } catch {}
    }
    child.once("exit", (code, signal) => report(code, signal))
    child.once("error", (error) => {
      // A failed spawn has no PID. Other ChildProcess errors (for example a
      // refused signal) do not prove exit; wait for the actual exit event.
      if (child.pid === undefined) report(null, null, error)
    })
    // Keep ownership until stdio closes: an MCP helper may outlive its host
    // and still hold the process group's pipes open after the host's exit.
    child.once("close", () => this.ownedChildren.delete(child))
  }

  killNow() {
    this.closed = true
    this.active = null
    for (const [child, ownsGroup] of this.ownedChildren) {
      if (ownsGroup && child.pid !== undefined) {
        try { process.kill(-child.pid, "SIGKILL"); continue } catch {}
      }
      try { child.kill("SIGKILL") } catch {}
    }
  }

  command(method, params, options) {
    // Ambiguous admission is not automatically resubmitted. A lost host invalidates
    // the active bridge turn; caller history is replayed on the next request.
    return this.deadline(this.host.connection.command(method, params, { maxAttempts: 1, ...options }), method)
  }

  async createSession(host, model) {
    const catalog = await this.deadline(host.connection.request("model/list", {}), "model/list")
    const selected = catalog.models?.find((row) => row.modelId === model && row.providerId === "meta")
    if (!selected) throw runtimeError(`Meta model ${model} is not in this host's model catalog`)
    const result = await this.command("session/start", {
      workspaceRoot: this.options.cwd,
      // Empty preset exposes only the host's bridge MCP tools. Their execution
      // and permission checks remain with the requesting Magpie client.
      approvalMode: "allowAll",
      providerId: selected.providerId, modelId: selected.modelId,
    })
    this.sessionId = result.session?.sessionId
    if (!this.sessionId) throw runtimeError("session/start returned no sessionId")
  }

  async start({ model, effort, prompt, images, replayInput, onSession, onText, onComplete, onError, onActivity }) {
    if (this.active) throw runtimeError("conversation already has an active turn")
    const active = { onText, onComplete, onError, onActivity, items: new Map(), usage: [], cursors: new Set() }
    this.active = active
    try {
      const host = await this.ensureHost()
      if (this.active !== active || this.closed) return
      if (!this.sessionId) {
        await this.createSession(host, model)
      } else if (this.loadedHost !== host) {
        try {
          const result = await this.command("session/resume", {
            sessionId: this.sessionId, excludeItems: true,
          })
          if (result.session?.sessionId !== this.sessionId) throw runtimeError("session/resume returned a different session")
          if (result.pendingRequests?.length) throw runtimeError("resumed session has unfinished requests; inspect it before retrying")
        } catch (error) {
          // Only a typed, definite absence is safe to replace without another
          // caller round trip. Never replay sessionInUse, pending approvals, a
          // transport timeout, or an ambiguously admitted turn.
          if (!["sessionNotFound", "notFound"].includes(error.kind)) throw error
          if (this.active !== active || this.closed) return
          this.sessionId = null
          const replay = replayInput()
          prompt = replay.prompt
          images = replay.images
          await this.createSession(host, model)
        }
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
      // A previous completed turn may still be settling inside Muse. A queued
      // acknowledgement admits this exact turn; await its events instead of
      // treating it as a failure (or resubmitting and duplicating the input).
      if (result.status !== "accepted" || result.disposition === "steered") {
        throw runtimeError(`turn was not admitted as a new turn (${result.status}, ${result.disposition})`)
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
        active.onError(normalizeRuntimeError({ ...p.error, message: p.error?.message || p.reason || `turn ended: ${p.terminal}` }))
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
    if (active) active.onError(normalizeRuntimeError(error))
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
