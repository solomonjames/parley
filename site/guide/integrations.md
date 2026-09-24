# Integrations

Parley reaches any MCP client through the bridge, `parley mcp`. One command sets it up:

```sh
npx parley-protocol install                  # detects your AI tools and configures each one
npx parley-protocol install --target cursor --local   # one tool, this project only
```

`install` (alias: `setup`) creates an agent key, a starter policy (low-risk actions, up to 25.00 USD each and 100.00 USD in total, for 30 days; anything else asks you), and registers the bridge with each tool. For Claude Code, Codex, Gemini CLI and Cursor it also writes a short, marker-fenced `PARLEY` block of agent instructions, because subagents don't see MCP server instructions. Add services with `parley add <url>`; the bridge serves everything in `parley services`.

::: warning Before you rely on it
`install` creates the principal key on the same machine for convenience, and warns you, because an agent with shell access could read it. For real use, pass `--no-principal` and keep the principal key on another OS user or device, issuing the grant from there ([security model](/guide/security)).
:::

## Configure by hand

Every client runs the same command: `npx -y parley-protocol mcp`, optionally followed by service URLs. With no URLs, it serves the services you added with `parley add`.

::: danger Don't auto-approve commits
Whatever the client, don't add `parley_commit` or `parley_undo` to an auto-approve or "trusted" list. Your client's own confirmation is a second check on top of your signed policy. Auto-approving `parley_ask` is fine: it's read-only by definition.
:::

### Claude Code

```sh
claude mcp add parley -- npx -y parley-protocol mcp
```

Or in `.mcp.json` (project) or `~/.claude.json` (user):

```json
{
  "mcpServers": {
    "parley": { "type": "stdio", "command": "npx", "args": ["-y", "parley-protocol", "mcp"], "alwaysLoad": true }
  }
}
```

`alwaysLoad` keeps the Parley tools out of Claude Code's deferred tool search, so the model sees them from the first turn.

### Claude Desktop

`claude_desktop_config.json`, in `~/Library/Application Support/Claude/` (macOS), `%APPDATA%\Claude\` (Windows) or `~/.config/Claude/` (Linux):

```json
{
  "mcpServers": {
    "parley": { "command": "npx", "args": ["-y", "parley-protocol", "mcp"] }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project):

```json
{
  "mcpServers": {
    "parley": { "command": "npx", "args": ["-y", "parley-protocol", "mcp"] }
  }
}
```

### VS Code (GitHub Copilot)

`.vscode/mcp.json`. Note the top-level key is `servers`:

```json
{
  "servers": {
    "parley": { "type": "stdio", "command": "npx", "args": ["-y", "parley-protocol", "mcp"] }
  }
}
```

### Codex CLI

`~/.codex/config.toml`:

```toml
[mcp_servers.parley]
command = "npx"
args = ["-y", "parley-protocol", "mcp"]
```

### Gemini CLI

`~/.gemini/settings.json` (user) or `.gemini/settings.json` (project):

```json
{
  "mcpServers": {
    "parley": { "command": "npx", "args": ["-y", "parley-protocol", "mcp"] }
  }
}
```

Leave Gemini's per-server `trust` unset or `false`: `true` skips tool-call confirmations.

### Zed

In Zed's `settings.json`:

```json
{
  "context_servers": {
    "parley": { "command": "npx", "args": ["-y", "parley-protocol", "mcp"], "env": {} }
  }
}
```

### Windsurf (Devin Desktop)

Windsurf is now Devin Desktop. Its Cascade agent reads `mcp_config.json`: open it from the Cascade panel's **…** menu, **MCPs**, **Open MCP config file**.

```json
{
  "mcpServers": {
    "parley": { "command": "npx", "args": ["-y", "parley-protocol", "mcp"] }
  }
}
```

### Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) is an MCP client, so it can use Parley services directly:

```sh
hermes mcp add parley --command npx --args -y parley-protocol mcp
```

or in Hermes's `config.yaml`:

```yaml
mcp_servers:
  parley:
    command: "npx"
    args: ["-y", "parley-protocol", "mcp"]
```

Consent works well here: when a commit needs the human's approval and the client supports MCP elicitation, the bridge asks through it, and Hermes routes form-mode elicitation through its own approval surface. If you restrict which tools a server exposes (`tools.include`), include all four Parley tools; the agent needs `parley_intent` to see proposals before `parley_commit`.

## Services to try

```sh
parley examples               # the example calendar (7447) and shop (7449), trusting your principal
parley add parley://127.0.0.1:7447
parley add parley://127.0.0.1:7449
```

Or wrap an API you already use: [Wrap any REST API](/guide/openapi). Then restart your AI tool and ask it to do something.
