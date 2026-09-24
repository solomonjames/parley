# Changelog

## v0.1.0: first public draft

- **Spec v1 draft:** six verbs (`HELLO`, `ASK`, `INTENT`, `COMMIT`, `UNDO`, `EXPAND`), proposals with effects, cost, risk and undo windows, policy-gated auto-commit, grants (Ed25519 capability chains) with hash-bound consent, token budgets, and Lens, the canonical model-facing text format.
- **TypeScript reference** (`parley-protocol` on npm): zero dependencies. Service and client, TCP/TLS/stdio/HTTP transports, the `parley` CLI, and an MCP bridge for Claude Code and other MCP clients.
- **Python implementation** (`parley-protocol` on PyPI): passes every conformance vector and interoperates with TS in both directions.
- **OpenAPI adapter:** `parley openapi <spec>` serves any REST API as a Parley service, with writes as previewed, consent-gated proposals.
- **Conformance vectors** for canonical JSON, keys, hashes, proofs, grants, Lens and token estimates.
- **Benchmark:** 34% fewer total input tokens than minified-JSON REST MCP across four tasks, with honest caveats.
- **Security:** an adversarial audit's 15 findings are fixed, with regression tests.
