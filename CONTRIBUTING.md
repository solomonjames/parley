# Contributing

Parley is a protocol first. The most valuable contributions right now are:

1. **Spec feedback.** Open an issue quoting the SPEC.md section. Ambiguities are bugs.
2. **New implementations.** Go, Rust, Swift, Kotlin. `conformance/*.json` is the contract:
   pass every vector, then interoperate with `examples/serve.ts` (TS) or
   `python/examples/serve.py`.
3. **Services.** Wrap something real and tell us where the protocol got in your way.

## Changing the protocol

Any change to SPEC.md that affects bytes on the wire or Lens output must:

- update the TypeScript reference in `ts/src`,
- regenerate vectors with `cd ts && npm run build && node scripts/vectors.mjs`,
- keep the Python implementation passing (`cd python && uv run pytest`), which runs both interop directions.

CI fails if the committed vectors don't match the reference implementation.

## Dev loop

```sh
npm install && npm run build && npm test     # TypeScript
cd python && uv run pytest                   # Python
npm run demo && npm run bench
```
