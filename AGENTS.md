# Development and verification

- Run manual test suites and real Muse integration tests on the Macmini. The
  user maintains a real, working Muse browser sign-in there. Use its existing
  credential through the official CLI; keep credentials on that machine.
- The verified SSH command is `ssh -l dylanli 100.113.179.55`
  (Tailscale). Non-interactive SSH needs
  `PATH="$HOME/.local/bin:/opt/homebrew/bin:$HOME/.bun/bin:$PATH"`.
- macOS Keychain access can differ between SSH and the logged-in GUI session.
  If Muse reports a locked Keychain or requires approval under SSH, run the test
  in the logged-in GUI user session. Do not treat this as an expired account,
  replace the login, export secrets, or change Keychain access controls.
- Use an isolated checkout/test directory, preserve the user's Muse and Magpie
  configuration, and unset `META_API_KEY` and `MUSE_BRIDGE_BASE_URL` for the real
  browser-account test. `MUSE_TEST_LIVE=1 npm run test:live` spends real quota.
- Do not use `large-vps` as the acceptance environment. Its earlier empty-model
  results are historical diagnostics. Automated GitHub Actions checks remain
  defined in `.github/workflows/test.yml`.
- Magpie discovery uses the GitHub topic `magpie-plugin`. Package keywords
  alone do not make a GitHub plugin discoverable. `magpie.icon` in package.json
  supplies the plugin and provider icon; its embedded SVG matches `assets/meta.svg`.
