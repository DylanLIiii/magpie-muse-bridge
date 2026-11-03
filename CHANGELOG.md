# Changelog

## 0.2.1

- Offer existing Muse login inside the main UI sign-in flow as well as the
  keyless method, including UI paths that open the first auth method directly.
- Keep SDK conversations when the requested Muse model changes by using MSP
  `session/setModel`; only history, workspace or MCP tool-definition changes
  require a new session and replay.
- Canonically compare MCP tool definitions so equivalent JSON key ordering does
  not trigger an unnecessary session rebuild.
- Report Muse subscription allowance through Magpie's usage hook, including
  current/weekly percentages, reset times, tier and snapshot time. Read only
  `muse usage --json`; explain missing server data without inventing a quota.

## 0.2.0

- Add Magpie browser/device sign-in through the official `muse login` CLI, plus
  keyless reuse of existing Muse sign-in. Magpie stores only a connection marker.
  Handle cancellation, expiry, replaced attempts, verification and plugin exit;
  keep Magpie disconnect separate from the shared CLI's `muse logout`.
- Default to official `@muse-code/sdk` 1.4.14 with a persistent
  `muse serve --preset empty` host per conversation.
- Configure client tools in each conversation's private host settings, including
  native MCP timeouts above the client's wait budget. Keep live MCP calls
  pending across HTTP `tool_use` / `tool_result` round trips.
- Reuse native sessions between turns and resume durable sessions after an idle
  host exits. Rebuild context when caller history or tool schemas change.
- Recover definitively missing sessions in the same HTTP request by replaying
  caller history. Never replay a session that another host owns.
- Withhold native user questions and disable bundled reminder observers. Real
  host tests check that only client MCP tools reach the model.
- Forward text, native image parts and counted-once token usage; surface
  authentication, quota, host-loss and capability failures.
- Normalize classified SDK errors before any model output, propagate credential
  refreshes promptly, normalize JPEG media types, and synchronously terminate
  owned host groups when the plugin process exits.
- Keep the original implementation available with `MUSE_BRIDGE_TRANSPORT=exec`.
- Add offline SDK/MCP tests and CI. SDK and CLI tests use local fake providers;
  real subscription authentication and billing remain unverified.

The public Muse SDK does not expose system-prompt replacement. External system
instructions remain user-input context, rather than replacing native instructions.
