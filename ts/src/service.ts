/**
 * Build a Parley service. Transport-independent: `handle(frame)` turns a request frame
 * into its final reply (emitting EVENTs along the way). Transports live in node.ts / http.ts.
 */
import { MemoryHandleStore, fit, type HandleStore } from './budget.js';
import { proposalHash, randomId } from './crypto.js';
import { ParleyError, fix } from './errors.js';
import { checkGrant, checkProof, type GrantCheck } from './grants.js';
import type {
  Brief,
  CapabilityInfo,
  Effect,
  ErrorReply,
  Event,
  FinalReply,
  Money,
  ParamSchema,
  Proposal,
  Receipt,
  ReceiptReply,
  Request,
  Risk,
  Verb,
} from './types.js';
import { closest, validateParams } from './validate.js';

export interface ServiceOptions {
  id: string;
  name: string;
  summary: string;
  /** Principal public keys allowed to authorize actions, or a predicate. */
  trust?: string[] | ((principal: string) => boolean);
  /** Require grants for ASK/INTENT too (they are always required for COMMIT/UNDO). */
  requireGrants?: boolean;
  defaultBudget?: number;
  /** Default seconds a proposal stays committable. */
  proposalTtl?: number;
  handles?: HandleStore;
  now?: () => number;
  /** Called for unexpected handler exceptions. */
  onError?: (err: unknown) => void;
}

export interface Ctx {
  params: Record<string, any>;
  goal?: string;
  /** The principal (public key) on whose behalf the agent acts, if it presented a valid grant. */
  principal: string | null;
  agent?: { name?: string; key?: string };
}

export interface CommitCtx {
  principal: string;
  /** Stream progress to the agent as EVENT frames. */
  progress(message: string, progress?: number, data?: unknown): void;
}

/** What an intent handler returns for each way it could satisfy the intent. */
export interface Plan<R = unknown> {
  summary: string;
  effects: Effect[];
  cost?: Money | null;
  risk?: Risk;
  /** Seconds this proposal can be committed for (default: service proposalTtl). */
  expiresIn?: number;
  data?: unknown;
  /** Perform the effects. Only ever called on COMMIT, at most once. */
  apply(ctx: CommitCtx): R | Promise<R>;
  /** Reverse the effects. If present, the proposal is undoable for `undoWindow` seconds. */
  revert?(ctx: CommitCtx & { result: R }): unknown;
  undoWindow?: number;
}

export interface Clarification {
  clarify: {
    question: string;
    options: { label: string; params: Record<string, unknown> }[];
  };
}

export const clarify = (
  question: string,
  options: { label: string; params: Record<string, unknown> }[],
): Clarification => ({ clarify: { question, options } });

interface AskDef {
  summary: string;
  params?: ParamSchema;
  run(ctx: Ctx): unknown;
}
interface IntentDef {
  summary: string;
  params?: ParamSchema;
  risk?: Risk;
  plan(
    ctx: Ctx,
  ): Plan | Plan[] | Clarification | Promise<Plan | Plan[] | Clarification>;
}

/** `requester`: the holder key whose verified proof asked for this proposal; only it may commit it. */
interface StoredProposal {
  proposal: Proposal;
  plan: Plan;
  principal: string | null;
  requester: string | null;
  created: number;
}
interface StoredReceipt {
  receipt: Receipt;
  plan: Plan;
  result: unknown;
  principal: string;
  undone?: Promise<ReceiptReply | ErrorReply>;
}

const DAY = 86400;

export class Service {
  readonly id: string;
  private asks = new Map<string, AskDef>();
  private intents = new Map<string, IntentDef>();
  private proposals = new Map<string, StoredProposal>();
  private commits = new Map<string, Promise<ReceiptReply | ErrorReply>>();
  private receipts = new Map<string, StoredReceipt>();
  private spent = new Map<string, number>();
  private autoSeen = new Map<
    string,
    { reply: Promise<FinalReply>; exp: number }
  >();

  private handles: HandleStore;
  private now: () => number;

