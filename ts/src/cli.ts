#!/usr/bin/env node
/** parley — command line for the Parley protocol. */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { consentGrant, delegateGrant, inspectGrant, issueGrant, type Caveat } from "./grants.js";
import { agentKey, home, loadGrants, principalKey, saveGrant } from "./home.js";
import { effectLine, fmtTime, lean } from "./lens.js";
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
  parley approve <hash> --expires <unix>   sign a one-time consent for a proposal hash

talk to a service  (url: parley://host:port · parleys://… · http(s)://…/parley · "stdio:cmd args")
  parley hello  <url>
  parley ask    <url> <capability> [key=value …]
  parley intent <url> <capability> [key=value …] [--goal "…"]
  parley commit <url> <proposal-id> <hash>
  parley undo   <url> <receipt-id>
  parley expand <url> <handle>
  parley do     <url> <capability> [key=value …]   intent → choose → commit, with consent prompts

bridge
  parley mcp <url> [<url> …]               run an MCP server (stdio) exposing Parley services

caveats: --svc <id> --can <pattern> --verbs ASK,INTENT --exp 24h --per 50USD --spend 200USD --risk low|medium|high
options: --budget <tokens> --json`;

const { values: o, positionals: args } = parseArgs({
  allowPositionals: true,
  options: {
    svc: { type: "string", multiple: true }, can: { type: "string", multiple: true }, verbs: { type: "string" },
    exp: { type: "string" }, per: { type: "string" }, spend: { type: "string" }, risk: { type: "string" },
    to: { type: "string" }, goal: { type: "string" }, budget: { type: "string" }, expires: { type: "string" },
    json: { type: "boolean" }, help: { type: "boolean", short: "h" }, name: { type: "string" },
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
      const p = (await principalKey()) ?? die("no principal key");
      const hash = rest[0] ?? die("usage: parley approve <hash> --expires <unix>");
      const agent = o.to ?? (await agentKey())?.public ?? die("no agent key");
      const token = await consentGrant({ principal: p, agent, hash, expires: o.expires ? Number(o.expires) : Math.floor(Date.now() / 1000) + 600 });
      saveGrant(token, "consents", hash);
      console.log(`✓ approved ${hash} — one-time consent saved; the agent can commit now`);
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
        if (p && p.public === res.consent!.principal) {
          console.log(`\n  ${chosen.summary}\n${chosen.effects.map((e) => "    " + effectLine(e)).join("\n")}`);
          if (/^y/i.test(await rl.question("\n[principal] approve this exact proposal? [y/N] › "))) {
            const token = await consentGrant({ principal: p, agent: (await agentKey())!.public, hash: chosen.hash, expires: chosen.expires });
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
