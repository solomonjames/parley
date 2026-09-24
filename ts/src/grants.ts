/**
 * Grants (SPEC §6): signed, attenuable delegation chains.
 * A principal signs a root block granting a holder key some authority; any holder may
 * append a block delegating a narrower grant to another key.
 */
import { b64u, fromUtf8, unb64u, utf8 } from "./b64.js";
import { canonical } from "./canonical.js";
import { keyPair, sha256, sign, verify, type KeyPair } from "./crypto.js";
import type { Money, Proof, Risk, Verb } from "./types.js";

export type Limit = { max: number; currency: string };
export type Caveat =
  | { svc: string[] }
  | { verbs: Verb[] }
  | { can: string[] }
  | { exp: number }
  | { nbf: number }
  | { per: Limit }
  | { spend: Limit }
  | { risk: Risk }
  | { only: string };

export interface Block { p: Record<string, unknown> & { sub: string; caveats: Caveat[]; iat: number }; s: string }

const PREFIX = "pg1.";
const RISK_ORDER: Record<Risk, number> = { low: 0, medium: 1, high: 2 };
const now = () => Math.floor(Date.now() / 1000);

export function encodeGrant(blocks: Block[]): string {
  return PREFIX + b64u(utf8(canonical(blocks)));
}

export function decodeGrant(token: string): Block[] {
  if (!token.startsWith(PREFIX)) throw new Error("not a pg1 grant");
  const blocks = JSON.parse(fromUtf8(unb64u(token.slice(PREFIX.length))));
  if (!Array.isArray(blocks) || blocks.length === 0) throw new Error("grant has no blocks");
  for (const b of blocks) {
    if (typeof b?.s !== "string" || typeof b?.p?.sub !== "string" || !Array.isArray(b?.p?.caveats)) throw new Error("malformed block");
  }
  return blocks;
}

export const blockId = (b: Block) => sha256(b.s);

/** Issue a root grant from `principal` to the key `to`. */
export async function issueGrant(opts: { principal: KeyPair | string; to: string; caveats?: Caveat[]; iat?: number; nonce?: string }): Promise<string> {
  const principal = typeof opts.principal === "string" ? await keyPair(opts.principal) : opts.principal;
  const p = {
    iss: principal.public,
    sub: opts.to,
    caveats: opts.caveats ?? [],
    iat: opts.iat ?? now(),
    nonce: opts.nonce ?? b64u(globalThis.crypto.getRandomValues(new Uint8Array(12))),
  };
  return encodeGrant([{ p, s: await sign(principal.seed, canonical(p)) }]);
}

/** Attenuate: the current holder (by seed) delegates a narrower grant to `to`. */
export async function delegateGrant(token: string, opts: { holder: KeyPair | string; to: string; caveats?: Caveat[]; iat?: number }): Promise<string> {
  const blocks = decodeGrant(token);
  const holder = typeof opts.holder === "string" ? await keyPair(opts.holder) : opts.holder;
  const last = blocks[blocks.length - 1];
  if (last.p.sub !== holder.public) throw new Error("only the current holder can delegate this grant");
  const p = { prev: await sha256(last.s), sub: opts.to, caveats: opts.caveats ?? [], iat: opts.iat ?? now() };
  return encodeGrant([...blocks, { p, s: await sign(holder.seed, canonical(p)) }]);
}

/** Consent grant (SPEC §6.6): one-shot approval of an exact proposal hash. */
export function consentGrant(opts: { principal: KeyPair | string; agent: string; hash: string; expires: number }): Promise<string> {
  return issueGrant({ principal: opts.principal, to: opts.agent, caveats: [{ only: opts.hash }, { exp: opts.expires }] });
}

export interface GrantInfo { id: string; iss: string; holder: string; blocks: { id: string; sub: string; caveats: Caveat[]; iat: number }[] }

export async function inspectGrant(token: string): Promise<GrantInfo> {
  const blocks = decodeGrant(token);
  const ids = await Promise.all(blocks.map(blockId));
  return {
    id: ids[0],
    iss: blocks[0].p.iss as string,
    holder: blocks[blocks.length - 1].p.sub,
    blocks: blocks.map((b, i) => ({ id: ids[i], sub: b.p.sub, caveats: b.p.caveats, iat: b.p.iat })),
  };
}

export interface CheckContext {
  service: string;
  verb: Verb;
  capability: string;
  now?: number;
  /** For COMMIT: the proposal being committed. */
  proposal?: { hash: string; cost: Money | null; risk: Risk };
  /** Principals the service trusts. */
  trusted: string[] | ((iss: string) => boolean);
  /** The key that signed the request proof; must equal the grant holder. */
  proofKey: string;
  /** Spend already attributed to a block id (for `spend` caveats). */
  spent?: (blockId: string) => number;
}

export type GrantCheck =
  | { ok: true; id: string; iss: string; holder: string; spendBlocks: string[] }
  | { ok: false; code: "unauthorized" | "forbidden" | "consent_required"; reason: string; iss?: string; need?: Caveat[] };

