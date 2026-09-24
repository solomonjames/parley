// Parley vs. a typical REST-wrapper MCP server: the same tasks, over the same data.
// Measures what the model has to read, with a real BPE tokenizer (o200k_base).
// Both sides return the same information; only the protocol differs.
import { encode } from "gpt-tokenizer/encoding/o200k_base";
import { writeFileSync } from "node:fs";
import { Client, issueGrant, keyPair, local } from "parley-protocol";
import { INSTRUCTIONS, TOOLS as PARLEY_TOOLS } from "parley-protocol/mcp";
import { calendar } from "../examples/calendar.ts";
import { shop } from "../examples/shop.ts";

const tok = (s: string) => encode(s).length;

// ---------- the Parley side: services behind the MCP bridge's tool surface ----------
const principal = await keyPair(), agent = await keyPair();
const grant = await issueGrant({ principal, to: agent.public });
const cal = new Client(local(calendar({ trust: [principal.public] })), { key: agent.seed, grants: [grant] });
const sh = new Client(local(shop({ trust: [principal.public] })), { key: agent.seed, grants: [grant] });
const briefs = [(await cal.hello(1500)).lens, (await sh.hello(1500)).lens];
const parleyDefs = JSON.stringify(PARLEY_TOOLS) + "\n" + INSTRUCTIONS + briefs.join("\n\n");

// ---------- the REST side: a conventional MCP server (one tool per endpoint, JSON in/out) ----------
const obj = (props: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties: props, required });
const S = (description?: string) => ({ type: "string", ...(description ? { description } : {}) });
const I = (description?: string) => ({ type: "integer", ...(description ? { description } : {}) });
const REST_TOOLS = [
  { name: "search_events", description: "Search calendar events by text in the title or attendee emails. Returns matching events.", inputSchema: obj({ query: S("Search text") }, ["query"]) },
  { name: "list_events", description: "List calendar events, optionally filtered to a single day (YYYY-MM-DD).", inputSchema: obj({ day: S("Day in YYYY-MM-DD format") }) },
  { name: "get_free_slots", description: "Get free time slots between 09:00 and 18:00 UTC on a day.", inputSchema: obj({ day: S("Day in YYYY-MM-DD format"), minutes: I("Slot length in minutes (default 30)") }, ["day"]) },
  { name: "update_event", description: "Update an event's start and end time. Attendees are notified.", inputSchema: obj({ id: S("Event id"), start: S("New start time, ISO 8601"), end: S("New end time, ISO 8601") }, ["id", "start", "end"]) },
  { name: "delete_event", description: "Delete (cancel) an event. Attendees are notified.", inputSchema: obj({ id: S("Event id"), note: S("Optional note to attendees") }, ["id"]) },
  { name: "create_event", description: "Create an event and invite attendees.", inputSchema: obj({ title: S(), start: S("ISO 8601"), end: S("ISO 8601"), attendees: { type: "array", items: S("email") } }, ["title", "start", "end", "attendees"]) },
  { name: "search_meals", description: "Search the meal delivery menu. Filter by text, dietary tag, or maximum calories.", inputSchema: obj({ query: S(), tag: { type: "string", enum: ["high-protein", "spicy", "vegetarian", "vegan"] }, max_cal: I("Maximum calories") }) },
  { name: "create_order", description: "Place a meal order for a delivery date. Charges the saved card.", inputSchema: obj({ items: { type: "array", items: obj({ sku: S(), qty: I() }, ["sku", "qty"]) }, deliver: S("Delivery date YYYY-MM-DD") }, ["items", "deliver"]) },
  { name: "tip_courier", description: "Tip the courier for an order. Charges the saved card.", inputSchema: obj({ order: S("Order id"), usd: { type: "number" } }, ["order", "usd"]) },
];
const restDefs = JSON.stringify(REST_TOOLS);

// REST payloads are built from the *same* data the Parley services return.
const data = async (c: Client, cap: string, params: Record<string, unknown>) => {
  const r = await c.ask(cap, params, { budget: 1e6 });
  if (r.kind !== "ANSWER") throw new Error(r.lens);
  return r.data as any;
};
const restEvent = (e: any) => ({ id: e.id, title: e.title, start: e.start, end: e.end, attendees: e.with.split(" ") });

