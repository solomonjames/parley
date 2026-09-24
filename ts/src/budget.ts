/**
 * Token budgets (SPEC §8). Replies are fitted to the agent's budget by eliding the
 * largest arrays/strings; elided parts are parked behind EXPAND handles.
 */
import { randomId } from "./crypto.js";
import { est, lean, lens } from "./lens.js";
import type { More, Reply } from "./types.js";

/** `owner`: the holder key allowed to EXPAND it (null for anonymous replies). */
export type Parked = ({ kind: "array"; items: unknown[] } | { kind: "text"; text: string }) & { owner?: string | null };

export interface HandleStore {
  put(handle: string, value: Parked): void;
  get(handle: string): Parked | undefined;
}

export class MemoryHandleStore implements HandleStore {
  private m = new Map<string, { v: Parked; exp: number }>();
  constructor(private ttlMs = 30 * 60_000) {}
  put(h: string, v: Parked) {
    this.m.set(h, { v, exp: Date.now() + this.ttlMs });
    if (this.m.size > 10_000) for (const [k, e] of this.m) if (e.exp < Date.now()) this.m.delete(k);
  }
  get(h: string) {
    const e = this.m.get(h);
    return e && e.exp > Date.now() ? e.v : undefined;
  }
}

type Path = (string | number)[];
const MIN_STRING = 200;

function getAt(root: any, path: Path): any {
  return path.reduce((v, k) => (v == null ? undefined : v[k]), root);
}
function setAt(root: any, path: Path, value: unknown) {
  const parent = getAt(root, path.slice(0, -1));
  parent[path[path.length - 1]] = value;
}

function collect(v: unknown, path: Path, out: { path: Path; size: number }[]) {
  if (typeof v === "string") {
    if (v.length > MIN_STRING) out.push({ path, size: v.length });
  } else if (Array.isArray(v)) {
    if (v.length > 0) out.push({ path, size: JSON.stringify(v).length });
    v.forEach((x, i) => collect(x, [...path, i], out));
  } else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) collect(x, [...path, k], out);
  }
}

/**
 * Where elision is allowed per reply kind. `deep` roots may be elided anywhere inside;
 * `list` roots only by dropping whole trailing items, so effects, summaries and hashes of
 * what remains are never altered. Deep roots are elided before lists.
 */
function roots(r: Reply): { deep: Path[]; list: Path[] } {
  switch (r.kind) {
    case "ANSWER": return { deep: [["data"]], list: [] };
    case "BRIEF": return { deep: [], list: [["capabilities"]] };
    case "PROPOSALS": return { deep: r.proposals.map((_, i) => ["proposals", i, "data"]), list: [["proposals"]] };
    case "RECEIPT": return { deep: [["receipt", "result"]], list: [] };
    default: return { deep: [], list: [] };
  }
}

/** Fit `reply` within `budget` estimated tokens of Lens. Returns a new reply (input untouched). */
export function fit<R extends Reply>(reply: R, budget: number, store: HandleStore, owner: string | null = null): R {
  const original = structuredClone(reply) as any;
  const r = structuredClone(reply) as any;
  const cut = new Map<string, { path: Path; kept: number; handle: string }>();

  const moreFor = (handles: boolean): More[] => {
    const out: More[] = [];
    for (const { path, kept, handle } of cut.values()) {
      const full = getAt(original, path);
      if (getAt(r, path) === undefined) continue; // an ancestor was elided; its remainder carries this
      const rest = typeof full === "string" ? full.slice(kept) : full.slice(kept);
      if (handles) store.put(handle, typeof rest === "string" ? { kind: "text", text: rest, owner } : { kind: "array", items: rest, owner });
      out.push({ handle, path: path.join("."), remaining: rest.length, est: typeof rest === "string" ? est(rest) : est(lean(rest)) });
    }
    return out;
  };

  const baseMore: More[] = r.more ?? [];
  for (let guard = 0; guard < 200; guard++) {
    const more = [...baseMore, ...moreFor(false)];
    const text = lens({ ...r, more: more.length ? more : undefined });
    if (est(text) <= budget) break;
    const { deep, list } = roots(r);
    let cands: { path: Path; size: number }[] = [];
    for (const root of deep) {
      const v = getAt(r, root);
      if (v !== undefined) collect(v, root, cands);
    }
    if (!cands.length)
      for (const root of list) {
        const v = getAt(r, root);
        if (Array.isArray(v) && v.length) cands.push({ path: root, size: JSON.stringify(v).length });
      }
    if (!cands.length) break;
    const pick = cands.reduce((a, b) => (b.size > a.size ? b : a));
    const cur = getAt(r, pick.path);
    const key = pick.path.join(".");
    const prevKept = cut.get(key)?.kept ?? 0;
    if (typeof cur === "string") {
      const alreadyCut = cut.has(key);
      const body = alreadyCut ? cur.slice(0, -1) : cur; // strip our "…"
      const kept = Math.max(MIN_STRING, Math.floor(body.length / 2));
      if (kept >= body.length) break;
      cut.set(key, { path: pick.path, kept: alreadyCut ? Math.min(prevKept, kept) : kept, handle: cut.get(key)?.handle ?? randomId("h") });
      setAt(r, pick.path, body.slice(0, kept) + "…");
    } else {
      const kept = Math.floor(cur.length / 2);
      cut.set(key, { path: pick.path, kept, handle: cut.get(key)?.handle ?? randomId("h") });
      setAt(r, pick.path, cur.slice(0, kept));
    }
  }
  const more = [...baseMore, ...moreFor(true)];
  if (more.length) r.more = more;
  return r as R;
}