const CONSENTABLE = new Set(["per", "spend", "risk"]);

export function matchCapability(pattern: string, cap: string): boolean {
  return pattern === "*" || pattern === cap || (pattern.endsWith("*") && cap.startsWith(pattern.slice(0, -1)));
}

/** Verify a grant token against a request (SPEC §6.4). Never throws. */
export async function checkGrant(token: string, ctx: CheckContext): Promise<GrantCheck> {
  let blocks: Block[];
  try {
    blocks = decodeGrant(token);
  } catch (e) {
    return { ok: false, code: "unauthorized", reason: `malformed grant: ${(e as Error).message}` };
  }
  const iss = blocks[0].p.iss;
  if (typeof iss !== "string") return { ok: false, code: "unauthorized", reason: "root block has no iss" };

  let signer = iss;
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (i > 0 && b.p.prev !== (await sha256(blocks[i - 1].s))) return { ok: false, code: "unauthorized", reason: `block ${i} is not chained to block ${i - 1}` };
    if (!(await verify(signer, canonical(b.p), b.s))) return { ok: false, code: "unauthorized", reason: `bad signature on block ${i}` };
    signer = b.p.sub;
  }
  const trusted = typeof ctx.trusted === "function" ? ctx.trusted(iss) : ctx.trusted.includes(iss);
  if (!trusted) return { ok: false, code: "unauthorized", reason: "grant is issued by a principal this service does not trust", iss };
  const holder = signer;
  if (holder !== ctx.proofKey) return { ok: false, code: "unauthorized", reason: "proof key is not the grant holder", iss };

  const t = ctx.now ?? now();
  const p = ctx.verb === "COMMIT" ? ctx.proposal : undefined;
  const hard: { c: Caveat; why: string }[] = [];
  const soft: { c: Caveat; why: string }[] = [];
  const spendBlocks: string[] = [];

  for (const b of blocks) {
    const id = await sha256(b.s);
    for (const c of b.p.caveats as Record<string, any>[]) {
      const keys = Object.keys(c);
      const k = keys.length === 1 ? keys[0] : "";
      const v = c[k];
      let why: string | null = null;
      switch (k) {
        case "svc": if (!v.includes(ctx.service)) why = `not valid for service ${ctx.service}`; break;
        case "verbs": if (!v.includes(ctx.verb)) why = `does not allow ${ctx.verb}`; break;
        case "can": if (!v.some((pat: string) => matchCapability(pat, ctx.capability))) why = `does not cover ${ctx.capability}`; break;
        case "exp": if (!(t < v)) why = "grant has expired"; break;
        case "nbf": if (!(t >= v)) why = "grant is not valid yet"; break;
        case "per":
          if (p?.cost && (p.cost.currency !== v.currency || p.cost.amount > v.max)) why = `cost exceeds per-commit limit of ${v.max} ${v.currency}`;
          break;
        case "spend":
          if (p?.cost) {
            const total = (ctx.spent?.(id) ?? 0) + p.cost.amount;
            if (p.cost.currency !== v.currency || total > v.max) why = `would exceed spend limit of ${v.max} ${v.currency}`;
          }
          if (ctx.verb === "COMMIT") spendBlocks.push(id);
          break;
        case "risk": if (p && RISK_ORDER[p.risk] > RISK_ORDER[v as Risk]) why = `risk ${p.risk} exceeds ceiling ${v}`; break;
        case "only": if (ctx.verb === "COMMIT" && p?.hash !== v) why = "grant is bound to a different proposal"; break;
        default: why = `unknown caveat ${JSON.stringify(c)}`;
      }
      if (why) (CONSENTABLE.has(k) ? soft : hard).push({ c: c as Caveat, why });
    }
  }
  if (hard.length) return { ok: false, code: "forbidden", reason: hard.map((h) => h.why).join("; "), iss, need: hard.map((h) => h.c) };
  if (soft.length) return { ok: false, code: "consent_required", reason: soft.map((h) => h.why).join("; "), iss };
  return { ok: true, id: await sha256(blocks[0].s), iss, holder, spendBlocks };
}

export interface ProofTarget { aud: string; verb: Verb; target: string }

export async function makeProof(seed: string, t: ProofTarget, ts = now()): Promise<Proof> {
  const kp = await keyPair(seed);
  return { key: kp.public, ts, sig: await sign(seed, canonical({ aud: t.aud, verb: t.verb, target: t.target, ts })) };
}

export async function checkProof(proof: Proof | undefined, t: ProofTarget, at = now()): Promise<string | null> {
  if (!proof || typeof proof.key !== "string" || typeof proof.sig !== "string" || !Number.isSafeInteger(proof.ts)) return "missing or malformed proof";
  if (Math.abs(at - proof.ts) > 300) return "proof timestamp is outside the 300s window";
  const ok = await verify(proof.key, canonical({ aud: t.aud, verb: t.verb, target: t.target, ts: proof.ts }), proof.sig);
  return ok ? null : "proof signature is invalid";
}