type Call = { args: unknown; result: string };
interface Run { calls: Call[] }
const DAY = new Date(Date.now() + 3 * 86400e3).toISOString().slice(0, 10);

async function tasks(pretty: boolean) {
  const J = (v: unknown) => (pretty ? JSON.stringify(v, null, 2) : JSON.stringify(v));
  const out: Record<string, { rest: Run; parley: Run }> = {};

  // 1. Reschedule a meeting into a free slot.
  {
    const ev = (await data(cal, "calendar.agenda", { query: "1:1 Ana" })).map(restEvent);
    const free = await data(cal, "calendar.free", { day: DAY, minutes: 30 });
    const moved = { ...ev[0], start: free.slots[0], end: new Date(Date.parse(free.slots[0]) + 1800e3).toISOString().replace(".000Z", "Z"), updated: true };
    const rest: Run = { calls: [
      { args: { name: "search_events", arguments: { query: "1:1 Ana" } }, result: J(ev) },
      { args: { name: "get_free_slots", arguments: { day: DAY, minutes: 30 } }, result: J(free) },
      { args: { name: "update_event", arguments: { id: ev[0].id, start: moved.start, end: moved.end } }, result: J(moved) },
    ] };
    // Parley: one INTENT; the grant allows low-risk undoable changes, so it auto-commits.
    const intentArgs = { service: "calendar.example", capability: "calendar.reschedule", params: { event: "1:1 Ana", day: DAY }, auto: true };
    const r = await cal.intent("calendar.reschedule", intentArgs.params, { auto: true });
    if (r.kind !== "RECEIPT") throw new Error(r.lens);
    await cal.undo(r.receipt.id); // keep data identical across runs
    out["Reschedule a meeting into a free slot"] = { rest, parley: { calls: [
      { args: { name: "parley_intent", arguments: intentArgs }, result: r.lens },
    ] } };
  }

  // 2. Find vegan meals under 700 kcal and order four.
  {
    const found = await data(sh, "shop.search", { tag: "vegan", max_cal: 700 });
    const items = found.slice(0, 2).map((m: any) => ({ sku: m.sku, qty: 2 }));
    const lines = items.map((it: any) => { const m = found.find((f: any) => f.sku === it.sku); return { sku: m.sku, name: m.name, qty: it.qty, unit_price: m.usd }; });
    const subtotal = Math.round(lines.reduce((s: number, l: any) => s + l.unit_price * 100 * l.qty, 0)) / 100;
    const order = { id: "o1001", status: "placed", deliver: DAY, items: lines, subtotal, delivery_fee: subtotal >= 50 ? 0 : 5.99, total: Math.round((subtotal + (subtotal >= 50 ? 0 : 5.99)) * 100) / 100, currency: "USD", cancellable_until: new Date(Date.now() + 7200e3).toISOString() };
    const rest: Run = { calls: [
      { args: { name: "search_meals", arguments: { tag: "vegan", max_cal: 700 } }, result: J(found.map((m: any) => ({ sku: m.sku, name: m.name, price_usd: m.usd, calories: m.cal, protein_g: m.protein }))) },
      { args: { name: "create_order", arguments: { items, deliver: DAY } }, result: J(order) },
    ] };
    const askArgs = { service: "shop.example", capability: "shop.search", params: { tag: "vegan", max_cal: 700 } };
    const a = await sh.ask("shop.search", askArgs.params, { budget: 1500 });
    const intentArgs = { service: "shop.example", capability: "shop.order", params: { items, deliver: DAY }, auto: true };
    const r = await sh.intent("shop.order", intentArgs.params, { auto: true });
    if (r.kind !== "RECEIPT") throw new Error(r.lens);
    out["Find vegan meals < 700 kcal and order four"] = { rest, parley: { calls: [
      { args: { name: "parley_ask", arguments: askArgs }, result: a.lens },
      { args: { name: "parley_intent", arguments: intentArgs }, result: r.lens },
    ] } };
  }

  // 3. Read the whole 60-item menu (same content both ways; pure encoding cost).
  {
    const all = await data(sh, "shop.search", {});
    const a = await sh.ask("shop.search", {}, { budget: 1e6 });
    out["Read the full 60-item menu"] = {
      rest: { calls: [{ args: { name: "search_meals", arguments: {} }, result: J(all.map((m: any) => ({ sku: m.sku, name: m.name, price_usd: m.usd, calories: m.cal, protein_g: m.protein }))) }] },
      parley: { calls: [{ args: { name: "parley_ask", arguments: { service: "shop.example", capability: "shop.search", params: {} } }, result: a.lens }] },
    };
  }

  // 4. Skim the menu within an 800-token budget (Parley fits the reply, leaves an EXPAND handle).
  {
    const all = await data(sh, "shop.search", {});
    const a = await sh.ask("shop.search", {}, { budget: 800 });
    out["Skim the menu (800-token budget)"] = {
      rest: { calls: [{ args: { name: "search_meals", arguments: {} }, result: J(all.map((m: any) => ({ sku: m.sku, name: m.name, price_usd: m.usd, calories: m.cal, protein_g: m.protein }))) }] },
      parley: { calls: [{ args: { name: "parley_ask", arguments: { service: "shop.example", capability: "shop.search", params: {} } }, result: a.lens }] },
    };
  }
  return out;
}

