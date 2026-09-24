/**
 * `parley setup <client>`: register the Parley MCP bridge with an AI tool, and
 * `parley add/remove/services`: manage the services it exposes (~/.parley/services.json).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { home } from "./home.js";

export const BRIDGE = { command: "npx", args: ["-y", "parley-protocol", "mcp"] };

// ---- services registry ----
const servicesFile = () => join(home(), "services.json");

export function listServices(): string[] {
  try {
    const v = JSON.parse(readFileSync(servicesFile(), "utf8"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveServices(urls: string[]) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  writeFileSync(servicesFile(), JSON.stringify([...new Set(urls)], null, 2) + "\n");
}

export const addService = (url: string) => saveServices([...listServices(), url]);
export const removeService = (url: string) => saveServices(listServices().filter((u) => u !== url));

// ---- clients ----
interface Client {
  name: string;
  /** Returns a one-line description of what was done. */
  install(): string;
  detect(): boolean;
}

const has = (cmd: string) => {
  try {
    execFileSync(platform() === "win32" ? "where" : "which", [cmd], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

function mergeJson(file: string, key: string) {
  let cfg: Record<string, any> = {};
  if (existsSync(file)) {
    try {
      cfg = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      throw new Error(`${file} isn't valid JSON; fix it or add the server by hand`);
    }
  }
  cfg[key] = { ...(cfg[key] ?? {}), parley: { ...BRIDGE } };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
  return `added "parley" to ${file}`;
}

const appData = () => process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
const claudeDesktopConfig = () =>
  platform() === "darwin" ? join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json")
  : platform() === "win32" ? join(appData(), "Claude", "claude_desktop_config.json")
  : join(homedir(), ".config", "Claude", "claude_desktop_config.json");

export const CLIENTS: Record<string, Client> = {
  "claude-code": {
    name: "Claude Code",
    detect: () => has("claude"),
    install: () => {
      execFileSync("claude", ["mcp", "add", "--scope", "user", "parley", "--", BRIDGE.command, ...BRIDGE.args], { stdio: "ignore" });
      return "ran: claude mcp add --scope user parley -- npx -y parley-protocol mcp";
    },
  },
  "claude-desktop": { name: "Claude Desktop", detect: () => existsSync(dirname(claudeDesktopConfig())), install: () => mergeJson(claudeDesktopConfig(), "mcpServers") },
  cursor: { name: "Cursor", detect: () => existsSync(join(homedir(), ".cursor")), install: () => mergeJson(join(homedir(), ".cursor", "mcp.json"), "mcpServers") },
  windsurf: { name: "Windsurf", detect: () => existsSync(join(homedir(), ".codeium", "windsurf")), install: () => mergeJson(join(homedir(), ".codeium", "windsurf", "mcp_config.json"), "mcpServers") },
  gemini: { name: "Gemini CLI", detect: () => existsSync(join(homedir(), ".gemini")), install: () => mergeJson(join(homedir(), ".gemini", "settings.json"), "mcpServers") },
  vscode: {
    name: "VS Code",
    detect: () => has("code"),
    install: () => {
      execFileSync("code", ["--add-mcp", JSON.stringify({ name: "parley", ...BRIDGE })], { stdio: "ignore" });
      return "ran: code --add-mcp {parley}";
    },
  },
  codex: {
    name: "Codex CLI",
    detect: () => existsSync(join(homedir(), ".codex")),
    install: () => {
      const file = join(homedir(), ".codex", "config.toml");
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (/^\[mcp_servers\.parley\]/m.test(current)) return `${file} already has [mcp_servers.parley]`;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, current + `${current && !current.endsWith("\n") ? "\n" : ""}\n[mcp_servers.parley]\ncommand = "npx"\nargs = ["-y", "parley-protocol", "mcp"]\n`);
      return `added [mcp_servers.parley] to ${file}`;
    },
  },
};

export function detectedClients(): string[] {
  return Object.entries(CLIENTS).filter(([, c]) => c.detect()).map(([k]) => k);
}
