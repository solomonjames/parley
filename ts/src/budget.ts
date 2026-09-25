/**
 * Token budgets (SPEC §8). Replies are fitted to the agent's budget by eliding the
 * largest arrays/strings; elided parts are parked behind EXPAND handles.
 */
import { randomId } from './crypto.js';
import { est, lean, lens } from './lens.js';
import type { More, Reply } from './types.js';

/** `owner`: the holder key allowed to EXPAND it (null for anonymous replies). */
export type Parked = (
  | { kind: 'array'; items: unknown[] }
  | { kind: 'text'; text: string }
) & { owner?: string | null };

export interface HandleStore {
  put(handle: string, value: Parked): void;
  get(handle: string): Parked | undefined;
}

export class MemoryHandleStore implements HandleStore {
  private m = new Map<string, { v: Parked; exp: number }>();
  constructor(private ttlMs = 30 * 60_000) {}
  put(h: string, v: Parked) {
    this.m.set(h, { v, exp: Date.now() + this.ttlMs });

    if (this.m.size > 10_000) {
      for (const [k, e] of this.m) {
        if (e.exp < Date.now()) {
          this.m.delete(k);
        }
      }
    }
  }

  get(h: string) {
    const e = this.m.get(h);

    return e && e.exp > Date.now() ? e.v : undefined;
  }
}

type Path = (string | number)[];
type Container = Record<string | number, unknown>;

const MIN_STRING = 200;

function getAt(root: unknown, path: Path): unknown {
  return path.reduce<unknown>(
    (v, k) => (v == null ? undefined : (v as Container)[k]),
    root,
  );
}

function setAt(root: unknown, path: Path, value: unknown) {
  const parent = getAt(root, path.slice(0, -1)) as Container;

  parent[path[path.length - 1]] = value;
}

interface Candidate {
  path: Path;
  size: number;
}

function collect(v: unknown, path: Path, out: Candidate[]) {
  if (typeof v === 'string') {
    if (v.length > MIN_STRING) {
      out.push({ path, size: v.length });
    }
  } else if (Array.isArray(v)) {
    if (v.length > 0) {
      out.push({ path, size: JSON.stringify(v).length });
    }

    for (const [i, x] of v.entries()) {
      collect(x, [...path, i], out);
    }
  } else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      collect(x, [...path, k], out);
    }
  }
}

/**
 * Where elision is allowed per reply kind. `deep` roots may be elided anywhere inside;
 * `list` roots only by dropping whole trailing items, so effects, summaries and hashes of
 * what remains are never altered. Deep roots are elided before lists.
 */
function roots(r: Reply): { deep: Path[]; list: Path[] } {
  switch (r.kind) {
    case 'ANSWER':
      return { deep: [['data']], list: [] };
    case 'BRIEF':
      return { deep: [], list: [['capabilities']] };
    case 'PROPOSALS':
      return {
        deep: r.proposals.map((_, i) => ['proposals', i, 'data']),
        list: [['proposals']],
      };
    case 'RECEIPT':
      return { deep: [['receipt', 'result']], list: [] };
    default:
      return { deep: [], list: [] };
  }
}

/** Elidable strings/arrays in `r`: deep roots first; whole list roots only once none remain. */
function candidates(r: Reply): Candidate[] {
  const { deep, list } = roots(r);
  const cands: Candidate[] = [];

  for (const root of deep) {
    const v = getAt(r, root);

    if (v !== undefined) {
      collect(v, root, cands);
    }
  }

  if (cands.length) {
    return cands;
  }

  for (const root of list) {
    const v = getAt(r, root);

    if (Array.isArray(v) && v.length) {
      cands.push({ path: root, size: JSON.stringify(v).length });
    }
  }

  return cands;
}

/** A value shortened to its first `kept` chars/items, parked behind `handle`. */
interface Cut {
  path: Path;
  kept: number;
  handle: string;
}

interface FitState {
  /** The reply as given, holding the full values that cuts elide. */
  original: Reply;
  /** The reply being shrunk. */
  r: Reply;
  /** Cuts by dotted path. */
  cuts: Map<string, Cut>;
}

/**
 * Halve the string or array at `path`, recording the cut (repeat cuts keep their handle).
 * Returns false when it cannot shrink further.
 */
function halve(s: FitState, path: Path): boolean {
  const cur = getAt(s.r, path);
  const key = path.join('.');
  const prev = s.cuts.get(key);

  if (typeof cur === 'string') {
    const body = prev ? cur.slice(0, -1) : cur; // strip our "…"
    const kept = Math.max(MIN_STRING, Math.floor(body.length / 2));

    if (kept >= body.length) {
      return false;
    }

    s.cuts.set(key, {
      path,
      kept: prev ? Math.min(prev.kept, kept) : kept,
      handle: prev?.handle ?? randomId('h'),
    });
    setAt(s.r, path, `${body.slice(0, kept)}…`);

    return true;
  }

  if (!Array.isArray(cur)) {
    return false;
  }

  const kept = Math.floor(cur.length / 2);

  s.cuts.set(key, { path, kept, handle: prev?.handle ?? randomId('h') });
  setAt(s.r, path, cur.slice(0, kept));

  return true;
}

/** What a cut elided: the rest of the original string or array after `kept`. */
function remainder(full: unknown, kept: number): Parked {
  if (typeof full === 'string') {
    return { kind: 'text', text: full.slice(kept) };
  }

  if (Array.isArray(full)) {
    return { kind: 'array', items: full.slice(kept) };
  }

  throw new TypeError('only strings and arrays are cut');
}

/** One `More` entry per cut still visible in `s.r`; `park` receives each elided remainder. */
function moreEntries(
  s: FitState,
  park?: (handle: string, rest: Parked) => void,
): More[] {
  const out: More[] = [];

  for (const { path, kept, handle } of s.cuts.values()) {
    if (getAt(s.r, path) === undefined) {
      continue; // an ancestor was elided; its remainder carries this
    }

    const rest = remainder(getAt(s.original, path), kept);

    park?.(handle, rest);
    out.push({
      handle,
      path: path.join('.'),
      remaining: rest.kind === 'text' ? rest.text.length : rest.items.length,
      est: rest.kind === 'text' ? est(rest.text) : est(lean(rest.items)),
    });
  }

  return out;
}

const moreOf = (r: Reply): More[] => ('more' in r ? r.more : undefined) ?? [];

/** Fit `reply` within `budget` estimated tokens of Lens. Returns a new reply (input untouched). */
export function fit<R extends Reply>(
  reply: R,
  budget: number,
  store: HandleStore,
  owner: string | null = null,
): R {
  const r = structuredClone(reply);
  const s: FitState = { original: structuredClone(reply), r, cuts: new Map() };
  const baseMore = moreOf(r);

  for (let guard = 0; guard < 200; guard++) {
    const more = [...baseMore, ...moreEntries(s)];
    const text = lens(
      Object.assign({}, r, { more: more.length ? more : undefined }),
    );

    if (est(text) <= budget) {
      break;
    }

    const cands = candidates(r);

    if (!cands.length) {
      break;
    }

    const pick = cands.reduce((a, b) => (b.size > a.size ? b : a));

    if (!halve(s, pick.path)) {
      break;
    }
  }

  const more = [
    ...baseMore,
    ...moreEntries(s, (handle, rest) => store.put(handle, { ...rest, owner })),
  ];

  if (more.length) {
    Object.assign(r, { more });
  }

  return r;
}
