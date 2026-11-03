#!/usr/bin/env node
// Deterministic NDJSON MSP host; no provider, network, or auth access.
// MUSE_SDK_TEST_LOG=/tmp/muse.jsonl ./test/fixtures/fake-muse.mjs serve --preset empty
// MUSE_SDK_TEST_DENY_CAP=1 withholds sessionMcp. Logs contain only allowlisted control fields.
import { spawn } from 'node:child_process'
import { appendFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { EXPECTED_SCHEMA_FINGERPRINT, createUuidV7Mint } from '@muse-code/sdk'
const sessions = new Map(), children = new Set()
let closing = false
const mint = createUuidV7Mint()
const timestamp = '2026-01-01T00:00:00.000Z'
const denyCap = /^(1|true|yes)$/i.test(process.env.MUSE_SDK_TEST_DENY_CAP || '')
function log(row) {
  if (process.env.MUSE_SDK_TEST_LOG) appendFileSync(process.env.MUSE_SDK_TEST_LOG, JSON.stringify(row) + '\n')
}
log({ type: 'spawn', args: process.argv.slice(2).map(arg => ['serve', '--preset', 'empty', 'SDK_UNSUPPORTED'].includes(arg) ? arg : '[redacted]') })
function send(frame) { if (!closing) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n') }
const reply = (id, result) => send({ id, result })
const refuse = (id, code, message, data) => send({ id, error: { code, message, ...(data ? { data } : {}) } })
const cursor = s => String(s.cursor).padStart(12, '0')
function event(s, method, params, durable = true) {
  const position = { id: mint(), sequence: ++s.cursor }
  const sourceRange = { stream: { kind: 'session', id: s.session.sessionId }, first: position, last: position }
  send({ method, params: { sessionId: s.session.sessionId, viewCursor: cursor(s), ...(durable ? { sourceRange } : {}), ...params } })
}
// Real MCP child and concurrent request correlation. Payloads are never logged.
function mcpClient(config, cwd) {
  if (config.transport !== 'stdio' || config.framing === 'contentLength') throw new Error('Fixture requires NDJSON stdio MCP')
  const child = spawn(config.command, config.args || [], { cwd, env: { ...process.env, ...config.env }, stdio: ['pipe', 'pipe', 'pipe'] })
  children.add(child)
  const pending = new Map()
  let next = 0, dead = false
  child.stderr.resume()
  const fail = () => {
    dead = true
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('MCP child unavailable')) }
    pending.clear()
  }
  child.on('error', () => { children.delete(child); fail() })
  child.on('exit', () => { children.delete(child); fail() })
  child.stdin.on('error', fail)
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', line => {
    let frame
    try { frame = JSON.parse(line) } catch { fail(); return }
    const entry = pending.get(frame.id)
    if (!entry) return
    pending.delete(frame.id)
    clearTimeout(entry.timer)
    if (frame.error) entry.reject(new Error('MCP request failed'))
    else entry.resolve(frame.result)
  })
  function write(frame) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...frame }) + '\n') }
  function request(method, params = {}) {
    log({ type: 'mcp', method })
    return new Promise((resolve, reject) => {
      if (dead) { reject(new Error('MCP child unavailable')); return }
      const id = ++next
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('MCP request timed out')) }, 5000)
      pending.set(id, { resolve, reject, timer })
      write({ id, method, params })
    })
  }
  const ready = (async () => {
    await request('initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'fake-muse', version: '1.0.0' } })
    write({ method: 'notifications/initialized' })
    return (await request('tools/list')).tools || []
  })()
  ready.catch(() => {})
  return { ready, request }
}
function complete(s, turn, terminal = 'completed', error) {
  if (s.active !== turn) return
  s.active = null
  s.session.activeTurnId = null
  s.session.status = 'idle'
  s.session.turnCount++
  const usage = { inputTokens: 100, outputTokens: 7, cachedTokens: 40, reasoningTokens: 3 }
  event(s, 'turn/completed', { turnId: turn.id, terminal, ...(error ? { error } : {}), ...(terminal === 'completed' ? { usage } : {}) })
}
const currentTurn = prompt => prompt.slice(Math.max(0, prompt.lastIndexOf('<current_turn>')))
async function run(s, turn, prompt) {
  if (s.active !== turn || closing) return
  event(s, 'turn/started', { turnId: turn.id, commandId: turn.id })
  const current = currentTurn(prompt)
  if (current.includes('SDK_REFRESH_AUTH')) {
    const auth = path.join(process.env.XDG_CONFIG_HOME, 'muse/auth.json')
    writeFileSync(auth + '.new', JSON.stringify({ fixtureCredential: turn.id }), { mode: 0o600 })
    renameSync(auth + '.new', auth)
  }
  if (current.includes('SDK_CHECK_JPEG')) {
    const image = turn.input.find(part => part.type === 'image')
    if (image?.mediaType !== 'image/jpeg') {
      complete(s, turn, 'failed', { kind: 'modelError', message: 'Noncanonical JPEG type', retryable: false }); return
    }
  }
  if (current.includes('SDK_STDERR')) {
    process.stderr.write('fixture diagnostic for the current SDK turn\n')
    await new Promise(resolve => setTimeout(resolve, 15))
  }
  if (current.includes('SDK_CRASH')) { process.stderr.write('fake-muse: deliberate SDK_CRASH\n'); await shutdown(17); return }
  if (current.includes('SDK_STALL')) return
  if (current.includes('SDK_AUTH')) { complete(s, turn, 'failed', { kind: 'authRequired', message: 'Authentication required (fixture)', retryable: false, requestDenied: true }); return }
  if (current.includes('SDK_QUOTA')) { complete(s, turn, 'failed', { kind: 'modelError', message: 'Quota exhausted (fixture)', retryable: false, quota: { limitKind: 'tierLimit', resetsAtMs: 1893456000000 } }); return }
  let text
  if (/CALL_ONE|CALL_TWO/.test(current)) {
    let target
    for (const mcp of s.mcps) {
      const tools = await mcp.ready
      const echo = tools.find(tool => tool.name === 'echo' || tool.name.endsWith('__echo'))
      if (echo) { target = { mcp, echo }; break }
    }
    if (!target) throw new Error('No echo MCP tool available')
    const inputs = current.includes('CALL_TWO') ? ['A', 'B'] : ['PING']
    const results = await Promise.all(inputs.map(text => target.mcp.request('tools/call', { name: target.echo.name, arguments: { text } })))
    text = 'GOT:' + results.map(result => (result.content || []).filter(part => part.type === 'text').map(part => part.text).join('')).join('|')
  } else text = `REPLY users=${s.users} history=${prompt.includes('<conversation_history>') ? 'yes' : 'no'}`
  if (s.active !== turn || closing) return
  const item = { itemId: mint(), kind: 'agentMessage', turnId: turn.id, status: 'inProgress', revision: 1, text: '' }
  event(s, 'item/started', { item })
  event(s, 'item/delta', { itemId: item.itemId, field: 'text', delta: text }, false)
  if (current.includes('SDK_PARTIAL_CRASH')) {
    setTimeout(() => void shutdown(17), 50)
    return
  }
  if (current.includes('SDK_GAP')) {
    event(s, 'view/gap', { reason: 'fixture gap' })
    return
  }
  const final = { ...item, status: 'completed', revision: 2, text, messagePhase: 'finalAnswer' }
  s.items.push(final)
  event(s, 'item/completed', { item: final })
  if (current.includes('SDK_USAGE')) {
    event(s, 'session/tokenUsage', { turnId: turn.id, promptTokens: 110,
      usage: { inputTokens: 70, outputTokens: 7, cachedTokens: 40, cacheReadTokens: 40, reasoningTokens: 3 } })
    event(s, 'session/tokenUsage', { turnId: turn.id, promptTokens: 80,
      usage: { inputTokens: 80, outputTokens: 7, cachedTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 3 } })
  }
  complete(s, turn)
}
async function dispatch(frame) {
  const { id, method, params: p = {} } = frame
  if (typeof method !== 'string') return
  const safeParams = {}
  for (const key of ['sessionId', 'commandId', 'modelId', 'providerId', 'reasoningEffort']) {
    if (typeof p[key] === 'string') safeParams[key] = p[key]
  }
  if (p.model && typeof p.model === 'object') {
    safeParams.model = Object.fromEntries(['providerId', 'modelId'].filter(key => typeof p.model[key] === 'string').map(key => [key, p.model[key]]))
  }
  log({ type: 'rpc', method, params: safeParams })
  if (method === 'initialized') return
  if (method === 'initialize') {
    reply(id, { experimentalApi: false, grantedCapabilities: denyCap ? [] : ['sessionMcp'], museHome: process.cwd(), platformFamily: 'unix', platformOs: process.platform === 'darwin' ? 'macos' : 'linux', schema: { version: 1, fingerprint: EXPECTED_SCHEMA_FINGERPRINT }, serverInfo: { name: 'fake-muse', version: '1.4.14' }, sessionDurability: 'ephemeral', userAgent: 'fake-muse/1.4.14' }); return
  }
  if (method === 'model/list') {
    reply(id, { providerId: 'meta', profileId: 'meta', source: 'fakeCatalog', models: [
      { modelId: 'muse-spark-1.3', displayLabel: 'Muse Spark 1.3', providerId: 'meta', profileId: 'meta', isDefault: true, isActive: !!p.sessionId, contextLimit: 128000, outputLimit: 32000, cost: null, description: 'Deterministic SDK fixture', releaseDate: null, variants: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
      { modelId: 'muse-spark-1.2', displayLabel: 'Muse Spark 1.2', providerId: 'meta', profileId: 'meta', isDefault: false, isActive: false, contextLimit: 128000, outputLimit: 32000, cost: null, description: 'Deterministic SDK fixture', releaseDate: null, variants: ['low', 'medium', 'high'], defaultReasoningEffort: 'medium' },
    ] }); return
  }
  if (method === 'session/start') {
    if (denyCap && p.config?.mcpServers) { refuse(id, -32010, 'sessionMcp capability required', { kind: 'capabilityRequired', capability: 'sessionMcp' }); return }
    const sessionId = p.sessionId || mint()
    const s = { session: { sessionId, activeTurnId: null, createdAt: timestamp, updatedAt: timestamp, forkedFrom: null, modelId: p.modelId || 'muse-spark-1.3', providerId: p.providerId || 'meta', path: '', status: 'idle', turnCount: 0, workspaceRoot: p.workspaceRoot || p.workspaceRoots?.[0] || process.cwd() }, cursor: 0, users: 0, items: [], mcps: [], active: null, config: p.config || {} }
    let hostServers = {}
    try { hostServers = JSON.parse(readFileSync(path.join(process.env.XDG_CONFIG_HOME, 'muse/settings.json'), 'utf8')).mcpServers || {} } catch {}
    s.mcps = Object.values({ ...hostServers, ...s.config.mcpServers }).map(config =>
      mcpClient({ ...config, transport: config.transport || config.type }, s.session.workspaceRoot))
    sessions.set(sessionId, s)
    reply(id, { session: s.session, viewCursor: cursor(s) }); return
  }
  if (method === 'session/resume' && process.env.MUSE_SDK_TEST_RESUME_BUSY === '1') {
    refuse(id, -32021, 'Session belongs to a different host', { kind: 'sessionInUse' }); return
  }
  const s = sessions.get(p.sessionId)
  if (!s) { refuse(id, -32011, 'Session not found', { kind: 'notFound' }); return }
  if (method === 'session/resume' || method === 'session/read') {
    if (p.modelId) s.session.modelId = p.modelId
    reply(id, { session: s.session, viewCursor: cursor(s), pendingRequests: [], history: p.excludeItems ? { mode: 'none', items: null, snapshot: null, noneReason: 'excluded' } : { mode: 'inline', items: s.items, snapshot: null } }); return
  }
  if (method === 'session/setModel') {
    s.session.modelId = p.model.modelId
    s.session.providerId = p.model.providerId || 'meta'
    reply(id, { commandId: p.commandId, status: 'accepted' })
    event(s, 'session/modelChanged', { modelId: s.session.modelId, providerId: s.session.providerId, source: 'user' }); return
  }
  if (method === 'session/setReasoningEffort') {
    s.session.reasoningEffort = p.reasoningEffort
    reply(id, { commandId: p.commandId, status: 'accepted' }); return
  }
  if (method === 'turn/cancel' || method === 'turn/interrupt') {
    const turn = s.active
    if (!turn || (p.turnId && p.turnId !== turn.id)) { refuse(id, -32030, 'No matching active turn', { kind: 'commandRejected' }); return }
    reply(id, { commandId: p.commandId, status: 'accepted', turnId: turn.id })
    complete(s, turn, 'cancelled'); return
  }
  if (method === 'turn/start') {
    const prompt = (p.input || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n')
    if (currentTurn(prompt).includes('SDK_UNSUPPORTED')) { refuse(id, -32601, 'SDK surface unsupported (fixture)'); return }
    if (s.active) { refuse(id, -32030, 'Session busy', { kind: 'commandRejected' }); return }
    const turn = { id: p.commandId || mint(), input: p.input || [] }
    s.active = turn
    s.users++
    s.session.activeTurnId = turn.id
    s.session.status = 'running'
    reply(id, { commandId: p.commandId, status: 'accepted', disposition: currentTurn(prompt).includes('SDK_QUEUE') ? 'queued' : 'started', startedNewTurn: true, turnId: turn.id })
    setImmediate(() => run(s, turn, prompt).catch(() => complete(s, turn, 'failed', { kind: 'mcpLinkError', message: 'Fixture MCP request failed', retryable: false })))
    return
  }
  refuse(id, -32601, 'Method not found')
}
async function shutdown(code = 0) {
  if (closing) return
  closing = true
  await Promise.all([...children].map(child => new Promise(resolve => {
    child.once('exit', resolve)
    child.stdin.end()
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 500)
    child.once('exit', () => clearTimeout(timer))
  })))
  process.exit(code)
}
process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())
process.stdout.on('error', () => void shutdown())
if (process.argv.includes('SDK_UNSUPPORTED')) {
  process.stderr.write('fake-muse: SDK surface unavailable\n')
  process.exit(5)
}
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
lines.on('line', line => {
  let frame
  try { frame = JSON.parse(line) } catch { refuse(null, -32700, 'Parse error'); return }
  void dispatch(frame).catch(() => refuse(frame?.id ?? null, -32603, 'Fixture request failed'))
})
lines.on('close', () => void shutdown())
