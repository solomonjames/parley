---
editLink: false
---

# CLI reference

The `parley` command ships with the TypeScript package: `npx parley-protocol <command>`, or `parley <command>` once it's installed globally. This is its own help text, generated from the source at build time:

<<< @/.vitepress/generated/cli-help.txt{text}

## Get started

### `parley install`

Sets Parley up for your AI tools in one step (alias: `setup`):

1. creates an agent key in `~/.parley` if there isn't one;
2. creates a principal key on this machine, unless one exists or you pass `--no-principal`, and warns that an agent with shell access could read it;
3. if you have no grants yet, signs a starter policy: low-risk actions, up to 25.00 USD each and 100.00 USD in total, for 30 days, with anything else needing your approval;
4. registers the MCP bridge with each detected tool (or those in `--target`) and, for Claude Code, Codex, Gemini CLI and Cursor (`--local`), writes a marker-fenced `PARLEY` block of agent instructions.

| Flag | Meaning |
|---|---|
| `--target a,b` | Only these tools: `claude-code`, `claude-desktop`, `cursor`, `windsurf`, `vscode`, `codex`, `gemini` |
| `--local` | Write project files (`.mcp.json`, `.cursor/mcp.json`, `CLAUDE.md`, `AGENTS.md` …) instead of user-level ones |
| `--no-principal` | Don't create a principal key here. Issue the grant from the principal's device with `parley grant --to <agent key>` |

It never auto-approves Parley's tools in any client. Exactly what gets written where is on the [integrations](/guide/integrations) page.

### `parley uninstall`

Removes the bridge and the `PARLEY` instruction blocks from each tool (or those in `--target`). Keys and grants in `~/.parley` are left in place.

### `parley add`, `remove`, `services`

`parley add <url>` sends `HELLO` to check the service, then adds it to `~/.parley/services.json`. The bridge (`parley mcp` with no URLs) serves everything in that list. Restart your AI tool after adding.

### `parley doctor`

Checks your node version, the agent key, **whether the principal key is readable on this machine** (a warning, since agents could read it too), each grant's scope, expiry and holder, each service's reachability, and which AI tools Parley is registered with. See [Troubleshooting](/guide/troubleshooting).

## Identity and policy

`parley grant` signs a grant from the principal to the agent with these caveats:

| Flag | Caveat | Example |
|---|---|---|
| `--svc <id>` | `svc`, repeatable | `--svc cal.example.com` |
| `--can <pattern>` | `can`, repeatable | `--can "calendar.*"` |
| `--verbs A,B` | `verbs` | `--verbs ASK,INTENT` |
| `--exp <duration>` | `exp` | `--exp 24h` (`s`, `m`, `h`, `d`) |
| `--per <amount>` | `per`, a per-action limit | `--per 40USD` |
| `--spend <amount>` | `spend`, a total limit | `--spend 100USD` |
| `--risk <level>` | `risk`, a ceiling | `--risk low` |
| `--to <key>` | the holder, if not your agent key | `--to ed25519:…` |

`parley delegate <token> --to <key> [caveats]` narrows a grant for a sub-agent. `parley approve <pc1.code>` shows a proposal's real effects, re-checks its hash, asks for confirmation, and signs a one-time consent for it.

## Environment

| Variable | Meaning |
|---|---|
| `PARLEY_HOME` | Where keys, grants and services live (default `~/.parley`) |
| `PARLEY_PRINCIPAL_HOME` | Where the principal key lives, if not `PARLEY_HOME`. Point it at another user's or device's storage |
| `PARLEY_TRUST` | Comma-separated principal keys that `parley examples` and `parley openapi` trust for writes (default: your own) |
| `ANTHROPIC_API_KEY` | For `parley test-drive` (or an `ant auth login` profile) |

## Try it

- `parley test-drive ["task"] [--model <id>]` runs a real Claude model (default `claude-opus-5`) against the example calendar and shop in your terminal, with a throwaway policy. Anything outside it asks you to approve. It fetches the Anthropic SDK on first use; the package itself has no runtime dependencies.
- `parley demo` is a narrated, scripted run with no API key needed.
- `parley examples [--port 7447]` serves the example calendar and shop (calendar on the port, shop on port + 2).
