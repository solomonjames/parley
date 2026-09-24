/**
 * Lens (SPEC §9): the canonical, compact text a model reads instead of raw JSON.
 * Deterministic: two conforming implementations produce byte-identical output.
 */
import { quote } from "./canonical.js";
import type { Effect, Money, More, ParamSchema, Proposal, Reply } from "./types.js";

const BARE = /^[A-Za-z0-9_@./+\-:() '!?&%$#*=<>~^]+$/;
const NUMERIC = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const RESERVED = new Set(["-", "true", "false", "null"]);
const pad = (n: number) => "  ".repeat(n);

const isScalar = (v: unknown): v is string | number | boolean | null =>
  v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function scalar(v: unknown): string {
  if (v === null || v === undefined) return "-";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "-";
  const s = String(v);
  if (BARE.test(s) && s[0] !== " " && s[s.length - 1] !== " " && !RESERVED.has(s) && !NUMERIC.test(s)) return s;
  return quote(s);
}

function isTable(arr: unknown[]): arr is Record<string, unknown>[] {
  if (!arr.every(isObject)) return false;
  const first = Object.keys(arr[0]);
  if (first.length === 0) return false;
  return arr.every((o) => {
    const ks = Object.keys(o);
    return ks.length === first.length && ks.every((k, i) => k === first[i]) && ks.every((k) => isScalar(o[k]));
  });
}

function entries(obj: Record<string, unknown>, n: number): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) out.push(...entry(k, v, n));
  return out;
}

function entry(key: string, v: unknown, n: number): string[] {
  const k = pad(n) + scalar(key);
  if (isScalar(v)) return [`${k}: ${scalar(v)}`];
  if (Array.isArray(v)) {
    if (v.length === 0) return [`${k}: []`];
    if (v.every(isScalar)) return [`${k}: [${v.map(scalar).join(", ")}]`];
    if (isTable(v)) {
      const cols = Object.keys(v[0]);
      return [`${k}[${v.length}]{${cols.map(scalar).join(",")}}:`, ...v.map((row) => pad(n + 1) + cols.map((c) => scalar(row[c])).join(","))];
    }
    return [`${k}[${v.length}]:`, ...v.flatMap((item) => listItem(item, n + 1))];
  }
  if (isObject(v)) {
    const body = entries(v, n + 1);
    return body.length ? [`${k}:`, ...body] : [`${k}: {}`];
  }
  return [`${k}: -`];
}

function listItem(item: unknown, n: number): string[] {
  const dash = pad(n) + "- ";
  if (isScalar(item)) return [dash + scalar(item)];
  if (Array.isArray(item)) return [dash + (item.every(isScalar) ? `[${item.map(scalar).join(", ")}]` : JSON.stringify(item))];
  if (isObject(item)) {
    const body = entries(item, n + 1);
    if (!body.length) return [dash + "{}"];
    return [dash + body[0].slice(pad(n + 1).length), ...body.slice(1)];
  }
  return [dash + "-"];
}

/** Render any JSON value in lean notation (SPEC §9.1). */
export function lean(v: unknown): string {
  if (isScalar(v)) return scalar(v);
  if (Array.isArray(v)) return entry("items", v, 0).join("\n");
  if (isObject(v)) {
    const lines = entries(v, 0);
    return lines.length ? lines.join("\n") : "{}";
  }
  return "-";
}

// ---- formatting helpers (SPEC §9.2) ----

export function fmtTime(unix: number): string {
  const iso = new Date(unix * 1000).toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
  const secs = iso.slice(17, 19);
  return iso.slice(0, 16) + (secs === "00" ? "" : ":" + secs) + "Z";
}