  constructor(private opts: ServiceOptions) {
    this.id = opts.id;
    this.handles = opts.handles ?? new MemoryHandleStore();
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Register a read-only capability. */
  ask(name: string, def: AskDef): this {
    this.asks.set(name, def);

    return this;
  }

  /** Register a capability that answers with proposals. */
  intent(name: string, def: IntentDef): this {
    this.intents.set(name, def);

    return this;
  }

  get capabilities(): CapabilityInfo[] {
    const out: CapabilityInfo[] = [];

    for (const [name, d] of this.asks)
      out.push({
        name,
        kind: 'ask',
        summary: d.summary,
        ...(d.params ? { params: d.params } : {}),
      });

    for (const [name, d] of this.intents)
      out.push({
        name,
        kind: 'intent',
        summary: d.summary,
        ...(d.params ? { params: d.params } : {}),
        ...(d.risk ? { risk: d.risk } : {}),
      });

    return out;
  }

  brief(budget = this.opts.defaultBudget ?? 2000, re = 'discover'): Brief {
    const r: Brief = {
      parley: 1,
      id: randomId('s', 6),
      re,
      kind: 'BRIEF',
      service: {
        id: this.opts.id,
        name: this.opts.name,
        summary: this.opts.summary,
      },
      capabilities: this.capabilities,
    };

    return fit(r, budget, this.handles);
  }

  /** Handle one request frame. EVENTs go to `emit`; the final reply is returned. */
  async handle(
    frame: unknown,
    emit: (e: Event) => void = () => {},
  ): Promise<FinalReply> {
    const req = frame as Request;
    const re = typeof (req as any)?.id === 'string' ? req.id : '?';

    try {
      if (
        !req ||
        typeof req !== 'object' ||
        (req as any).parley !== 1 ||
        typeof req.id !== 'string'
      ) {
        throw new ParleyError(
          'bad_frame',
          'frames need "parley": 1 and a string "id"',
        );
      }

      const budget =
        Number.isInteger(req.budget) && req.budget! > 0
          ? req.budget!
          : (this.opts.defaultBudget ?? 2000);

      switch (req.verb) {
        case 'HELLO':
          return this.brief(budget, re);
        case 'ASK':
          return await this.onAsk(req, budget);
        case 'INTENT':
          return await this.onIntent(req, budget, emit);
        case 'COMMIT':
          return await this.onCommit(req, budget, emit);
        case 'UNDO':
          return await this.onUndo(req, budget, emit);
        case 'EXPAND':
          return await this.onExpand(req, budget);
        default:
          throw new ParleyError(
            'bad_frame',
            `unknown verb ${JSON.stringify((req as any).verb)}`,
            {
              fix: [fix('use one of HELLO, ASK, INTENT, COMMIT, UNDO, EXPAND')],
            },
          );
      }
    } catch (e) {
      return this.errorReply(re, e);
    }
  }

  private errorReply(re: string, e: unknown): ErrorReply {
    if (e instanceof ParleyError)
      return {
        parley: 1,
        id: randomId('s', 6),
        re,
        kind: 'ERROR',
        code: e.code,
        message: e.message,
        ...e.extra,
      };

    this.opts.onError?.(e);

    return {
      parley: 1,
      id: randomId('s', 6),
      re,
      kind: 'ERROR',
      code: 'internal',
      message: 'the service failed unexpectedly',
      retry: 5,
    };
  }

  private unknownCapability(name: unknown, kind: 'ask' | 'intent'): never {
    const all = [...this.asks.keys(), ...this.intents.keys()];
    const other =
      kind === 'ask'
        ? this.intents.has(String(name))
        : this.asks.has(String(name));

    if (other) {
      const verb = kind === 'ask' ? 'INTENT' : 'ASK';

      throw new ParleyError(
        'unknown_capability',
        `${name} is ${kind === 'ask' ? 'an intent' : 'an ask'} capability`,
        { fix: [fix(`send it with ${verb}`)] },
      );
    }

    const near = closest(String(name), all);

    throw new ParleyError(
      'unknown_capability',
      `no capability named ${JSON.stringify(name)}`,
      {
        fix: near
          ? [fix(`did you mean ${near}?`)]
          : [fix(`send HELLO to list capabilities (${all.length} available)`)],
      },
    );
  }

  /** Verify grants on a request; returns the authorizing check, or throws the right error. */
  private async authorize(
    req: Request,
    verb: Verb,
    capability: string,
    target: string,
    proposal?: Proposal,
    o: { principal?: string | null; replay?: boolean } = {},
  ): Promise<(GrantCheck & { ok: true }) | null> {
    const grants = req.grants ?? [];
    const required =
      verb === 'COMMIT' || verb === 'UNDO' || this.opts.requireGrants;

    if (!grants.length) {
      if (required)
        throw new ParleyError(
          'unauthorized',
          `${verb} needs a grant from your principal`,
          {
            fix: [
              fix(
                'ask your principal to issue a grant (parley grant) and send it in `grants` with a `proof`',
              ),
            ],
          },
        );

      return null;
    }

    const proofErr = await checkProof(
      req.proof,
      { aud: this.id, verb, target },
      this.now(),
    );

    if (proofErr)
      throw new ParleyError('unauthorized', proofErr, {
        fix: [
          fix(
            `sign {aud:"${this.id}",verb:"${verb}",target,ts} with the grant holder key`,
          ),
        ],
      });

    const checks: GrantCheck[] = [];

    for (const g of grants) {
      const c = await checkGrant(g, {
        service: this.id,
        verb,
        capability,
        now: this.now(),
        trusted: this.opts.trust ?? [],
        proofKey: req.proof!.key,
        proposal: proposal && {
          hash: proposal.hash,
          cost: proposal.cost,
          risk: proposal.risk,
        },
        spent: (id) => this.spent.get(id) ?? 0,
      });

      // Only grants from the principal the proposal was made for can act on it.
      if (o.principal && c.iss && c.iss !== o.principal) {
        checks.push({
          ok: false,
          code: 'forbidden',
          reason: "grant is from a different principal than this proposal's",
          iss: c.iss,
        });

        continue;
      }

      if (c.ok) return c;

      // Replaying an already-executed commit must not be blocked by money/risk limits it already used up.
      if (o.replay && c.code === 'consent_required')
        return {
          ok: true,
          id: '',
          iss: c.iss!,
          holder: req.proof!.key,
          spendBlocks: [],
        };

      checks.push(c);
    }

    // ASK/INTENT don't need a grant here, so a grant that doesn't apply just means "anonymous".
    if (!required) return null;

    const consent = checks.find((c) => !c.ok && c.code === 'consent_required');

    if (consent && !consent.ok && proposal) {
      throw new ParleyError(
        'consent_required',
        `${consent.reason}; your principal must approve this exact proposal`,
        {
          consent: {
            proposal: proposal.id,
            hash: proposal.hash,
            service: this.id,
            capability: proposal.capability,
            principal: consent.iss!,
            summary: proposal.summary,
            expires: proposal.expires,
          },
        },
      );
    }

    const forbidden = checks.find((c) => !c.ok && c.code === 'forbidden');

    if (forbidden && !forbidden.ok)
      throw new ParleyError('forbidden', forbidden.reason, {
        need: forbidden.need,
      });

    const first = checks[0] as GrantCheck & { ok: false };

    throw new ParleyError('unauthorized', first.reason);
  }

  private async onAsk(
    req: Request & { verb: 'ASK' },
    budget: number,
  ): Promise<FinalReply> {
    const def =
      this.asks.get(req.capability) ??
      this.unknownCapability(req.capability, 'ask');
    const params = req.params ?? {};

    validateParams(def.params, params);

    const auth = await this.authorize(
      req,
      'ASK',
      req.capability,
      req.capability,
    );
    const data = await def.run({ params, principal: auth?.iss ?? null });

    return fit(
      {
        parley: 1,
        id: randomId('s', 6),
        re: req.id,
        kind: 'ANSWER',
        data: data ?? null,
      },
      budget,
      this.handles,
      verifiedKey(req),
    );
  }

  /** Policy-gated auto-commit (SPEC §4.3.1): only if a grant authorizes it outright and it is undoable. */
  private async autoAuth(
    req: Request & { verb: 'INTENT' },
    proposal: Proposal,
  ): Promise<(GrantCheck & { ok: true }) | null> {
    if (!proposal.undo || !req.grants?.length) return null;

    if (
      await checkProof(
        req.proof,
        {
          aud: this.id,
          verb: 'INTENT',
          target: `auto:${req.capability}:${req.id}`,
        },
        this.now(),
      )
    )
      return null;

    for (const g of req.grants) {
      const c = await checkGrant(g, {
        service: this.id,
        verb: 'COMMIT',
        capability: proposal.capability,
        now: this.now(),
        trusted: this.opts.trust ?? [],
        proofKey: req.proof!.key,
        proposal: {
          hash: proposal.hash,
          cost: proposal.cost,
          risk: proposal.risk,
        },
        spent: (id) => this.spent.get(id) ?? 0,
      });

      if (c.ok) return c;
    }

    return null;
  }

  private async onIntent(
    req: Request & { verb: 'INTENT' },
    budget: number,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const def =
      this.intents.get(req.capability) ??
      this.unknownCapability(req.capability, 'intent');
    const params = req.params ?? {};

    validateParams(def.params, params);

    const autoTarget = `auto:${req.capability}:${req.id}`;
    const auth = await this.authorize(
      req,
      'INTENT',
      req.capability,
      req.auto ? autoTarget : req.capability,
    );
    const principal = auth?.iss ?? null;
    // A replayed auto INTENT (same holder key + request id) gets the original reply, never a second commit.
    const autoKey =
      req.auto && req.grants?.length && req.proof
        ? `${req.proof.key}:${req.id}`
        : null; // proof verified by authorize()

    if (autoKey) {
      const prior = this.autoSeen.get(autoKey);

      if (prior && prior.exp > this.now()) {
        const r = await prior.reply;

        return r.kind === 'RECEIPT'
          ? { ...r, id: randomId('s', 6), re: req.id, replay: true }
          : r;
      }
    }

    const reply = this.planIntent(def, req, budget, emit, principal);

    if (autoKey) {
      // outlive every proof that could carry this frame id: proofs are valid for ±300s around ts
      this.autoSeen.set(autoKey, {
        reply,
        exp: Math.max(this.now(), req.proof!.ts) + 900,
      });

      if (this.autoSeen.size > 10_000)
        for (const [k, v] of this.autoSeen)
          if (v.exp <= this.now()) this.autoSeen.delete(k);
    }

    return reply;
  }

  private async planIntent(
    def: IntentDef,
    req: Request & { verb: 'INTENT' },
    budget: number,
    emit: (e: Event) => void,
    principal: string | null,
  ): Promise<FinalReply> {
    const params = req.params ?? {};
    const out = await def.plan({ params, goal: req.goal, principal });

    if (out && 'clarify' in out)
      return {
        parley: 1,
        id: randomId('s', 6),
        re: req.id,
        kind: 'CLARIFY',
        ...out.clarify,
      };

    const plans = Array.isArray(out) ? out : [out];

    if (!plans.length)
      throw new ParleyError('not_found', 'no way to satisfy this intent', {
        fix: [fix('relax the constraints and try again')],
      });

    const now = this.now();
    const proposals: Proposal[] = [];

    for (const plan of plans) {
      const window = plan.revert ? (plan.undoWindow ?? DAY) : null;
      const p: Omit<Proposal, 'hash'> = {
        id: randomId('p', 6),
        capability: req.capability,
        summary: plan.summary,
        effects: plan.effects,
        cost: plan.cost ?? null,
        risk: plan.risk ?? def.risk ?? 'low',
        undo: window === null ? null : { window },
        expires:
          Math.ceil(
            (now + (plan.expiresIn ?? this.opts.proposalTtl ?? 600)) / 60,
          ) * 60,
        ...(plan.data !== undefined ? { data: plan.data } : {}),
      };
      const proposal = { ...p, hash: await proposalHash(p) } as Proposal;

      this.proposals.set(proposal.id, {
        proposal,
        plan,
        principal,
        requester: verifiedKey(req),
        created: now,
      });
      proposals.push(proposal);
    }

    this.sweep(now);

    if (req.auto) {
      const stored = this.proposals.get(proposals[0].id)!;
      const ok = await this.autoAuth(req, proposals[0]);

      if (ok && (!stored.principal || stored.principal === ok.iss)) {
        const out = await this.execute(stored, ok, req.id, emit);

        return out.kind === 'RECEIPT'
          ? fit({ ...out, auto: true }, budget, this.handles, verifiedKey(req))
          : out;
      }
    }

    return fit(
      {
        parley: 1,
        id: randomId('s', 6),
        re: req.id,
        kind: 'PROPOSALS',
        proposals,
      },
      budget,
      this.handles,
      verifiedKey(req),
    );
  }

  private sweeps = 0;
  /** Bound memory: forget expired uncommitted proposals, and receipts a day after their undo window. */
  private sweep(now: number) {
    if (++this.sweeps % 100 !== 0 && this.proposals.size < 5000) return;

    for (const [id, s] of this.proposals)
      if (s.proposal.expires < now - 3600 && !this.commits.has(id))
        this.proposals.delete(id);

    for (const [id, r] of this.receipts) {
      if ((r.receipt.undo?.until ?? r.receipt.at) + DAY < now) {
        this.receipts.delete(id);
        this.commits.delete(r.receipt.proposal);
        this.proposals.delete(r.receipt.proposal);
      }
    }

    for (const [k, v] of this.autoSeen)
      if (v.exp <= now) this.autoSeen.delete(k);
  }

  private async onCommit(
    req: Request & { verb: 'COMMIT' },
    budget: number,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const stored = this.proposals.get(req.proposal);

    if (!stored)
      throw new ParleyError(
        'not_found',
        `no proposal ${JSON.stringify(req.proposal)}`,
        { fix: [fix('send INTENT again to get fresh proposals')] },
      );

    const { proposal } = stored;

    if (req.hash !== proposal.hash)
      throw new ParleyError(
        'conflict',
        'hash does not match the proposal; you would commit something other than what you saw',
        { fix: [fix('re-read the proposal, or send INTENT again')] },
      );

    const existing = this.commits.get(proposal.id);

    if (existing) {
      // Idempotent replay (SPEC §4.4): same principal and requester only; limits already spent don't block it.
      const auth = (await this.authorize(
        req,
        'COMMIT',
        proposal.capability,
        proposal.hash,
        proposal,
        { principal: stored.principal, replay: true },
      ))!;

      this.checkRequester(stored, auth);

      const prior = await existing;

      if (
        prior.kind === 'RECEIPT' &&
        this.receipts.get(prior.receipt.id)?.principal !== auth.iss
      )
        throw new ParleyError(
          'forbidden',
          'this proposal was committed by a different principal',
        );

      return prior.kind === 'RECEIPT'
        ? { ...prior, id: randomId('s', 6), re: req.id, replay: true }
        : { ...prior, id: randomId('s', 6), re: req.id };
    }

    const auth = (await this.authorize(
      req,
      'COMMIT',
      proposal.capability,
      proposal.hash,
      proposal,
      { principal: stored.principal },
    ))!;

    this.checkRequester(stored, auth);

    if (this.now() >= proposal.expires)
      throw new ParleyError('expired', 'this proposal has expired', {
        fix: [fix('send INTENT again to get a fresh proposal')],
      });

    const out = await this.execute(stored, auth, req.id, emit);

    return out.kind === 'RECEIPT'
      ? fit(out, budget, this.handles, auth.holder)
      : out;
  }

  /** Only the agent that asked for a proposal (with a verified proof) may commit it. */
  private checkRequester(
    stored: StoredProposal,
    auth: GrantCheck & { ok: true },
  ) {
    if (!stored.requester)
      throw new ParleyError(
        'forbidden',
        "this proposal came from an anonymous INTENT and can't be committed",
        {
          fix: [
            fix('send INTENT again with your grant, then commit that proposal'),
          ],
        },
      );

    if (stored.requester !== auth.holder)
      throw new ParleyError(
        'forbidden',
        'only the agent that requested this proposal can commit it',
        { fix: [fix('send INTENT yourself, then commit your own proposal')] },
      );
  }

  private execute(
    stored: StoredProposal,
    auth: GrantCheck & { ok: true },
    reqId: string,
    emit: (e: Event) => void,
  ): Promise<ReceiptReply | ErrorReply> {
    const { proposal, plan } = stored;
    const req = { id: reqId };
    // Reserve spend synchronously, before any await, so concurrent commits can't overshoot a cap.
    const cost = proposal.cost?.amount ?? 0;
    const over = auth.spendBlocks.find(
      (b) => (this.spent.get(b.id) ?? 0) + cost > b.max,
    );

    if (cost && over) {
      return Promise.resolve(
        this.errorReply(
          reqId,
          new ParleyError(
            'consent_required',
            'would exceed the spend limit (other commits are in flight); your principal must approve this exact proposal',
            {
              consent: {
                proposal: proposal.id,
                hash: proposal.hash,
                service: this.id,
                capability: proposal.capability,
                principal: auth.iss,
                summary: proposal.summary,
                expires: proposal.expires,
              },
            },
          ),
        ),
      );
    }

    if (cost)
      for (const b of auth.spendBlocks)
        this.spent.set(b.id, (this.spent.get(b.id) ?? 0) + cost);

    const run = (async (): Promise<ReceiptReply | ErrorReply> => {
      const ctx: CommitCtx = {
        principal: auth.iss,
        progress: (message, progress, data) =>
          emit({
            parley: 1,
            id: randomId('s', 6),
            re: req.id,
            kind: 'EVENT',
            message,
            ...(progress !== undefined ? { progress } : {}),
            ...(data !== undefined ? { data } : {}),
          }),
      };

      try {
        const result = await plan.apply(ctx);
        const at = this.now();
        const receipt: Receipt = {
          id: randomId('r', 6),
          proposal: proposal.id,
          capability: proposal.capability,
          summary: proposal.summary,
          at,
          effects: proposal.effects,
          cost: proposal.cost,
          undo: proposal.undo ? { until: at + proposal.undo.window } : null,
          ...(result !== undefined ? { result } : {}),
        };

        this.receipts.set(receipt.id, {
          receipt,
          plan,
          result,
          principal: auth.iss,
        });

        return {
          parley: 1,
          id: randomId('s', 6),
          re: req.id,
          kind: 'RECEIPT',
          receipt,
        };
      } catch (e) {
        this.commits.delete(proposal.id); // failed commits may be retried

        if (cost)
          for (const b of auth.spendBlocks)
            this.spent.set(b.id, (this.spent.get(b.id) ?? 0) - cost);

        return this.errorReply(req.id, e);
      }
    })();

    this.commits.set(proposal.id, run);

    return run;
  }

  private async onUndo(
    req: Request & { verb: 'UNDO' },
    budget: number,
    emit: (e: Event) => void,
  ): Promise<FinalReply> {
    const stored = this.receipts.get(req.receipt);

    if (!stored || stored.receipt.undoes)
      throw new ParleyError(
        'not_found',
        `no undoable receipt ${JSON.stringify(req.receipt)}`,
      );

    const auth = (await this.authorize(
      req,
      'UNDO',
      stored.receipt.capability,
      req.receipt,
    ))!;

    if (auth.iss !== stored.principal)
      throw new ParleyError(
        'forbidden',
        'only the principal who committed this can undo it',
      );

    if (stored.undone) {
      const prior = await stored.undone;

      return prior.kind === 'RECEIPT'
        ? { ...prior, id: randomId('s', 6), re: req.id, replay: true }
        : { ...prior, id: randomId('s', 6), re: req.id };
    }

    const { receipt, plan } = stored;

    if (!receipt.undo || !plan.revert)
      throw new ParleyError('forbidden', 'this action is irreversible');

    if (this.now() > receipt.undo.until)
      throw new ParleyError(
        'expired',
        `the undo window closed at ${new Date(receipt.undo.until * 1000).toISOString()}`,
      );

    stored.undone = (async (): Promise<ReceiptReply | ErrorReply> => {
      try {
        await plan.revert!({
          principal: auth.iss,
          result: stored.result,
          progress: (message, progress) =>
            emit({
              parley: 1,
              id: randomId('s', 6),
              re: req.id,
              kind: 'EVENT',
              message,
              ...(progress !== undefined ? { progress } : {}),
            }),
        });

        const inverse: Record<string, Effect['op']> = {
          create: 'delete',
          delete: 'create',
          update: 'update',
          send: 'other',
          charge: 'other',
          other: 'other',
        };
        const effects: Effect[] = receipt.effects.map((e) =>
          e.op === 'update'
            ? { ...e, from: e.to, to: e.from }
            : e.op === 'charge'
              ? { op: 'other', target: e.target, detail: 'refund' }
              : e.op === 'send'
                ? {
                    op: 'other',
                    target: e.target,
                    detail: 'cannot unsend; follow-up sent if supported',
                  }
                : { ...e, op: inverse[e.op] },
        );
        const undo: Receipt = {
          id: randomId('r', 6),
          proposal: receipt.proposal,
          capability: receipt.capability,
          summary: receipt.summary,
          at: this.now(),
          effects,
          cost: null,
          undo: null,
          undoes: receipt.id,
        };

        return {
          parley: 1,
          id: randomId('s', 6),
          re: req.id,
          kind: 'RECEIPT',
          receipt: undo,
        };
      } catch (e) {
        stored.undone = undefined;

        return this.errorReply(req.id, e);
      }
    })();

    const out = await stored.undone;

    return out.kind === 'RECEIPT'
      ? fit(out, budget, this.handles, auth.holder)
      : out;
  }

  private async onExpand(
    req: Request & { verb: 'EXPAND' },
    budget: number,
  ): Promise<FinalReply> {
    const parked = this.handles.get(req.handle);

    if (!parked)
      throw new ParleyError(
        'expired',
        `handle ${JSON.stringify(req.handle)} is unknown or expired`,
        { fix: [fix('repeat the original request')] },
      );

    // Handles from authenticated replies expand only for the same holder key (SPEC §4.6).
    if (parked.owner) {
      const err = await checkProof(
        req.proof,
        { aud: this.id, verb: 'EXPAND', target: req.handle },
        this.now(),
      );

      if (err || req.proof!.key !== parked.owner)
        throw new ParleyError(
          'unauthorized',
          'this handle belongs to another agent',
          {
            fix: [
              fix('expand it with the same key that made the original request'),
            ],
          },
        );
    } else if (this.opts.requireGrants) {
      throw new ParleyError(
        'unauthorized',
        'EXPAND needs a grant from your principal',
      );
    }

    const data =
      parked.kind === 'array' ? { items: parked.items } : { text: parked.text };

    return fit(
      { parley: 1, id: randomId('s', 6), re: req.id, kind: 'ANSWER', data },
      budget,
      this.handles,
      parked.owner ?? null,
    );
  }
}

export const service = (opts: ServiceOptions) => new Service(opts);

/** The holder key of a request whose proof has already been verified by authorize() (grants present ⇒ proof checked). */
const verifiedKey = (req: Request): string | null =>
  req.grants?.length && req.proof ? req.proof.key : null;

// ---- effect helpers ----
export const create = (target: string, detail?: string): Effect => ({
  op: 'create',
  target,
  ...(detail ? { detail } : {}),
});

export const update = (
  target: string,
  field: string,
  from: Effect['from'],
  to: Effect['to'],
  detail?: string,
): Effect => ({
  op: 'update',
  target,
  field,
  from,
  to,
  ...(detail ? { detail } : {}),
});

export const remove = (target: string, detail?: string): Effect => ({
  op: 'delete',
  target,
  ...(detail ? { detail } : {}),
});

export const send = (target: string, detail?: string): Effect => ({
  op: 'send',
  target,
  ...(detail ? { detail } : {}),
});

export const charge = (target: string, detail?: string): Effect => ({
  op: 'charge',
  target,
  ...(detail ? { detail } : {}),
});

export const money = (amount: number, currency = 'USD'): Money => ({
  amount,
  currency,
});
