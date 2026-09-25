/**
 * The agent-facing tool surface shared by the MCP bridge and `parley test-drive`:
 * four tools whose results are Lens, with consent routed to a human through `approve`.
 */
import { consentCode, consentGrant } from './grants.js';
import { loadGrants, principalKey, saveGrant } from './home.js';
import { keyPair, proposalHash } from './crypto.js';
import { lens } from './lens.js';
import type { Client } from './client.js';
import type { ConsentRequest, ErrorReply, Proposal } from './types.js';

type Json = Record<string, any>;

const str = { type: 'string' };
const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
});

export const INSTRUCTIONS =
  "Parley acts for the user under their signed policy. To do something, call parley_intent with the user's goal (names, days are fine: no lookups needed) " +
  'and auto:true if they asked for exactly this; it finishes in one call when the policy allows. parley_ask is for questions. If approval is needed, tell the user.\n\n';

export const TOOLS = [
  {
    name: 'parley_ask',
    description:
      'Read (never changes anything). Pass `handle` to expand an elided result.',
    inputSchema: obj(
      {
        service: str,
        capability: str,
        params: { type: 'object' },
        handle: str,
        budget: { type: 'integer' },
      },
      ['service'],
    ),
  },
  {
    name: 'parley_intent',
    description:
      "Do something: the user's goal as params (names, days are fine). auto:true finishes now if their policy allows; else returns proposals (effects, cost, risk, undo) or a question.",
    inputSchema: obj(
      {
        service: str,
        capability: str,
        params: { type: 'object' },
        goal: str,
        auto: { type: 'boolean' },
        budget: { type: 'integer' },
      },
      ['service', 'capability'],
    ),
  },
  {
    name: 'parley_commit',
    description:
      'Execute a proposal by id, exactly as shown. Only what the user wants.',
    inputSchema: obj({ service: str, proposal: str }, ['service', 'proposal']),
  },
  {
    name: 'parley_undo',
    description: 'Undo a receipt within its undo window.',
    inputSchema: obj({ service: str, receipt: str }, ['service', 'receipt']),
  },
];

/** Ask the human to approve `shown` (the proposal's Lens). Resolve true only on explicit approval. */
export type Approver = (req: {
  service: string;
  shown: string;
  reason: string;
}) => Promise<boolean>;

export interface ToolHost {
  instructions: string;
  services: string[];
  call(name: string, args: Json): Promise<{ text: string; isError?: boolean }>;
  close(): void;
}