export function fmtDuration(s: number): string {
  if (s !== 0 && s % 86400 === 0) return `${s / 86400}d`;
  if (s !== 0 && s % 3600 === 0) return `${s / 3600}h`;
  if (s !== 0 && s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

const ZERO_DECIMAL = new Set(["JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF"]);

export function fmtMoney(m: Money | null | undefined): string {
  if (!m) return "free";
  if (ZERO_DECIMAL.has(m.currency)) return `${m.amount} ${m.currency}`;
  const neg = m.amount < 0 ? "-" : "";
  const a = Math.abs(m.amount);
  return `${neg}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")} ${m.currency}`;
}

const SYM: Record<string, string> = { create: "+", update: "~", delete: "-", send: ">", charge: "$", other: "*" };

export function effectLine(e: Effect): string {
  let s = `${SYM[e.op] ?? "*"} ${e.op} ${e.target}${e.field ? "." + e.field : ""}`;
  if (e.from !== undefined || e.to !== undefined) s += `: ${scalar(e.from ?? null)} → ${scalar(e.to ?? null)}`;
  if (e.detail) s += ` — ${e.detail}`;
  return s;
}

export function paramList(params: ParamSchema | undefined): string {
  if (!params) return "()";
  const ty = (t: ParamSchema[string]): string => (typeof t === "string" ? t : Array.isArray(t) ? `[${ty(t[0])}]` : "{" + paramList(t).slice(1, -1) + "}");
  return "(" + Object.entries(params).map(([k, t]) => `${k}: ${ty(t)}`).join(", ") + ")";
}

function moreLines(more: More[] | undefined): string[] {
  return (more ?? []).map((m) => `… ${m.remaining} more at ${m.path} — EXPAND ${m.handle} (~${m.est} tokens)`);
}

const ATTRS: [string, (p: Proposal) => string][] = [
  ["cost", (p) => fmtMoney(p.cost)],
  ["risk", (p) => p.risk],
  ["undo", (p) => (p.undo ? fmtDuration(p.undo.window) : "never")],
  ["expires", (p) => fmtTime(p.expires)],
];

function proposalsLines(ps: Proposal[]): string[] {
  // Attributes identical across all (N ≥ 2) proposals are stated once, in the header.
  const shared = ps.length >= 2 ? ATTRS.filter(([, f]) => ps.every((p) => f(p) === f(ps[0]))) : [];
  const own = ATTRS.filter((a) => !shared.includes(a));
  const out = [`${ps.length} proposal${ps.length === 1 ? "" : "s"}${shared.length ? " — " + shared.map(([k, f]) => `${k}: ${f(ps[0])}`).join(" · ") : ""}:`];
  for (const p of ps) {
    out.push(`[${p.id}] ${p.summary}`, ...p.effects.map((e) => "  " + effectLine(e)));
    if (own.length) out.push("  " + own.map(([k, f]) => `${k}: ${f(p)}`).join(" · "));
    if (p.data !== undefined) out.push(...entry("data", p.data, 1));
  }
  return out;
}

/** Render a reply frame as Lens (SPEC §9.2). */
export function lens(r: Reply): string {
  const out: string[] = [];
  switch (r.kind) {
    case "BRIEF":
      out.push(`# ${r.service.name} (${r.service.id})`);
      if (r.service.summary) out.push(r.service.summary);
      for (const c of r.capabilities) out.push(`${c.kind} ${c.name}${paramList(c.params)}${c.summary ? ` — ${c.summary}` : ""}${c.risk ? ` [risk:${c.risk}]` : ""}`);
      break;
    case "ANSWER":
      out.push(lean(r.data));
      break;
    case "PROPOSALS":
      out.push(...proposalsLines(r.proposals));
      break;
    case "CLARIFY":
      out.push(`? ${r.question}`, ...r.options.map((o, i) => `  ${i + 1}. ${o.label}`));
      break;
    case "RECEIPT": {
      const rc = r.receipt;
      const tag = `(receipt ${rc.id})${r.replay ? " (replay)" : ""}`;
      if (rc.undoes) out.push(`↶ undid ${rc.undoes}: ${rc.summary} ${tag}`);
      else out.push(`✓ ${rc.summary} ${tag} · ${rc.undo ? `undo until ${fmtTime(rc.undo.until)}` : "irreversible"}`);
      // The model already saw the effects in the proposal, unless the service auto-committed.
      if (r.auto) out.push(...rc.effects.map((e) => "  " + effectLine(e)));
      if (rc.result !== undefined) out.push(...entry("result", rc.result, 1));
      break;
    }
    case "ERROR":
      out.push(`✗ ${r.code}: ${r.message}`);
      for (const f of r.fix ?? []) out.push(`  fix: ${f.say}${f.params ? ` → params ${JSON.stringify(f.params)}` : ""}`);
      if (r.need?.length) out.push(`  need: ${JSON.stringify(r.need)}`);
      if (r.consent) out.push(`  consent: principal must approve ${r.consent.hash} (${r.consent.summary})`);
      if (typeof r.retry === "number") out.push(`  retry in: ${fmtDuration(r.retry)}`);
      break;
    case "EVENT":
      out.push(`… ${r.message}${typeof r.progress === "number" ? ` (${Math.round(r.progress * 100)}%)` : ""}`);
      break;
  }
  if ("more" in r) out.push(...moreLines(r.more));
  return out.join("\n");
}

/** Shared token estimate (SPEC §8): ceil(utf8 bytes / 4). */
export const est = (text: string) => Math.ceil(new TextEncoder().encode(text).length / 4);
