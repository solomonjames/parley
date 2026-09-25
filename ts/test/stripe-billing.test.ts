// The guide's full example against a fake of the Stripe endpoints it calls.
import { beforeAll, describe, expect, it } from 'vitest';
import { stripeBilling } from '../../examples/stripe-billing.ts';
import * as P from '../src/index.js';

const now = Math.floor(Date.now() / 1000),
  D = 86400;

function fakeStripe() {
  const customers = [
    { id: 'cus_ana1', name: 'Ana Ruiz', email: 'ana.ruiz@acme.co' },
    { id: 'cus_ana2', name: 'Ana Li', email: 'ana@northwind.io' },
    { id: 'cus_chen', name: 'Chen Wei', email: 'chen@wei.studio' },
  ];
  const charges = [
    {
      id: 'ch_2',
      customer: 'cus_chen',
      amount: 4900,
      amount_refunded: 0,
      currency: 'usd',
      status: 'succeeded',
      created: now - 16 * D,
    },
    {
      id: 'ch_1',
      customer: 'cus_chen',
      amount: 4900,
      amount_refunded: 0,
      currency: 'usd',
      status: 'succeeded',
      created: now - 46 * D,
    },
  ];
  const subs = [
    {
      id: 'sub_chen',
      customer: 'cus_chen',
      status: 'active',
      cancel_at_period_end: false,
      items: {
        data: [
          {
            current_period_start: now - 16 * D,
            current_period_end: now + 14 * D,
            price: { id: 'price_pro', nickname: 'pro' },
          },
        ],
      },
    },
  ];
  const calls: {
    method: string;
    path: string;
    body: string;
    key: string | null;
  }[] = [];

  const fetch = async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)),
      method = init?.method ?? 'GET',
      body = String(init?.body ?? '');
    const headers = new Headers(init?.headers);

    calls.push({
      method,
      path: u.pathname + u.search,
      body,
      key: headers.get('idempotency-key'),
    });

    const ok = (x: unknown) => new Response(JSON.stringify(x), { status: 200 });
    const p = u.pathname.replace('/v1', ''),
      form = new URLSearchParams(body);

    if (p === '/customers/search') {
      // Enough of Stripe's query language for `name:"x" OR email:"x"`: every word must appear.
      const words = JSON.parse(
        u.searchParams.get('query')!.split(' OR ')[0].slice(5),
      )
        .toLowerCase()
        .split(/\s+/);

      return ok({
        data: customers.filter((c) =>
          words.every(
            (w: string) =>
              `${c.name} ${c.email}`
                .toLowerCase()
                .split(/[^a-z0-9]+/)
                .includes(w) || c.email === w,
          ),
        ),
      });
    }

    if (p.startsWith('/customers/')) {
      const c = customers.find((x) => x.id === p.split('/')[2]);

      return c
        ? ok(c)
        : new Response(
            JSON.stringify({ error: { message: 'No such customer' } }),
            { status: 404 },
          );
    }

    if (p === '/charges') {
      return ok({
        data: charges.filter(
          (c) => c.customer === u.searchParams.get('customer'),
        ),
      });
    }

    if (p === '/subscriptions') {
      return ok({
        data: subs.filter(
          (s) =>
            s.customer === u.searchParams.get('customer') &&
            s.status === 'active',
        ),
      });
    }

    if (p === '/refunds') {
      const ch = charges.find((c) => c.id === form.get('charge'))!;

      ch.amount_refunded += Number(form.get('amount'));

      return ok({ id: 're_1', status: 'succeeded' });
    }

    if (p.startsWith('/subscriptions/')) {
      const s = subs.find((x) => x.id === p.split('/')[2])!;

      if (method === 'DELETE') {
        s.status = 'canceled';
      } else {
        s.cancel_at_period_end = form.get('cancel_at_period_end') === 'true';
      }

      return ok(s);
    }

    return new Response('{}', { status: 400 });
  };

  return { fetch: fetch as typeof globalThis.fetch, calls, charges, subs };
}

let principal: P.KeyPair, agent: P.KeyPair;

beforeAll(async () => {
  principal = await P.keyPair();
  agent = await P.keyPair();
});

async function setup(caveats: P.Caveat[] = []) {
  const stripe = fakeStripe();
  const grant = await P.issueGrant({ principal, to: agent.public, caveats });
  const client = new P.Client(
    P.local(
      stripeBilling({
        key: 'sk_test_x',
        trust: [principal.public],
        fetch: stripe.fetch,
      }),
    ),
    { key: agent.seed, grants: [grant] },
  );

  return { client, stripe };
}

describe("Stripe-backed billing (the guide's full example)", () => {
  it('one ASK joins customer, subscription and charges', async () => {
    const { client } = await setup();
    const r = await client.ask('billing.customer', { who: 'Chen' });

    expect(r.kind).toBe('ANSWER');
    expect(r.lens).toContain('payments[2]{id,date,amount,refunded,status}:');
    expect(r.lens).toContain('plan: pro');
  });

  it('ambiguous names CLARIFY; a refund offers full or unused, and is never auto-committed', async () => {
    const { client, stripe } = await setup([{ risk: 'medium' }]);

    expect((await client.intent('billing.refund', { who: 'Ana' })).kind).toBe(
      'CLARIFY',
    );

    const r = await client.intent(
      'billing.refund',
      { who: 'Chen' },
      { auto: true },
    );

    if (r.kind !== 'PROPOSALS') {
      throw new Error(r.kind);
    }

    expect(r.proposals).toHaveLength(2);
    expect(r.proposals.every((p) => p.undo === null)).toBe(true);
    expect(stripe.calls.some((c) => c.path === '/v1/refunds')).toBe(false);

    const receipt = await client.commit(r.proposals[1]);

    expect(receipt.kind).toBe('RECEIPT');

    const call = stripe.calls.find((c) => c.path === '/v1/refunds')!;

    expect(call.body).toMatch(
      /^charge=ch_2&amount=\d+&reason=requested_by_customer$/,
    );
    expect(call.key).toMatch(/^parley-refund-ch_2-0-\d+$/);
    expect(stripe.charges[0].amount_refunded).toBeGreaterThan(0);
  });

  it('cancel at period end is undone with the inverse REST call', async () => {
    const { client, stripe } = await setup([{ risk: 'low' }]);
    const r = await client.intent(
      'billing.cancel',
      { who: 'chen@wei.studio' },
      { auto: true },
    );

    if (r.kind !== 'RECEIPT') {
      throw new Error(r.kind);
    }

    expect(stripe.subs[0].cancel_at_period_end).toBe(true);
    await client.undo(r.receipt.id);
    expect(stripe.subs[0].cancel_at_period_end).toBe(false);
    expect(
      stripe.calls.filter((c) => c.method === 'POST').map((c) => c.body),
    ).toEqual(['cancel_at_period_end=true', 'cancel_at_period_end=false']);
  });

  it('Stripe errors become teaching errors', async () => {
    const { client } = await setup();
    const r = await client.ask('billing.customer', { who: 'cus_nope' });

    expect(r.kind === 'ERROR' && r.code).toBe('not_found');
    expect(r.lens).toContain('fix:');
  });
});
