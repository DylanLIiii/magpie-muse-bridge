# Changelog

## 0.2.0

- Default to official `@muse-code/sdk` 1.4.14 with a persistent
  `muse serve --preset empty` host per conversation.
- Inject client tools through per-session MCP configuration. Keep live MCP calls
  pending across HTTP `tool_use` / `tool_result` round trips.
- Reuse native sessions between turns and resume durable sessions after an idle
  host exits. Rebuild context when caller history or tool schemas change.
- Withhold native user questions and disable bundled reminder observers. Real
  host tests check that only client MCP tools reach the model.
- Forward text, native image parts and counted-once token usage; surface
  authentication, quota, host-loss and capability failures.
- Keep the original implementation available with `MUSE_BRIDGE_TRANSPORT=exec`.
- Add offline SDK/MCP tests and CI. SDK and CLI tests use local fake providers;
  real subscription authentication and billing remain unverified.

The public Muse SDK does not expose system-prompt replacement. External system
instructions remain user-input context, rather than replacing native instructions.
