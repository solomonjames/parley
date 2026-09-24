# parley-protocol

The TypeScript reference implementation of **[Parley](https://github.com/solomonjames/parley)**, an open
protocol for AI agents acting on behalf of people. Agents state an intent, services
reply with proposals whose effects are listed up front, and the human's policy decides
what can go ahead without asking. Commits can be undone.

```sh
npm install parley-protocol
npx parley-protocol --help      # the `parley` CLI: keys, grants, consent, talking to services, MCP bridge
```

Zero runtime dependencies. Runs on Node ≥ 20, Bun and Deno, and uses only web-standard APIs.

- `parley-protocol`: `service`, `Client`, grants, Lens, budgets and the `fetchHandler` HTTP bridge
- `parley-protocol/node`: `listen` (TCP/TLS), `serveHttp`, `serveStdio` and `connect(url)`
- `parley-protocol/mcp`: `runMcpBridge`, which exposes Parley services to any MCP client

See the [main README](https://github.com/solomonjames/parley#readme) and the [spec](https://github.com/solomonjames/parley/blob/main/SPEC.md).