/** What the model pays: every turn re-reads tool definitions + the conversation so far. */
function cost(defs: string, run: Run) {
  const d = tok(defs);
  let history = 0, cumulative = 0, read = 0;
  for (const c of run.calls) {
    cumulative += d + history; // input tokens for the turn that emits this call
    const call = tok(JSON.stringify(c.args)), res = tok(c.result);
    history += call + res;
    read += res;
  }
  cumulative += d + history; // final turn: answer the user
  return { calls: run.calls.length, read, cumulative, defs: d };
}

const lines: string[] = [];
const log = (s = "") => (console.log(s), lines.push(s));
log(`# Parley vs REST-style MCP — token benchmark\n`);
log(`Tokenizer: o200k_base (gpt-tokenizer). Claude's tokenizer differs, but ratios are what matter here. Same data on both sides.\n`);
log(`Tool definitions in context every turn: **REST MCP ${tok(restDefs)} tokens** (9 tools) vs **Parley ${tok(parleyDefs)} tokens** (4 generic tools + service briefs).\n`);
for (const pretty of [true, false]) {
  const t = await tasks(pretty);
  log(`## REST results ${pretty ? "pretty-printed (`JSON.stringify(x, null, 2)`, the common MCP default)" : "minified JSON (best case for REST)"}\n`);
  log(`| Task | Calls (REST → Parley) | Result tokens read (REST → Parley) | Total input tokens over the task (REST → Parley) | Saved |`);
  log(`|---|---|---|---|---|`);
  let R = 0, Pp = 0;
  for (const [name, { rest, parley }] of Object.entries(t)) {
    const r = cost(restDefs, rest), p = cost(parleyDefs, parley);
    R += r.cumulative; Pp += p.cumulative;
    log(`| ${name} | ${r.calls} → ${p.calls} | ${r.read} → ${p.read} (${Math.round((1 - p.read / r.read) * 100)}% less) | ${r.cumulative} → ${p.cumulative} | **${Math.round((1 - p.cumulative / r.cumulative) * 100)}%** |`);
  }
  log(`| **All tasks** | | | ${R} → ${Pp} | **${Math.round((1 - Pp / R) * 100)}%** |\n`);
}

const t = await tasks(true);
log(`## What the model actually reads\n`);
log(`### Reschedule, REST (3 calls)\n\n\`\`\`json\n${t["Reschedule a meeting into a free slot"].rest.calls.map((c) => c.result).join("\n\n")}\n\`\`\`\n`);
log(`### Reschedule, Parley (1 call)\n\n\`\`\`\n${t["Reschedule a meeting into a free slot"].parley.calls.map((c) => c.result).join("\n\n")}\n\`\`\`\n`);
log(`Tokens are only half the story. The REST agent moved the meeting blind: no preview of the invite that goes to Ana, no undo, and a key that can do anything. The Parley agent acted only because the principal's grant allows low-risk, undoable changes. It got back exactly what happened and a 24h undo window, and anything costlier or irreversible would have stopped for review.`);

writeFileSync(new URL("./RESULTS.md", import.meta.url), lines.join("\n") + "\n");
