# AGENTS.md

Guidance for AI coding agents (and humans) working in this repo.

## Layout
- `SPEC.md`: the protocol. It is the source of truth; code follows it.
- `conformance/*.json`: language-neutral test vectors generated from the TS reference (`ts/scripts/vectors.mjs`).
- `ts/`: TypeScript reference implementation (npm `parley-protocol`). Zero runtime dependencies. `src/` holds the core, `src/cli.ts` the CLI, `src/tools.ts` + `src/mcp.ts` the MCP bridge, and `src/openapi.ts` the OpenAPI adapter.
- `python/`: second implementation (PyPI `parley-protocol`, import `parley`).
- `examples/`, `bench/`, `site/` (VitePress docs and playground), `deploy/demo/` (Cloudflare Worker).

## Rules
1. **Spec first.** Anything that changes bytes on the wire or Lens output needs a SPEC.md edit, regenerated vectors (`cd ts && npm run build && node scripts/vectors.mjs`), and passing TS and Python suites. CI fails if the vectors drift.
2. **Parity.** A protocol change lands in both `ts/` and `python/`. The interop tests (`ts/test/interop-python.test.ts`, `python/tests/test_interop.py`) must pass in both directions.
3. **Security.** Unknown or malformed caveats fail closed. Never add a path that signs with the principal key on an agent's behalf. Every security fix gets a regression test in `ts/test/security.test.ts`.
4. **Zero dependencies** in `ts/` at runtime. Dev dependencies are fine. `@anthropic-ai/sdk` is an optional peer used only by `parley test-drive`.
5. **Honest numbers.** Benchmarks are reproducible (`npm run bench`) and published with caveats. Don't cherry-pick.

## Commands
```sh
npm install && npm run build && npm test     # TS: unit, conformance, security, interop
cd python && uv run pytest                   # Python
npm run demo · npm run bench · npm run site  # demo, benchmark, docs site
```