export async function createToolHost(
  clients: Client[],
  approve?: Approver,
): Promise<ToolHost> {
  const services = new Map<string, Client>();
  // Remember each proposal as shown, so the model only handles short ids while COMMIT
  // (and any consent) still binds to exactly what was shown.
  const seen = new Map<string, { service: string; proposal: Proposal }>();
  const briefs: string[] = [];
  const problems: string[] = [];

  for (const c of clients) {
    try {
      const b = await c.hello(1500);

      if (b.kind !== 'BRIEF') throw new Error(b.lens);

      services.set(b.service.id, c);
      briefs.push(b.lens);
    } catch (e) {
      problems.push(
        `(a service could not be reached: ${(e as Error).message})`,
      );
    }
  }

  const none =
    'No Parley services are configured. Tell the user to run `npx parley-protocol add <url>` (or `npx parley-protocol setup`) and restart.';
  const instructions =
    INSTRUCTIONS +
    (briefs.length ? briefs.join('\n\n') : none) +
    (problems.length ? `\n\n${problems.join('\n')}` : '');

  /** Build the consent only from the proposal we showed, never from the service's error. */
  async function consentFor(
    err: ErrorReply,
    c: Client,
    p: Proposal,
  ): Promise<ConsentRequest | null> {
    const k = err.consent;

    if (
      !k ||
      k.proposal !== p.id ||
      k.hash !== p.hash ||
      k.capability !== p.capability ||
      k.service !== (await c.audience())
    )
      return null;

    if ((await proposalHash(p)) !== p.hash) return null;

    return {
      proposal: p.id,
      hash: p.hash,
      service: k.service,
      capability: p.capability,
      principal: k.principal,
      summary: p.summary,
      expires: Math.min(k.expires, p.expires),
    };
  }

  async function askHuman(
    consent: ConsentRequest,
    err: ErrorReply,
    c: Client,
    p: Proposal,
  ): Promise<string | null> {
    const principal = await principalKey();

    if (
      !approve ||
      !principal ||
      principal.public !== consent.principal ||
      !c.key
    )
      return null;

    const shown = lens({
      parley: 1,
      id: '-',
      re: '-',
      kind: 'PROPOSALS',
      proposals: [p],
    })
      .split('\n')
      .slice(1)
      .join('\n');

    if (
      !(await approve({ service: consent.service, shown, reason: err.message }))
    )
      return null;

    const token = await consentGrant({
      principal,
      agent: (await keyPair(c.key)).public,
      consent,
    });

    saveGrant(token, 'consents', consent.hash);

    return token;
  }

  async function call(
    name: string,
    a: Json,
  ): Promise<{ text: string; isError?: boolean }> {
    const c = services.get(a.service);

    if (!c)
      return {
        text: `✗ unknown service ${JSON.stringify(a.service)}; known: ${[...services.keys()].join(', ')}`,
        isError: true,
      };

    const budget = a.budget ?? 1500;

    switch (name) {
      case 'parley_ask':
        if (a.handle)
          return { text: (await c.expand(a.handle, { budget })).lens };

        if (!a.capability) return { text: (await c.hello(budget)).lens };

        return {
          text: (await c.ask(a.capability, a.params ?? {}, { budget })).lens,
        };
      case 'parley_intent': {
        const r = await c.intent(a.capability, a.params ?? {}, {
          goal: a.goal,
          budget,
          auto: a.auto === true,
        });

        if (r.kind === 'PROPOSALS')
          for (const p of r.proposals)
            seen.set(p.id, { service: a.service, proposal: p });

        return { text: r.lens, isError: r.kind === 'ERROR' };
      }
      case 'parley_undo': {
        const r = await c.undo(a.receipt);

        return { text: r.lens, isError: r.kind === 'ERROR' };
      }
      case 'parley_commit': {
        const events: string[] = [];
        const known = seen.get(a.proposal);

        if (!known || known.service !== a.service)
          return {
            text: `✗ not_found: unknown proposal ${a.proposal} at ${a.service}; call parley_intent first`,
            isError: true,
          };

        const p = known.proposal;
        let r = await c.commit(p, {
          grants: loadGrants('consents'),
          onEvent: (e) => events.push(e.lens),
        });

        if (r.kind === 'ERROR' && r.code === 'consent_required') {
          const consent = await consentFor(r, c, p);

          if (!consent)
            return {
              text:
                r.lens +
                "\n  → the service's consent request doesn't match this proposal; not asking the user to sign it.",
              isError: true,
            };

          const token = await askHuman(consent, r, c, p);

          if (token)
            r = await c.commit(p, {
              grants: [token],
              onEvent: (e) => events.push(e.lens),
            });
          else if (r.kind === 'ERROR') {
            return {
              text:
                r.lens +
                `\n  → the user did not approve this here. If they want it, ask them to review it and run, in their own terminal: parley approve ${consentCode(consent, p)}  — then call parley_commit again.`,
              isError: true,
            };
          }
        }

        return {
          text: [...events, r.lens].join('\n'),
          isError: r.kind === 'ERROR',
        };
      }
    }

    return { text: `✗ unknown tool ${name}`, isError: true };
  }

  return {
    instructions,
    services: [...services.keys()],
    call,
    close: () => clients.forEach((c) => c.close()),
  };
}
