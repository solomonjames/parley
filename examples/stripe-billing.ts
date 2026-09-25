// A Parley service in front of the real Stripe API: the full example in the service design
// guide (site/guide/service-design.md). The agent sees three capabilities, not Stripe's
// endpoints. Each apply() makes the Stripe call, and each revert() makes the inverse one.
//
//   STRIPE_SECRET_KEY=sk_test_… PARLEY_TRUST=ed25519:… node examples/stripe-billing.ts
import {
  ParleyError,
  clarify,
  fix,
  money,
  send,
  service,
  update,
  type Plan,
} from 'parley-protocol';

const API = 'https://api.stripe.com/v1';
const amt = (minor: number, cur: string) =>
  `${(minor / 100).toFixed(2)} ${cur.toUpperCase()}`;
const day = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 10);
const roundDown = (secs: number) =>
  secs >= 86400
    ? Math.floor(secs / 86400) * 86400
    : Math.max(0, Math.floor(secs / 3600) * 3600);

export function stripeBilling(opts: {
  key: string;
  trust: string[];
  fetch?: typeof fetch;
}) {
  const f = opts.fetch ?? fetch;

  // The only code that speaks REST. Stripe's error objects become errors that teach.
  async function stripe(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: Record<string, string>,
    idempotencyKey?: string,
  ): Promise<any> {
    const res = await f(API + path, {
      method,
      headers: {
        authorization: `Bearer ${opts.key}`,
        ...(body
          ? { 'content-type': 'application/x-www-form-urlencoded' }
          : {}),
        ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
      },
      body: body ? new URLSearchParams(body).toString() : undefined,
    });
    const json: any = await res.json();

    if (res.ok) return json;

    const message = json.error?.message ?? `Stripe returned ${res.status}`;

    if (res.status === 404)
      throw new ParleyError('not_found', message, {
        fix: [fix('ASK billing.customer with a name or email')],
      });

    if (res.status === 429)
      throw new ParleyError('limit', 'Stripe is rate limiting; retry shortly', {
        retry: 2,
      });

    if (res.status >= 500)
      throw new ParleyError('unavailable', message, { retry: 5 });

    // Params were validated before any REST call, so a remaining 4xx means the state changed.
    throw new ParleyError('conflict', message);
  }

  // People say "Chen" or an email, not cus_NffrFeUfNV2Hib. Stripe's exact match on a string
  // field matches any record containing the words, so "Chen" finds "Chen Wei".
  async function findCustomers(who: string): Promise<any[]> {
    if (/^cus_\w+$/.test(who))
      return [await stripe('GET', `/customers/${who}`)];

    const q = JSON.stringify(who); // Stripe wants double-quoted, backslash-escaped strings
    const query = new URLSearchParams({
      query: `name:${q} OR email:${q}`,
      limit: '5',
    });

    return (await stripe('GET', `/customers/search?${query}`)).data;
  }

  const label = (c: any) => `${c.name} <${c.email}>`;

  // Intents resolve one customer, or answer with CLARIFY; each option is a params patch.
  async function one(who: string, then: (c: any) => Promise<Plan | Plan[]>) {
    const m = await findCustomers(who);

    if (!m.length)
      throw new ParleyError(
        'not_found',
        `no customer matches ${JSON.stringify(who)}`,
        {
          fix: [fix('try their email address')],
        },
      );

    if (m.length > 1)
      return clarify(
        `${m.length} customers match "${who}". Which one?`,
        m.map((c) => ({ label: label(c), params: { who: c.id } })),
      );

    return then(m[0]);
  }

  const charges = async (c: any) =>
    (
      await stripe(
        'GET',
        `/charges?${new URLSearchParams({ customer: c.id, limit: '5' })}`,
      )
    ).data;
  const subscription = async (c: any) =>
    (
      await stripe(
        'GET',
        `/subscriptions?${new URLSearchParams({ customer: c.id, status: 'active', limit: '1' })}`,
      )
    ).data[0] ?? null;
  // Since API version 2025-03-31 the billing period lives on the subscription item.
  const period = (s: any) => ({
    start: s.items.data[0].current_period_start as number,
    end: s.items.data[0].current_period_end as number,
  });

  return (
    service({
      id: 'billing.stripe.example',
      name: 'Billing (Stripe)',
      summary:
        'Customers, refunds and cancellations on our Stripe account. ' +
        'Refer to customers by name, email or cus_ id. ' +
        "Refunds and immediate cancellations can't be undone.",
      trust: opts.trust,
    })
      // Replaces GET /v1/customers/search + GET /v1/subscriptions + GET /v1/charges.
      .ask('billing.customer', {
        summary: "A customer's subscription and recent payments",
        params: { who: 'string — name, email or cus_ id' },
        async run({ params }) {
          const m = await findCustomers(params.who);

          if (!m.length)
            throw new ParleyError(
              'not_found',
              `no customer matches ${JSON.stringify(params.who)}`,
              { fix: [fix('try their email address')] },
            );

          // An ASK can't CLARIFY, so an ambiguous read teaches instead: one fix per candidate.
          if (m.length > 1)
            throw new ParleyError(
              'invalid_params',
              `${m.length} customers match ${JSON.stringify(params.who)}`,
              { fix: m.map((c) => fix(`use ${label(c)}`, { who: c.id })) },
            );

          const c = m[0];
          const [sub, chs] = await Promise.all([subscription(c), charges(c)]);

          return {
            id: c.id,
            name: c.name,
            email: c.email,
            plan: sub
              ? (sub.items.data[0].price.nickname ?? sub.items.data[0].price.id)
              : 'none',
            ...(sub
              ? {
                  [sub.cancel_at_period_end ? 'cancels' : 'renews']: day(
                    period(sub).end,
                  ),
                }
              : {}),
            // Flat, uniform rows, so Lens renders them as a table. Only the fields an agent needs.
            payments: chs.map((ch: any) => ({
              id: ch.id,
              date: day(ch.created),
              amount: amt(ch.amount, ch.currency),
              refunded: amt(ch.amount_refunded, ch.currency),
              status: ch.status,
            })),
          };
        },
      })
      // Replaces the lookups above + the agent's own proration math + POST /v1/refunds.
      .intent('billing.refund', {
        summary: 'Refund a payment (irreversible)',
        params: {
          who: 'string',
          'payment?': 'string — ch_ id; default: the latest',
          'amount?': 'number — a partial refund, in major units',
        },
        risk: 'medium',
        plan: ({ params }) =>
          one(params.who, async (c) => {
            const [chs, sub] = await Promise.all([charges(c), subscription(c)]);
            const ch = params.payment
              ? chs.find((x: any) => x.id === params.payment)
              : chs.find(
                  (x: any) =>
                    x.status === 'succeeded' && x.amount_refunded < x.amount,
                );

            if (!ch)
              throw new ParleyError(
                'not_found',
                `no refundable payment${params.payment ? ` ${params.payment}` : ''} for ${c.name}`,
                {
                  fix: chs.map((x: any) =>
                    fix(
                      `use ${x.id} (${day(x.created)}, ${amt(x.amount, x.currency)})`,
                      {
                        payment: x.id,
                      },
                    ),
                  ),
                },
              );

            const left = ch.amount - ch.amount_refunded;
            const refund = (amount: number, why: string): Plan => ({
              summary: `Refund ${amt(amount, ch.currency)} of ${ch.id} to ${c.name} (${why})`,
              effects: [
                update(
                  `charge/${ch.id}`,
                  'amount_refunded',
                  amt(ch.amount_refunded, ch.currency),
                  amt(ch.amount_refunded + amount, ch.currency),
                ),
                send(c.email, `refund receipt; back on the card in 5–10 days`),
              ],
              cost: money(amount, ch.currency.toUpperCase()),
              // Parley runs apply() at most once; the key covers a network failure inside it.
              apply: () =>
                stripe(
                  'POST',
                  '/refunds',
                  {
                    charge: ch.id,
                    amount: String(amount),
                    reason: 'requested_by_customer',
                  },
                  `parley-refund-${ch.id}-${ch.amount_refunded}-${amount}`,
                ),
              // No revert: Stripe can't reverse a refund, so the proposal says undo: never
              // and Parley will never auto-commit it.
            });

            if (params.amount != null) {
              const amount = Math.round(params.amount * 100);

              if (amount <= 0 || amount > left)
                throw new ParleyError(
                  'invalid_params',
                  `refund must be between 0.01 and ${amt(left, ch.currency)}`,
                  {
                    fix: [
                      fix(`refund the rest (${amt(left, ch.currency)})`, {
                        amount: left / 100,
                      }),
                    ],
                  },
                );

              return refund(amount, 'partial');
            }

            // Alternatives a person would offer: all of it, or only the unused part of this period.
            const plans = [refund(left, 'full')];

            if (sub && ch.id === chs[0]?.id) {
              const { start, end } = period(sub),
                now = Date.now() / 1000;
              const unused = Math.round(
                left * Math.max(0, (end - now) / (end - start)),
              );

              if (unused > 0 && unused < left)
                plans.push(
                  refund(
                    unused,
                    `unused ${Math.round((end - now) / 86400)} days`,
                  ),
                );
            }

            return plans;
          }),
      })
      // Replaces two endpoints the agent had to tell apart: POST cancel_at_period_end (reversible)
      // and DELETE (final). Here they're two proposals that say which is which.
      .intent('billing.cancel', {
        summary: 'Cancel a subscription',
        params: { who: 'string' },
        risk: 'low',
        plan: ({ params }) =>
          one(params.who, async (c) => {
            const sub = await subscription(c);

            if (!sub)
              throw new ParleyError(
                'conflict',
                `${c.name} has no active subscription`,
              );

            const { end } = period(sub),
              path = `/subscriptions/${sub.id}`;
            const now: Plan = {
              summary: `Cancel ${c.name} now; access ends immediately, no refund`,
              effects: [
                update(
                  `subscription/${sub.id}`,
                  'status',
                  sub.status,
                  'canceled',
                ),
              ],
              risk: 'medium',
              apply: () => stripe('DELETE', path), // no inverse call exists, so no revert
            };

            if (sub.cancel_at_period_end) return now;

            return [
              {
                summary: `Cancel ${c.name} on ${day(end)}; access until then`,
                effects: [
                  update(
                    `subscription/${sub.id}`,
                    'cancel_at_period_end',
                    false,
                    true,
                  ),
                ],
                // Rounded down to whole days, so it reads "undo: 13d" and ends before the period.
                undoWindow: roundDown(end - Date.now() / 1000),
                apply: () =>
                  stripe('POST', path, { cancel_at_period_end: 'true' }),
                // The inverse REST call.
                revert: () =>
                  stripe('POST', path, { cancel_at_period_end: 'false' }),
              },
              now,
            ];
          }),
      })
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { listen } = await import('parley-protocol/node');
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key)
    throw new Error(
      'set STRIPE_SECRET_KEY (a test-mode sk_test_… key is fine)',
    );

  const trust = (process.env.PARLEY_TRUST ?? '').split(',').filter(Boolean);

  await listen(stripeBilling({ key, trust }), { port: 7453 });
  console.error('billing (Stripe) on parley://127.0.0.1:7453');
}
