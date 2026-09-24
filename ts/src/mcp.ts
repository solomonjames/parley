/**
 * MCP bridge: expose Parley services as an MCP server over stdio, so any MCP client
 * (Claude Code, Claude Desktop, Cursor, …) can speak Parley today. Tool results are Lens.
 * Consent requests are routed to the human via MCP elicitation when the client supports
 * it; the model itself can never approve.
 */
import { consentCode, consentGrant } from "./grants.js";
import { loadGrants, principalKey, saveGrant } from "./home.js";
import { keyPair, proposalHash } from "./crypto.js";
import { lens } from "./lens.js";
import type { Client } from "./client.js";
import type { ConsentRequest, ErrorReply, Proposal } from "./types.js";

const VERSION = "0.1.0";
type Json = Record<string, any>;

const svc = { type: "string" };
const obj = (properties: Record<string, unknown>, required: string[]) => ({ type: "object", properties, required });
export const INSTRUCTIONS = "Parley services. Read with parley_ask; change things with parley_intent then parley_commit; parley_undo reverses a receipt.\n\n";
export const TOOLS = [
  { name: "parley_ask", description: "Read (never changes anything). Pass `handle` to expand an elided result.", inputSchema: obj({ service: svc, capability: svc, params: { type: "object" }, handle: svc, budget: { type: "integer" } }, ["service"]) },
  {
    name: "parley_intent",
    description: "Request a change. Returns proposals (effects, cost, risk, undo) to commit, or a question. auto:true commits the first proposal at once if your grant allows and it is undoable.",
    inputSchema: obj({ service: svc, capability: svc, params: { type: "object" }, goal: svc, auto: { type: "boolean" }, budget: { type: "integer" } }, ["service", "capability"]),
  },
  { name: "parley_commit", description: "Execute a proposal by id, exactly as shown. Only what the user wants.", inputSchema: obj({ service: svc, proposal: svc }, ["service", "proposal"]) },
  { name: "parley_undo", description: "Undo a receipt within its undo window.", inputSchema: obj({ service: svc, receipt: svc }, ["service", "receipt"]) },
];

export async function runMcpBridge(clients: Client[], io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = { input: process.stdin, output: process.stdout }) {
  const services = new Map<string, Client>();
  // The bridge remembers each proposal's hash so the model only handles short ids,
  // while COMMIT still binds to exactly what was shown.
  const seen = new Map<string, { service: string; proposal: Proposal }>();
  const briefs: string[] = [];
  for (const c of clients) {
    const b = await c.hello(1500);
    if (b.kind !== "BRIEF") throw new Error(`HELLO failed: ${b.lens}`);
    services.set(b.service.id, c);
    briefs.push(b.lens);
  }
  const instructions = INSTRUCTIONS + briefs.join("\n\n");

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

  /**
   * The consent to sign is built from the proposal *this bridge showed the model*, never from
   * the service's error: a service must not be able to get the principal to sign for
   * something else (another hash, service, or capability) behind a friendly summary.
   */
  async function consentFor(err: ErrorReply, c: Client, p: Proposal): Promise<ConsentRequest | null> {
    const k = err.consent;
    if (!k || k.proposal !== p.id || k.hash !== p.hash || k.capability !== p.capability || k.service !== (await c.audience())) return null;
    if ((await proposalHash(p)) !== p.hash) return null;
    return { proposal: p.id, hash: p.hash, service: k.service, capability: p.capability, principal: k.principal, summary: p.summary, expires: Math.min(k.expires, p.expires) };
  }

  async function askHuman(consent: ConsentRequest, err: ErrorReply, c: Client, p: Proposal): Promise<string | null> {
    const principal = await principalKey();
    if (!clientCaps.elicitation || !principal || principal.public !== consent.principal) return null;
    const shown = lens({ parley: 1, id: "-", re: "-", kind: "PROPOSALS", proposals: [p] }).split("\n").slice(1).join("\n");
    const res = await request("elicitation/create", {
      message: `Approve this action at ${consent.service}?\n\n${shown}\n\nWhy you're asked: ${err.message}`,
      requestedSchema: { type: "object", properties: { approve: { type: "boolean", title: "Approve", description: "Sign a one-time consent for exactly this proposal" } }, required: ["approve"] },
    });
    if (res.result?.action !== "accept" || res.result?.content?.approve !== true) return null;
    if (!c.key) return null;
    const token = await consentGrant({ principal, agent: (await keyPair(c.key)).public, consent });
    saveGrant(token, "consents", consent.hash);
    return token;
  }

  async function call(name: string, a: Json): Promise<{ text: string; isError?: boolean }> {
    const c = services.get(a.service);
    if (!c) return { text: `✗ unknown service ${JSON.stringify(a.service)}; known: ${[...services.keys()].join(", ")}`, isError: true };
    const budget = a.budget ?? 1500;
    switch (name) {
      case "parley_ask":
        if (a.handle) return { text: (await c.expand(a.handle, { budget })).lens };
        if (!a.capability) return { text: (await c.hello(budget)).lens };
        return { text: (await c.ask(a.capability, a.params ?? {}, { budget })).lens };
      case "parley_intent": {
        const r = await c.intent(a.capability, a.params ?? {}, { goal: a.goal, budget, auto: a.auto === true });
        if (r.kind === "PROPOSALS") for (const p of r.proposals) seen.set(p.id, { service: a.service, proposal: p });
        return { text: r.lens };
      }
      case "parley_undo": return { text: (await c.undo(a.receipt)).lens };
      case "parley_commit": {
        const events: string[] = [];
        // Only proposals this bridge has shown can be committed: the model never supplies a hash.
        const known = seen.get(a.proposal);
        if (!known || known.service !== a.service) return { text: `✗ not_found: unknown proposal ${a.proposal} at ${a.service}; call parley_intent first`, isError: true };
        const p = known.proposal;
        let r = await c.commit(p, { grants: loadGrants("consents"), onEvent: (e) => events.push(e.lens) });
        if (r.kind === "ERROR" && r.code === "consent_required") {
          const consent = await consentFor(r, c, p);
          if (!consent) return { text: r.lens + "\n  → the service's consent request doesn't match this proposal; not asking the user to sign it.", isError: true };
          const token = await askHuman(consent, r, c, p);
          if (token) r = await c.commit(p, { grants: [token], onEvent: (e) => events.push(e.lens) });
          else if (r.kind === "ERROR") {
            return {
              text: r.lens + `\n  → only the user can approve this. Ask them to review it and run, in their own terminal: parley approve ${consentCode(consent, p)}  — then call parley_commit again.`,
              isError: true,
            };
          }
        }
        return { text: [...events, r.lens].join("\n"), isError: r.kind === "ERROR" };
      }
    }
    return { text: `✗ unknown tool ${name}`, isError: true };
  }

  let buf = "";
  let inflight = 0;
  let ended = false;
  const maybeExit = () => {
    if (ended && inflight === 0) {
      for (const c of clients) c.close();
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

