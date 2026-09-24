#!/usr/bin/env node
/** parley — command line for the Parley protocol. */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { consentGrant, decodeConsentCode, delegateGrant, inspectGrant, issueGrant, type Caveat } from "./grants.js";
import { agentKey, home, loadGrants, principalKey, saveGrant } from "./home.js";
import { effectLine, fmtTime, lean, lens } from "./lens.js";
import { proposalHash } from "./crypto.js";
import { runMcpBridge } from "./mcp.js";
import { connect } from "./node.js";
import type { Client } from "./client.js";
import type { Verb } from "./types.js";

const HELP = `parley — the protocol agents speak

identity
  parley init                              create your principal key and an agent key in ${home()}
  parley whoami                            show public keys
  parley grant [caveats]                   principal → agent grant (saved; used automatically)
  parley delegate <token> --to <key> [caveats]   attenuate a grant for a sub-agent
  parley inspect <token>                   decode a grant chain
  parley approve <pc1.code>                review and sign a one-time consent for one proposal

talk to a service  (url: parley://host:port · parleys://… · http(s)://…/parley · "stdio:cmd args")
  parley hello  <url>
  parley ask    <url> <capability> [key=value …]
  parley intent <url> <capability> [key=value …] [--goal "…"]
  parley commit <url> <proposal-id> <hash>
  parley undo   <url> <receipt-id>
  parley expand <url> <handle>
  parley do     <url> <capability> [key=value …]   intent → choose → commit, with consent prompts

try it
  parley demo                              narrated end-to-end demo (two services, consent, undo, sub-agents)
  parley examples [--port 7447]            serve the example calendar (7447) and shop (7449), trusting your principal

bridges
  parley mcp <url> [<url> …]               run an MCP server (stdio) exposing Parley services
  parley openapi <spec.json|url> [--base <url>] [--header "K: V"] [--port 7447] [--http 8080]
                                           serve any REST API as a Parley service (writes become proposals)

caveats: --svc <id> --can <pattern> --verbs ASK,INTENT --exp 24h --per 50USD --spend 200USD --risk low|medium|high
options: --budget <tokens> --json`;

const { values: o, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    svc: { type: "string", multiple: true }, can: { type: "string", multiple: true }, verbs: { type: "string" },
    exp: { type: "string" }, per: { type: "string" }, spend: { type: "string" }, risk: { type: "string" },
    to: { type: "string" }, goal: { type: "string" }, budget: { type: "string" }, expires: { type: "string" },
    json: { type: "boolean" }, help: { type: "boolean", short: "h" }, name: { type: "string" },
    base: { type: "string" }, header: { type: "string", multiple: true }, port: { type: "string" }, http: { type: "string" }, id: { type: "string" }, prefix: { type: "string" },
  },
});

const die = (msg: string): never => {
  console.error(msg);
  process.exit(1);
};

function duration(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s) ?? die(`bad duration ${s} (use e.g. 30m, 24h, 7d)`);
  return Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s"];
}
function limit(s: string) {
  const m = /^(\d+(?:\.\d{1,2})?)([A-Z]{3})$/.exec(s) ?? die(`bad amount ${s} (use e.g. 50USD)`);
  return { max: Math.round(Number(m[1]) * 100), currency: m[2] };
}
function caveats(): Caveat[] {
  const c: Caveat[] = [];
  if (o.svc) c.push({ svc: o.svc });
  if (o.can) c.push({ can: o.can });
  if (o.verbs) c.push({ verbs: o.verbs.split(",").map((v) => v.trim().toUpperCase()) as Verb[] });
  if (o.exp) c.push({ exp: Math.floor(Date.now() / 1000) + duration(o.exp) });
  if (o.per) c.push({ per: limit(o.per) });
  if (o.spend) c.push({ spend: limit(o.spend) });
  if (o.risk) c.push({ risk: o.risk as any });
  return c;
}
function kv(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    if (i < 0) die(`expected key=value, got ${p}`);
    const v = p.slice(i + 1);
    try {
      out[p.slice(0, i)] = JSON.parse(v);
    } catch {
      out[p.slice(0, i)] = v;
    }
  }
  return out;
}

async function client(url: string): Promise<Client> {
  const agent = await agentKey();
  return connect(url, { key: agent?.seed, grants: [...loadGrants("grants"), ...loadGrants("consents")], name: o.name ?? "parley-cli", budget: o.budget ? Number(o.budget) : undefined });
}
const show = (r: { lens: string }) => console.log(o.json ? JSON.stringify({ ...r, lens: undefined }, null, 2) : r.lens);

