# Changelog

## v0.1.0: first public draft

YEA (*Your Explicit Approval*) was developed as Parley before its first release, and renamed to avoid clashing with other AI-agent projects.

- **Spec v1 draft:** six verbs (`HELLO`, `ASK`, `INTENT`, `COMMIT`, `UNDO`, `EXPAND`), proposals with effects, cost, risk and undo windows, policy-gated auto-commit, grants (Ed25519 capability chains) with hash-bound consent, token budgets, and Lens, the canonical model-facing text format.
- **TypeScript reference** (`@yea-protocol/sdk` on npm, with the `yea` command in `@yea-protocol/cli`): zero dependencies. Service and client, TCP/TLS/stdio/HTTP transports, the `yea` CLI, and an MCP bridge for Claude Code and other MCP clients.
- **Python implementation** (`yea-sdk` on PyPI, `import yea`): passes every conformance vector and interoperates with TS in both directions.
- **OpenAPI adapter:** `yea openapi <spec>` serves any REST API as a YEA service, with writes as previewed, consent-gated proposals.
- **One-command setup:** `yea install` registers the MCP bridge and agent instructions with Claude Code, Claude Desktop, Cursor, Windsurf, Gemini CLI, VS Code and Codex. `yea doctor` checks everything, and `yea uninstall` restores configs byte-for-byte.
- **`yea test-drive`:** watch a real Claude model use YEA live, approving its purchases in your terminal.
- **Distribution:** a Claude Code plugin (`/plugin marketplace add yea-protocol/yea`), an MCP registry entry (`io.github.yea-protocol/yea`), a Docker image (`ghcr.io/yea-protocol/yea`), and attested releases with SHA256SUMS.
- **Conformance vectors** for canonical JSON, keys, hashes, proofs, grants, Lens and token estimates.
- **Benchmark:** 32% fewer total input tokens than minified-JSON REST MCP across four tasks, with honest caveats.
- **Security:** an adversarial audit's 15 findings are fixed, with regression tests.
