#!/usr/bin/env node
/** parley — command line for the Parley protocol. */
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { consentGrant, decodeConsentCode, delegateGrant, inspectGrant, issueGrant, type Caveat } from "./grants.js";
import { agentKey, home, loadGrants, principalKey, saveGrant } from "./home.js";
import { effectLine, fmtTime, lean, lens } from "./lens.js";
import { proposalHash } from "./crypto.js";
import { runMcpBridge } from "./mcp.js";
import { CLIENTS, addService, detectedClients, listServices, removeService } from "./setup.js";
import { connect } from "./node.js";
import type { Client } from "./client.js";
import type { Verb } from "./types.js";

const HELP = `parley — the protocol agents speak

get started
  parley install [--target claude-code,cursor,codex,gemini,vscode,windsurf,claude-desktop] [--local] [--no-principal]
                                           keys, a safe default policy, the MCP bridge and agent instructions (auto-detects tools)
  parley add <url>                         add a service for your AI tools (parley services · parley remove <url>)
  parley doctor                            check keys, grants, services and AI-tool registration
  parley uninstall [--target …]            remove Parley from your AI tools

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
  parley test-drive [--model m] ["task"]  watch a real Claude model use Parley live (needs an Anthropic API key)
  parley demo                              narrated end-to-end demo (two services, consent, undo, sub-agents)
  parley examples [--port 7447] [--host]            serve the example calendar (7447) and shop (7449), trusting your principal

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
    model: { type: "string" }, base: { type: "string" }, header: { type: "string", multiple: true }, port: { type: "string" }, http: { type: "string" }, id: { type: "string" }, prefix: { type: "string" }, target: { type: "string" }, local: { type: "boolean" }, yes: { type: "boolean", short: "y" }, "no-principal": { type: "boolean" }, host: { type: "string" },
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
    case "test-drive": {
      try {
        await import("@anthropic-ai/sdk");
      } catch {
        // Keep parley-protocol dependency-free: fetch the SDK only for this command.
        const { spawnSync } = await import("node:child_process");
        const { createRequire } = await import("node:module");
        const version = createRequire(import.meta.url)("../package.json").version;
        console.error("fetching @anthropic-ai/sdk for the test drive…");
        const r = spawnSync("npx", ["-y", "-p", "@anthropic-ai/sdk", "-p", `parley-protocol@${version}`, "parley", ...process.argv.slice(2)], { stdio: "inherit" });
        process.exit(r.status ?? 1);
      }
      const { testDrive } = await import("./testdrive.js");
      await testDrive({ model: o.model, prompt: rest.join(" ") || undefined });
      process.exit(0);
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
      await listen(calendar({ trust }), { port, host: o.host });
      await listen(shop({ trust }), { port: port + 2, host: o.host });
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
      await listen(svc, { port, host: o.host });
      if (o.http) await serveHttp(svc, { port: Number(o.http), host: o.host });
      const n = svc.capabilities.length;
      console.error(`✓ ${svc.id}: ${n} capabilities (${svc.capabilities.filter((c) => c.kind === "ask").length} ask, ${svc.capabilities.filter((c) => c.kind === "intent").length} intent)\n  parley://127.0.0.1:${port}${o.http ? `  ·  http://127.0.0.1:${o.http}/parley` : ""}\n  trusting ${trust.length} principal(s) for writes\n  try: parley hello parley://127.0.0.1:${port}`);
      return;
    }
    case "mcp": {
      // With no URLs, serve the services registered with `parley add` (~/.parley/services.json).
      const urls = rest.length ? rest : listServices();
      const clients = (await Promise.all(urls.map((u) => client(u).catch((e) => (console.error(`parley mcp: ${u}: ${(e as Error).message}`), null))))).filter((c): c is Client => !!c);
      await runMcpBridge(clients);
      process.exit(0);
    }
    case "add": {
      const url = rest[0] ?? die("usage: parley add <url>");
      const c = await client(url);
      const b = await c.hello(400);
      c.close();
      if (b.kind !== "BRIEF") return die(b.lens);
      addService(url);
      console.log(`✓ added ${b.service.name} (${b.service.id}) · ${b.capabilities.length} capabilities\n  restart your AI tool to pick it up`);
      return;
    }
    case "remove": {
      removeService(rest[0] ?? die("usage: parley remove <url>"));
      console.log(`✓ removed ${rest[0]}`);
      return;
    }
    case "services": {
      const s = listServices();
      console.log(s.length ? s.join("\n") : "no services yet: parley add <url>");
      return;
    }
    case "setup":
    case "install": {
      const scope = { local: !!o.local, cwd: process.cwd() };
      const names = o.target ? o.target.split(",").map((t) => t.trim()) : detectedClients();
      for (const n of names) if (!CLIENTS[n]) die(`unknown target ${n}; one of: ${Object.keys(CLIENTS).join(", ")}`);
      const a = (await agentKey()) ?? (await agentKey(true))!;
      console.log(`agent key   ${a.public} (${home()})`);
      let p = await principalKey();
      if (!p && !o["no-principal"]) {
        p = (await principalKey(true))!;
        console.log(`principal   ${p.public} (created here for convenience)`);
        console.log("  ⚠ an agent with shell access could read this key. For real use, keep it on another user or device: see SECURITY.md");
      } else if (p) console.log(`principal   ${p.public}`);
      else console.log(`principal   not on this machine. Issue a grant elsewhere with: parley grant --to ${a.public}`);
      if (p && !loadGrants("grants").length) {
        const caveats: Caveat[] = [{ risk: "low" }, { per: { max: 2500, currency: "USD" } }, { spend: { max: 10000, currency: "USD" } }, { exp: Math.floor(Date.now() / 1000) + 30 * 86400 }];
        const token = await issueGrant({ principal: p, to: a.public, caveats });
        saveGrant(token, "grants", (await inspectGrant(token)).id.slice(0, 16));
        console.log("policy      low-risk actions, ≤ 25.00 USD each, ≤ 100.00 USD total, 30 days. Anything else asks you. (change: parley grant …)");
      }
      if (!names.length) console.log(`\nno AI tools detected. Pick some: parley install --target ${Object.keys(CLIENTS).join(",")}`);
      for (const n of names) {
        try {
          for (const line of CLIENTS[n].install(scope)) console.log(`✓ ${CLIENTS[n].name}: ${line}`);
        } catch (e) {
          console.log(`✗ ${CLIENTS[n].name}: ${(e as Error).message}`);
        }
      }
      const s = listServices();
      console.log(s.length ? `\nservices    ${s.join(", ")}` : "\nnext: add a service with `parley add <url>`, or try the examples: `parley examples`, then `parley add parley://127.0.0.1:7447`");
      console.log("restart your AI tool, then ask it to do something. Check anything with: parley doctor");
      return;
    }
    case "uninstall": {
      const scope = { local: !!o.local, cwd: process.cwd() };
      const names = o.target ? o.target.split(",").map((t) => t.trim()) : Object.keys(CLIENTS);
      let n = 0;
      for (const name of names) {
        try {
          for (const line of CLIENTS[name]?.uninstall(scope) ?? []) {
            console.log(`✓ ${CLIENTS[name].name}: ${line}`);
            n++;
          }
        } catch (e) {
          console.log(`✗ ${CLIENTS[name]?.name ?? name}: ${(e as Error).message}`);
        }
      }
      console.log(n ? `done. Keys and grants in ${home()} were left in place (delete that folder to remove them).` : "nothing to remove.");
      return;
    }
    case "doctor": {
      const ok = (m: string) => console.log(`✓ ${m}`), warn = (m: string) => console.log(`! ${m}`), bad = (m: string) => console.log(`✗ ${m}`);
      const major = Number(process.versions.node.split(".")[0]);
      if (major >= 20) ok(`node ${process.versions.node}`);
      else bad(`node ${process.versions.node}: Parley needs node ≥ 20`);
      const a = await agentKey();
      if (a) ok(`agent key ${a.public.slice(0, 24)}…`);
      else bad("no agent key: run parley install");
      const p = await principalKey();
      if (p) warn(`principal key is readable here (${process.env.PARLEY_PRINCIPAL_HOME ?? home()}). Fine for trying things; for real use keep it away from agents (SECURITY.md)`);
      else ok("principal key is not on this machine (recommended)");
      const now = Math.floor(Date.now() / 1000);
      const grants = loadGrants("grants");
      if (!grants.length) bad("no grants: your agent can read but not act. parley grant … (or parley install)");
      for (const g of grants) {
        try {
          const info = await inspectGrant(g);
          const cav = info.blocks.flatMap((b) => b.caveats) as any[];
          const exp = Math.min(...cav.filter((c) => c.exp).map((c) => c.exp), Infinity);
          const scope = cav.find((c) => c.svc)?.svc?.join(", ") ?? "all services";
          const holder = a && info.holder === a.public ? "" : " (held by another key!)";
          if (exp !== Infinity && exp <= now) bad(`grant ${info.id.slice(0, 10)} expired ${fmtTime(exp)}${holder}`);
          else ok(`grant ${info.id.slice(0, 10)}: ${scope}; ${exp === Infinity ? "no expiry" : "expires " + fmtTime(exp)}${holder}`);
        } catch {
          bad("a saved grant is unreadable");
        }
      }
      const services = listServices();
      if (!services.length) warn("no services: parley add <url>");
      for (const u of services) {
        const t0 = Date.now();
        try {
          const c = await client(u);
          const b = await c.hello(200);
          c.close();
          if (b.kind === "BRIEF") ok(`${u}: ${b.service.name} (${Date.now() - t0} ms)`);
          else bad(`${u}: ${b.lens}`);
        } catch (e) {
          bad(`${u}: ${(e as Error).message}`);
        }
      }
      const scope = { local: !!o.local, cwd: process.cwd() };
      const installed = Object.values(CLIENTS).filter((t) => {
        try {
          return t.installed(scope);
        } catch {
          return false;
        }
      }).map((t) => t.name);
      if (installed.length) ok(`registered with: ${installed.join(", ")}`);
      else warn("not registered with any AI tool: parley install");
      return;
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
