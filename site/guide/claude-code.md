# Use it from Claude Code

The Parley bridge exposes any Parley services as an MCP server. Claude Code, Claude Desktop, Cursor and other MCP clients can use them today, and tool results come back as [Lens](/guide/lens).

```sh
parley init
parley grant --svc cal.example.com --svc shop.example --risk low --per 25USD --spend 100USD --exp 24h
claude mcp add parley -- npx parley-protocol mcp parley://127.0.0.1:7447 https://shop.example/parley
```

To try it against the example calendar and shop, run `parley examples`. It serves them on ports 7447 and 7449, trusting your principal key.

## What the model gets

Four generic tools (ask, intent, commit, undo) and each service's brief. The model needs no Parley documentation: in [a real session](/reference/claude-session), Claude Sonnet 5 read Lens cold, moved a meeting within policy, stopped at a purchase over its limit and asked the human to approve it.

## When a commit needs consent

The bridge never approves on the model's behalf.

- If the client supports MCP elicitation, the bridge asks **the human** in the client's UI and shows the exact effects.
- Otherwise it tells the model to ask the human to run `parley approve <pc1.code>`. That command shows the proposal's actual effects, re-checks its hash and asks for interactive confirmation.

## Keep the principal key away from the agent

::: danger This matters more than any caveat
A grant is only as strong as the principal key's isolation. `parley init` puts the principal key and the agent key in `~/.parley` for convenience. Claude Code has shell and file access, so if it can read the principal key, it can sign its own consent.
:::

For anything that matters, keep the principal key where the agent can't reach it: another OS user, another machine, or a phone. Set `PARLEY_PRINCIPAL_HOME` to that location and approve there. The agent's machine then only holds the agent key and its grants. See the [security model](/guide/security).

Pair `--per` with `--spend`. A per-action cap alone can be dodged by splitting a purchase; `--spend` bounds the total.

## Wrap an existing REST API

```sh
parley openapi ./openapi.json --base https://api.example.com --port 7447
```

This serves any OpenAPI-described REST API as a Parley service. Reads become `ASK`s, and writes become proposals the agent must commit.