async function main() {
  const [cmd, ...rest] = args;
  if (!cmd || o.help) return console.log(HELP);
  switch (cmd) {
    case "init": {
      const p = await principalKey(true), a = await agentKey(true);
      console.log(`principal ${p!.public}\nagent     ${a!.public}\n\nnext: parley grant --exp 24h --spend 100USD --risk low`);
      return;
    }
    case "whoami": {
      const p = await principalKey(), a = await agentKey();
      console.log(`principal ${p?.public ?? "(none — run parley init)"}\nagent     ${a?.public ?? "(none)"}`);
      return;
    }
    case "grant": {
      const p = (await principalKey()) ?? die("no principal key — run parley init");
      const to = o.to ?? (await agentKey())?.public ?? die("no agent key");
      const token = await issueGrant({ principal: p, to, caveats: caveats() });
      const info = await inspectGrant(token);
      if (!o.to) saveGrant(token, "grants", info.id.slice(0, 16));
      console.log(token);
      console.error(`\ngrant ${info.id.slice(0, 16)} → ${to}\n${lean({ caveats: info.blocks[0].caveats })}${o.to ? "" : `\nsaved to ${home()}/grants`}`);
      return;
    }
    case "delegate": {
      const a = (await agentKey()) ?? die("no agent key");
      console.log(await delegateGrant(rest[0] ?? die("usage: parley delegate <token> --to <key>"), { holder: a, to: o.to ?? die("--to required"), caveats: caveats() }));
      return;
    }
    case "inspect": {
      const info = await inspectGrant(rest[0] ?? die("usage: parley inspect <token>"));
      console.log(lean({ id: info.id, principal: info.iss, holder: info.holder, chain: info.blocks.map((b) => ({ to: b.sub, issued: fmtTime(b.iat), caveats: b.caveats.map((c) => JSON.stringify(c)) })) }));
      return;
    }
    case "approve": {
      const p = (await principalKey()) ?? die("no principal key here: approve on the machine that holds it");
      const consent = decodeConsentCode(rest[0] ?? die("usage: parley approve <pc1.… code>"));
      if (consent.principal !== p.public) die(`this consent is for principal ${consent.principal}, not ${p.public}`);
      const agent = o.to ?? (await agentKey())?.public ?? die("no agent key");
      if (consent.detail) {
        const d = consent.detail;
        if (d.id !== consent.proposal || d.hash !== consent.hash || d.capability !== consent.capability || (await proposalHash(d)) !== consent.hash) die("✗ this consent code's proposal doesn't match its hash: refusing");
        console.log(`at ${consent.service}:\n` + lens({ parley: 1, id: "-", re: "-", kind: "PROPOSALS", proposals: [d] }).split("\n").slice(1).join("\n"));
      } else {
        console.log(`⚠ no proposal details in this code; only the service's summary:\n${consent.summary}\n  service: ${consent.service} · ${consent.capability} · proposal ${consent.proposal}`);
      }
      console.log(`  approval expires: ${fmtTime(consent.expires)}`);
      if (!process.stdin.isTTY) die("✗ approval needs an interactive terminal: a human has to confirm");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const ok = /^y/i.test(await rl.question("\napprove this exact action? [y/N] › "));
      rl.close();
      if (!ok) die("not approved");
      saveGrant(await consentGrant({ principal: p, agent, consent }), "consents", consent.hash);
      console.log("✓ approved: a one-time consent for this proposal only. The agent can commit now.");
      return;
    }
    case "demo": {
      const { runDemo } = await import("./examples/demo.js");
      await runDemo();
      process.exit(0);
    }
    case "examples": {
      const { calendar, shop } = await import("./examples/index.js");
      const { listen } = await import("./node.js");
      const trust = (process.env.PARLEY_TRUST ?? "").split(",").filter(Boolean);
      const p = await principalKey();
      if (p && !trust.length) trust.push(p.public);
      const port = Number(o.port ?? 7447);
      await listen(calendar({ trust }), { port });
      await listen(shop({ trust }), { port: port + 2 });
      console.error(`✓ calendar parley://127.0.0.1:${port} · shop parley://127.0.0.1:${port + 2} · trusting ${trust.length} principal(s)${trust.length ? "" : " (run parley init first to commit anything)"}\n  try: parley do parley://127.0.0.1:${port} calendar.reschedule event=Ana`);
      return;
    }
    case "openapi": {
      const { fromOpenAPI, loadOpenAPI } = await import("./openapi.js");
      const { listen, serveHttp } = await import("./node.js");
      const spec = await loadOpenAPI(rest[0] ?? die("usage: parley openapi <spec.json|url> [--base <url>]"));
      const headers = Object.fromEntries((o.header ?? []).map((h) => [h.slice(0, h.indexOf(":")).trim(), h.slice(h.indexOf(":") + 1).trim()]));
      const trust = (process.env.PARLEY_TRUST ?? "").split(",").filter(Boolean);
      const p = await principalKey();
      if (p && !trust.length) trust.push(p.public);
      const svc = fromOpenAPI(spec, { baseUrl: o.base, headers, trust, id: o.id, prefix: o.prefix });
      const port = Number(o.port ?? 7447);
      await listen(svc, { port });
      if (o.http) await serveHttp(svc, { port: Number(o.http) });
      const n = svc.capabilities.length;
      console.error(`✓ ${svc.id}: ${n} capabilities (${svc.capabilities.filter((c) => c.kind === "ask").length} ask, ${svc.capabilities.filter((c) => c.kind === "intent").length} intent)\n  parley://127.0.0.1:${port}${o.http ? `  ·  http://127.0.0.1:${o.http}/parley` : ""}\n  trusting ${trust.length} principal(s) for writes\n  try: parley hello parley://127.0.0.1:${port}`);
      return;
    }
    case "mcp": {
      if (!rest.length) die("usage: parley mcp <url> [<url> …]");
      await runMcpBridge(await Promise.all(rest.map(client)));
      process.exit(0);
    }
  }

  const [url, ...more] = rest;
  if (!url) die(HELP);
  const c = await client(url);
  const budget = o.budget ? Number(o.budget) : undefined;
  try {
    switch (cmd) {
      case "hello": show(await c.hello(budget)); break;
      case "ask": show(await c.ask(more[0], kv(more.slice(1)), { budget })); break;
      case "intent": show(await c.intent(more[0], kv(more.slice(1)), { goal: o.goal, budget })); break;
      case "commit": show(await c.commit({ id: more[0], hash: more[1] }, { onEvent: (e) => console.error(e.lens) })); break;
      case "undo": show(await c.undo(more[0], { onEvent: (e) => console.error(e.lens) })); break;
      case "expand": show(await c.expand(more[0], { budget })); break;
      case "do": await interactive(c, more[0], kv(more.slice(1))); break;
      default: die(`unknown command ${cmd}\n\n${HELP}`);
    }
  } finally {
    c.close();
  }
}

async function interactive(c: Client, capability: string, params: Record<string, unknown>) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    for (;;) {
      const r = await c.intent(capability, params, { goal: o.goal });
      console.log(r.lens);
      if (r.kind === "CLARIFY") {
        const n = Number(await rl.question("\nchoose › ")) - 1;
        Object.assign(params, r.options[n]?.params ?? die("no such option"));
        continue;
      }
      if (r.kind !== "PROPOSALS") return;
      const pick = r.proposals.length === 1 ? r.proposals[0] : r.proposals.find((p) => p.id === "") ?? null;
      let chosen = pick;
      if (!chosen) {
        const ans = await rl.question(`\ncommit which? [1-${r.proposals.length}, blank to stop] › `);
        if (!ans.trim()) return;
        chosen = r.proposals[Number(ans) - 1] ?? die("no such proposal");
      } else if (!/^y/i.test(await rl.question("\ncommit? [y/N] › "))) return;
      let res = await c.commit(chosen, { onEvent: (e) => console.log(e.lens) });
      if (res.kind === "ERROR" && res.code === "consent_required") {
        console.log(res.lens);
        const p = await principalKey();
        const k = res.consent!;
        if (k.proposal !== chosen.id || k.hash !== chosen.hash || k.capability !== chosen.capability || k.service !== (await c.audience())) die("✗ the service's consent request doesn't match the proposal shown; not signing");
        if (p && p.public === k.principal) {
          console.log(`\n  ${chosen.summary}\n${chosen.effects.map((e) => "    " + effectLine(e)).join("\n")}`);
          if (/^y/i.test(await rl.question("\n[principal] approve this exact proposal? [y/N] › "))) {
            const token = await consentGrant({ principal: p, agent: (await agentKey())!.public, consent: { ...k, expires: Math.min(k.expires, chosen.expires) } });
            res = await c.commit(chosen, { grants: [token], onEvent: (e) => console.log(e.lens) });
          }
        }
      }
      console.log(res.lens);
      return;
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => die(`✗ ${(e as Error).message}`));
