// Subscription billing that speaks Parley: the worked example in the service design guide
// (site/guide/service-design.md). It covers the jobs a support or finance agent does with
// a payments API such as Stripe's: look a customer up, refund, change plan, cancel. Here
// they're designed as outcomes instead of resources. The data is made up.
import { ParleyError, charge, clarify, fail, fix, money, send, service, update, type Plan } from "../index.js";

type PlanId = "starter" | "pro" | "team";
const PRICES: Record<PlanId, number> = { starter: 1900, pro: 4900, team: 9900 };
const DAY = 86400_000;

interface Payment { id: string; at: number; amount: number; status: "paid" | "failed"; refunded: number }
interface Customer { id: string; name: string; email: string; plan: PlanId; status: "active" | "past_due" | "canceled"; card: string; renews: number; cancelAt: number | null; nextPlan: PlanId | null; payments: Payment[] }

const usd = (cents: number) => `${(cents / 100).toFixed(2)} USD`;
const date = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function billing(opts: { trust: string[] | ((principal: string) => boolean); id?: string }) {
  // Computed per call, not at module load: some runtimes (Workers) freeze the clock during startup.
  const now = Date.now();
  let seq = 100;
  const customer = (id: string, name: string, email: string, plan: PlanId, renewsInDays: number, card: string, lastFailed = false): Customer => {
    const renews = now + renewsInDays * DAY;
    // Three monthly payments, the latest at the start of the current period.
    const payments = [2, 1, 0].map((k): Payment => ({
      id: `pay_${++seq}`, at: renews - (k + 1) * 30 * DAY, amount: PRICES[plan],
      status: k === 0 && lastFailed ? "failed" : "paid", refunded: 0,
    }));
    return { id, name, email, plan, status: lastFailed ? "past_due" : "active", card, renews, cancelAt: null, nextPlan: null, payments };
  };
  const customers: Customer[] = [
    customer("cus_ana_r", "Ana Ruiz", "ana.ruiz@acme.co", "pro", 21, "visa ••4242"),
    customer("cus_ana_l", "Ana Li", "ana@northwind.io", "team", 9, "amex ••1005"),
    customer("cus_ben", "Ben Okafor", "ben@okafor.dev", "starter", 3, "visa ••0341", true),
    customer("cus_chen", "Chen Wei", "chen@wei.studio", "pro", 14, "mc ••7730"),
    customer("cus_dana", "Dana Park", "dana@park.io", "team", 27, "visa ••9921"),
  ];

  // Agents refer to people the way the user did ("Ana", an email); the service resolves it.
  const find = (who: string) => {
    const q = who.toLowerCase().trim();
    const exact = customers.find((c) => c.id === q || c.email === q);
    if (exact) return [exact];
    const words = q.split(/\s+/).filter(Boolean);
    // Each word must start a word of the name or email: "ana" finds Ana Ruiz, not Dana Park.
    const tokens = (c: Customer) => `${c.name} ${c.email}`.toLowerCase().split(/[^a-z0-9]+/);
    return customers.filter((c) => words.every((w) => tokens(c).some((t) => t.startsWith(w))));
  };
  const label = (c: Customer) => `${c.name} <${c.email}> · ${c.plan}`;
  const notFound = (who: string) => fail("not_found", `no customer matches ${JSON.stringify(who)}`, { fix: [fix("ASK billing.customers to search")] });
  // Intents answer ambiguity with CLARIFY; each option is a params patch the agent merges.
  const pick = (who: string, then: (c: Customer) => Plan | Plan[]) => {
    const m = find(who);
    if (!m.length) notFound(who);
    if (m.length > 1) return clarify(`${m.length} customers match "${who}". Which one?`, m.map((c) => ({ label: label(c), params: { who: c.id } })));
    return then(m[0]);
  };
  const periodLeft = (c: Customer) => Math.max(0, (c.renews - now) / (30 * DAY));

  return service({
    id: opts.id ?? "billing.example",
    name: "Example Billing",
    summary: "Subscriptions for a SaaS product: plans starter 19, pro 49, team 99 USD/month. Refer to customers by name, email or id. Refunds and immediate cancellations can't be undone.",
    trust: opts.trust,
  })
    .ask("billing.customers", {
      summary: "Find customers",
      params: { "query?": "string — name or email", "status?": "active|past_due|canceled" },
      run: ({ params }) =>
        (params.query ? find(params.query) : customers)
          .filter((c) => !params.status || c.status === params.status)
          .map((c) => ({ id: c.id, name: c.name, email: c.email, plan: c.plan, status: c.status, renews: date(c.renews) })),
    })
    .ask("billing.customer", {
      summary: "One customer: plan, card, and recent payments",
      params: { who: "string — name, email or id" },
      run: ({ params }) => {
        const m = find(params.who);
        if (!m.length) notFound(params.who);
        // An ASK can't CLARIFY, so an ambiguous read teaches instead: one fix per candidate.
        if (m.length > 1) fail("invalid_params", `${m.length} customers match ${JSON.stringify(params.who)}`, { fix: m.map((c) => fix(`use ${label(c)}`, { who: c.id })) });
        const c = m[0];
        return {
          id: c.id, name: c.name, email: c.email, plan: c.plan, usd_month: PRICES[c.plan] / 100, status: c.status, card: c.card,
          renews: date(c.renews), ...(c.nextPlan ? { next_plan: c.nextPlan } : {}), ...(c.cancelAt ? { cancels: date(c.cancelAt) } : {}),
          payments: c.payments.map((p) => ({ id: p.id, date: date(p.at), usd: p.amount / 100, status: p.status, refunded_usd: p.refunded / 100 })),
        };
      },
    })
    .intent("billing.refund", {
      summary: "Refund a payment (irreversible)",
      params: { who: "string", "payment?": "string — default: latest paid", "usd?": "number — partial amount", "reason?": "duplicate|requested_by_customer|fraudulent" },
      risk: "medium",
      plan: ({ params }) => pick(params.who, (c) => {
        const paid = c.payments.filter((p) => p.status === "paid");
        const pay = params.payment ? c.payments.find((p) => p.id === params.payment) : paid.at(-1);
        if (!pay) return fail("not_found", `no payment ${JSON.stringify(params.payment)} for ${c.name}`, { fix: paid.map((p) => fix(`use ${p.id} (${date(p.at)}, ${usd(p.amount)})`, { payment: p.id })) });
        const left = pay.amount - pay.refunded;
        if (pay.status !== "paid" || left <= 0) return fail("conflict", `${pay.id} has nothing left to refund`);
        const refund = (amount: number, why: string): Plan => ({
          summary: `Refund ${usd(amount)} of ${pay.id} to ${c.name} (${why})`,
          effects: [
            update(`payment/${pay.id}`, "refunded", usd(pay.refunded), usd(pay.refunded + amount)),
            send(c.email, `refund receipt, ${usd(amount)} back to ${c.card} in 5–10 days`),
          ],
          cost: money(amount),
          apply: () => ((pay.refunded += amount), { refunded: usd(amount), payment: pay.id }),
          // No revert: money that has left can't be pulled back, so the proposal says undo: none.
        });
        if (params.usd != null) {
          const amount = Math.round(params.usd * 100);
          if (amount <= 0 || amount > left) throw new ParleyError("invalid_params", `refund must be between 0.01 and ${usd(left)}`, { fix: [fix(`refund the rest (${usd(left)})`, { usd: left / 100 })] });
          return refund(amount, "partial");
        }
        // Alternatives CRUD can't express: the whole payment, or only the unused part of this period.
        const unused = Math.round(left * periodLeft(c));
        const current = pay === paid.at(-1) && unused > 0 && unused < left;
        return current ? [refund(left, "full"), refund(unused, `unused ${Math.round(periodLeft(c) * 30)} days`)] : refund(left, "full");
      }),
    })
    .intent("billing.change_plan", {
      summary: "Move a customer to another plan",
      params: { who: "string", plan: "starter|pro|team" },
      risk: "low",
      plan: ({ params }) => pick(params.who, (c) => {
        const to = params.plan as PlanId, from = c.plan;
        if (to === from) return fail("conflict", `${c.name} is already on ${to}`, { fix: (Object.keys(PRICES) as PlanId[]).filter((p) => p !== to).map((p) => fix(`move to ${p}`, { plan: p })) });
        const diff = Math.round((PRICES[to] - PRICES[from]) * periodLeft(c));
        const sub = `subscription/${c.id}`;
        const immediate: Plan = {
          summary: `${c.name}: ${from} → ${to} now, ${diff > 0 ? `charge ${usd(diff)} prorated` : `credit ${usd(-diff)} to next invoice`}`,
          effects: [
            update(sub, "plan", from, to),
            diff > 0 ? charge(c.card, `${usd(diff)} prorated`) : update(`customer/${c.id}`, "credit", "0.00 USD", usd(-diff)),
            send(c.email, "plan change receipt"),
          ],
          cost: diff > 0 ? money(diff) : null,
          undoWindow: 86400,
          apply: () => ((c.plan = to), { plan: to }),
          revert: () => { c.plan = from; },
        };
        const later: Plan = {
          summary: `${c.name}: ${from} → ${to} on ${date(c.renews)}, nothing charged today`,
          effects: [update(sub, "plan", from, to, `from ${date(c.renews)}`)],
          undoWindow: Math.floor((c.renews - now) / 1000),
          // Scheduled, not applied: until renewal the customer is still on (and billed for) the old plan.
          apply: () => ((c.nextPlan = to), { plan: to, from: date(c.renews) }),
          revert: () => { c.nextPlan = null; },
        };
        return [immediate, later];
      }),
    })
    .intent("billing.cancel", {
      summary: "Cancel a subscription",
      params: { who: "string" },
      risk: "low",
      plan: ({ params }) => pick(params.who, (c) => {
        if (c.status === "canceled") return fail("conflict", `${c.name} is already canceled`);
        const sub = `subscription/${c.id}`;
        return [
          {
            summary: `Cancel ${c.name} on ${date(c.renews)}; access until then`,
            effects: [update(sub, "cancels", null, date(c.renews)), send(c.email, "cancellation confirmation")],
            // Reversible until the period ends: the customer can simply stay.
            undoWindow: Math.floor((c.renews - now) / 1000),
            apply: () => ((c.cancelAt = c.renews), { cancels: date(c.renews) }),
            revert: () => { c.cancelAt = null; },
          },
          {
            summary: `Cancel ${c.name} now; access ends immediately, no refund`,
            effects: [update(sub, "status", c.status, "canceled"), send(c.email, "cancellation confirmation")],
            risk: "medium",
            apply: () => ((c.status = "canceled"), { status: "canceled" }),
          },
        ];
      }),
    });
}
