/**
 * MCP bridge: expose Parley services as an MCP server over stdio, so any MCP client
 * (Claude Code, Claude Desktop, Cursor, …) can speak Parley today. Tool results are Lens.
 * Consent requests are routed to the human via MCP elicitation when the client supports
 * it; the model itself can never approve.
 */
import { createToolHost, TOOLS } from "./tools.js";
import type { Client } from "./client.js";

export { INSTRUCTIONS, TOOLS } from "./tools.js";

const VERSION = "0.1.0";
type Json = Record<string, any>;

export async function runMcpBridge(clients: Client[], io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout }) {
  let clientCaps: Json = {};
  let nextId = 1;
  const waiting = new Map<number, (r: Json) => void>();
  const write = (m: Json) => io.output.write(JSON.stringify(m) + "\n");
  const request = (method: string, params: Json, timeoutMs = 10 * 60_000) =>
    new Promise<Json>((resolve) => {
      const id = nextId++;
      const timer = setTimeout(() => (waiting.delete(id), resolve({})), timeoutMs); // no answer = no approval
      waiting.set(id, (r) => (clearTimeout(timer), waiting.delete(id), resolve(r)));
      write({ jsonrpc: "2.0", id: `parley-${id}`, method, params });
    });

  // Consent goes to the human through MCP elicitation, when the client supports it.
  const host = await createToolHost(clients, async ({ service, shown, reason }) => {
    if (!clientCaps.elicitation) return false;
    const res = await request("elicitation/create", {
      message: `Approve this action at ${service}?\n\n${shown}\n\nWhy you're asked: ${reason}`,
      requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve", description: "Sign a one-time consent for exactly this proposal" } }, required: ["approve"] },
    });
    return res.result?.action === "accept" && res.result?.content?.approve === true;
  });
  const { instructions, call } = host;

  let buf = "";
  let inflight = 0;
  let ended = false;
  const maybeExit = () => {
    if (ended && inflight === 0) {
      host.close();
      done();
    }
  };
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  io.input.on("end", () => {
    ended = true;
    maybeExit();
  });
  io.input.setEncoding?.("utf8");
  io.input.on("data", (chunk: string) => {
    buf += chunk;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let m: Json;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof m.id === "string" && m.id.startsWith("parley-") && !m.method) {
        waiting.get(Number(m.id.slice(7)))?.(m);
        continue;
      }
      inflight++;
      void handle(m).finally(() => {
        inflight--;
        maybeExit();
      });
    }
  });
  await finished;

  async function handle(m: Json) {
    const reply = (result: Json) => write({ jsonrpc: "2.0", id: m.id, result });
    switch (m.method) {
      case "initialize":
        clientCaps = m.params?.capabilities ?? {};
        return reply({ protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "parley-bridge", version: VERSION }, instructions });
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS });
      case "tools/call":
        try {
          const r = await call(m.params.name, m.params.arguments ?? {});
          return reply({ content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) });
        } catch (e) {
          return reply({ content: [{ type: "text", text: `✗ transport: ${(e as Error).message}` }], isError: true });
        }
      default:
        if (m.id !== undefined) write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
    }
  }
}

