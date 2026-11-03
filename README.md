# magpie-muse-bridge

A [magpie](https://github.com/yetone/magpie) provider plugin that serves a
**Muse Code subscription through the real `muse` CLI**, instead of
impersonating it over HTTPS.

Each user turn runs one `muse exec --json` process. The client's tools reach
muse through a stdio MCP server that the bridge configures, so every request
Meta sees comes from the real CLI with its own sign-in. That avoids spoofing
the client, but it is no guarantee against account restrictions or changes to
Meta's terms (which say the subscription "works only through the Muse Code
CLI").

```
Client (OpenCode, Claude Code, Amp, ...)
  │  Anthropic Messages (POST /v1/messages)
  ▼
magpie gateway → muse-bridge provider → this plugin
  │  muse exec --json --session-id <uuid>   (JSONL events)
  │  MCP server "magpie" → client tools as mcp__magpie__<tool>
  ▼
real muse CLI → Meta Muse Code backend
```

## Requirements

- Muse Code CLI (`muse`), signed in with `muse login`. Tested against
  **muse 1.4.13**.
- magpie with OpenCode provider plugin support. Tested with **magpie 0.1.1734**.

## Install

From a local checkout:

```sh
magpie plugin add ./magpie-muse-bridge
magpie plugin login muse-bridge
```

Sign-in runs `muse usage` with the bridge's isolated config; the CLI keeps the
credentials. Models show up as `muse-bridge/<model>`:
`muse-wonder-full-1.0`, `muse-wonder-1.0`, `muse-spark-1.3`, `muse-spark-1.2`.
Thinking variants map to `--reasoning-effort` (minimal … max).

## How it works

- **One process per turn, resumed sessions.** A turn runs
  `muse exec --json --session-id <uuid> --prompt-file …`. The next user message
  starts a new process with the same session id, so muse picks up its own
  history. If the client's history differs from what the bridge recorded
  (edits, compaction, an aborted turn, a model or directory change), the bridge
  starts a new session and replays the rendered history once.
- **Real tool round trips.** When the model calls a tool, muse's MCP
  `tools/call` stays pending, and the HTTP response ends with
  `stop_reason: tool_use`. The next request's `tool_result` answers that exact
  call and the same muse run continues. Tools called together in one model
  step are handed over in one response. Tool errors, images in tool results, and
  context notices (`<system-update>`, task notifications) work the same way
  they do in the antigravity bridge.
- **Isolation.** Each conversation gets its own `XDG_CONFIG_HOME`,
  `XDG_DATA_HOME`, and `XDG_STATE_HOME`. Its `settings.json` holds only the
  bridge's MCP server, so your own MCP servers stay out, and magpie's rewrite of
  your muse `endpoint_transport` to its gateway can't loop back. Sessions don't
  appear in your `muse resume` list. `auth.json` is a symlink to your real one
  (`${XDG_CONFIG_HOME:-~/.config}/muse/auth.json`). If muse replaces the link
  with a regular file, the bridge copies it back atomically and restores the
  link. muse runs with `--preset empty`, shell, write, web tools, reminders,
  and user-input requests disabled, `--approval-mode never`, and `MUSE_LOGIN=0`,
  so it never starts an interactive login.
- **Errors you can act on.** The HTTP response waits for muse's first event
  (up to 15 s). A failure before any output, such as a lapsed sign-in, returns
  401 with `X-Magpie-Sign-In: expired`, or 429 for quota, instead of an error
  inside a 200 stream.
- **Usage.** `run.usage` is reported on the final `message_delta`, converted
  to Anthropic's convention (`input_tokens` excludes cache reads). Reasoning
  tokens go in `output_tokens_details.thinking_tokens`.

## Limitations

- **Skills load into the instructions.** muse still adds skills from
  `~/.agents/skills` to its instructions (`-c` can't turn this off), which costs
  tokens. `--no-foreign-personal-context` already keeps out Claude and Codex
  context.
- **Reasoning text isn't shown.** muse's JSONL exposes the final text, not
  reasoning summaries.
- **Images:** base64 PNG, JPEG, GIF, and WebP in the current user message go to
  `--image`. Images earlier in a replayed history become a text marker.
  Document blocks return 400.
- **User text beside a live `tool_result`** returns 400, the same as the
  antigravity bridge. Send it after the tool continuation completes.
- **Startup cost:** each turn starts a fresh muse process, which takes about
  2–3 s locally before the model call.
- **One account**, whichever one `muse login` signed in.
- **macOS Keychain:** muse may keep part of its credential in the Keychain.
  This wasn't verified with a real login. If the isolated config breaks
  sign-in, `magpie plugin login muse-bridge` fails with muse's own message.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MUSE_PATH` | `muse` on `PATH`, `~/.local/bin/muse` | CLI to run |
| `MUSE_BRIDGE_MAX_ACTIVE` | 4 | muse runs in flight at once |
| `MUSE_BRIDGE_TURN_TIMEOUT_MS` | 600000 | silence from muse before a turn fails |
| `MUSE_BRIDGE_TOOL_TIMEOUT_MS` | 1800000 | wait for a client tool result (also sets the MCP `tool_timeout_sec`) |
| `MUSE_BRIDGE_FIRST_EVENT_MS` | 15000 | how long the HTTP answer waits for muse's first event |
| `MUSE_BRIDGE_BASE_URL` | unset | passed as `--base-url` (testing against a fake upstream) |

## Development

```sh
npm run check
MUSE_TEST_BIN=/path/to/muse npm test   # test-real-muse, test-failures, test-edges; each also runs under bun
MUSE_TEST_SLOW=1 MUSE_TEST_BIN=… node test-real-muse.mjs   # adds a 75 s tool wait
MUSE_TEST_MAGPIE=1 MUSE_TEST_BIN=… node test-magpie-backend.mjs   # real model via a local magpie; spends tokens
```

The three `npm test` files drive a **real muse binary** against a local fake
Meta upstream (`test-harness.mjs`: `/muse-code/models` plus streamed
`/v1/responses`, served over raw TCP so hang-ups are seen under Bun too) with
`META_API_KEY=dummy`, so they need no Meta sign-in and send nothing off the
machine. They pass under Node and Bun with muse 1.4.13.

- `test-real-muse.mjs` (9) covers:
  - plain turns, session resume, and replay after diverged history
  - MCP tool round trips, including two calls in one step
  - OpenCode-style JSON schemas and a tool result after 75 s
  - 401 mapping, auth.json write-back, and sign-in failure
- `test-failures.mjs` (9) covers:
  - client aborts before output, mid-text, during a pending MCP call, and
    during a tool-result continuation
  - muse exiting at start, killed mid-stream, and killed while the client
    runs a tool
  - 429 retried, and persistent 429 mapped to HTTP 429
- `test-edges.mjs` (10) covers:
  - turn and tool-result timeouts
  - `MAX_ACTIVE` 503
  - images, current turn via `--image` and older ones as markers
  - tool results: `is_error`, `<system-update>` after a tool_result, renamed
    `tool_use_id` fallback, and duplicate / stale tool results (409)
  - idle eviction with history replay, and 401 fast-fail

Every failure case checks three things: muse and its MCP helper have exited,
the bridge holds no turn or tool call, and the next turn recovers.

`test-magpie-backend.mjs` is opt-in. It points muse at a magpie gateway
(`MUSE_TEST_MAGPIE_ORIGIN`, default `http://127.0.0.1:3425`, no auth) to run
a real model: a plain turn, an MCP tool round trip, and a second turn. A small
forwarder in the test flattens muse's `namespace` tools first. magpie's
`/v1/responses` returns namespaced calls as `{name, namespace}` (Codex's
form), but muse 1.4.13 only matches the flat `mcp__<server>__<tool>` name.

The plugin was also installed in an isolated **magpie 0.1.1734** host (separate
XDG dirs and gateway port). `plugin add` and keyless `plugin login` passed.
Requests to the gateway's `/v1/messages` completed a plain-text turn and a
`tool_use → tool_result → end_turn` round trip, using the real muse against the
fake upstream. None of this has been verified against Meta's real backend.

## License

MIT
