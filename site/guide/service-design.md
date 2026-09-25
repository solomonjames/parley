# From REST to Parley

You have a REST API. This page shows how to turn it into a Parley service agents can use well. It covers how each REST concept maps to Parley, then a step-by-step translation of a Stripe-style billing API, ending with the complete code.

**Why not just wrap it?** Pointing [the OpenAPI adapter](/guide/openapi) at your spec gets you Parley's safety in one command: signed policy, previews, consent and budgets. But it keeps REST's shape. The agent still chains endpoints together one turn at a time, and every turn re-reads the whole conversation. Most of what an agent spends goes on those turns, not on payload bytes ([live eval](/benchmark/live)). A native service moves the orchestration into the service: the agent states the outcome, and the service answers with concrete plans.

::: info About the examples
Stripe's API is one of the best-designed REST APIs there is, for its intended reader: a developer writing code in advance. An agent is a different reader. It decides at runtime, pays per token, and acts for someone who isn't watching. The code here is ours, not Stripe's:

- [`examples/stripe-billing.ts`](../../examples/stripe-billing.ts) sits in front of the real Stripe API (use a test-mode key). It's the [full example](#the-full-example) below.
- [`ts/src/examples/billing.ts`](../../ts/src/examples/billing.ts) is the same design with made-up data. It runs in the [playground](/playground) and in `parley examples`.
:::

## The mapping

| In your REST API | In Parley | What changes |
|---|---|---|
| A resource (`/customers`, `/charges`) | Nothing directly | Capabilities are organized by job, not by resource |
| A `GET`, or several you always call together | `ASK` | One ASK answers one whole question. It may make several REST calls |
| A `POST`, `PATCH` or `DELETE` | `INTENT`, then `COMMIT` | The intent returns plans. Nothing happens until commit |
| The REST write call | The plan's `apply()` | Runs only on `COMMIT`, at most once |
| The inverse call (re-enable, un-cancel) | The plan's `revert()` | Makes the plan undoable, for its `undoWindow` |
| Side effects in your docs ("sends a receipt") | The plan's `effects` | Listed in the proposal and covered by its hash |
| The amount a call moves | The plan's `cost` | Checked against the human's spend caps |
| A preview or dry-run endpoint | The proposal itself | Every write is previewed |
| Two endpoints for two ways of doing it | Two proposals from one intent | Each with its own cost, risk and undo |
| Ids in the path (`cus_NffrFeUfNV2Hib`) | Names, emails or ids in params | The service resolves them, or replies `CLARIFY` |
| Request body validation | The compact param schema | Near-miss keys get fixes automatically |
| `4xx` errors | Errors with `fix` patches | They say how to succeed |
| `Idempotency-Key` headers | Built in | `COMMIT` is idempotent by proposal hash |
| Pagination cursors | Built in | Budgets and `EXPAND` |
| API keys and scopes | Grants | Scoped to actions, risk and spend, signed by the human |
| Confirmation screens in your UI | Built in | `consent_required`, then the human signs the exact proposal |

## One job, side by side

A customer writes to support: *"Please refund the rest of this month, I'm cancelling."* The agent has the customer's name.

<div class="side-by-side">
<div>

**REST: four calls, and the agent does the math**

```http
GET  /v1/customers/search?query=name:"Chen"
GET  /v1/subscriptions?customer=cus_chen
     → period dates, to work out the unused part
GET  /v1/charges?customer=cus_chen&limit=5
     → find the latest payment
POST /v1/refunds
     charge=ch_2  amount=2287
     reason=requested_by_customer
```

Each response is a full object with dozens of fields and long ids. Nothing in the API says a refund is permanent, or that the customer gets an email. The agent's key can refund any amount to anyone.

</div>
<div>

**Parley: one call, and the service does the math**

```text
INTENT billing.refund {who: "Chen"}

2 proposals — risk: medium · undo: never
[p_tJnW1A-y] Refund 49.00 USD of ch_2 to Chen Wei (full)
  ~ update charge/ch_2.amount_refunded: 0.00 USD → 49.00 USD
  > send chen@wei.studio — refund receipt; back on the card in 5–10 days
  cost: 49.00 USD
[p_VPlXarXR] Refund 22.87 USD of ch_2 to Chen Wei (unused 14 days)
  ~ update charge/ch_2.amount_refunded: 0.00 USD → 22.87 USD
  > send chen@wei.studio — refund receipt; back on the card in 5–10 days
  cost: 22.87 USD
```

The agent commits the second proposal. A refund can't be undone, so Parley never auto-commits it. The human's grant decides whether the agent may commit it alone or has to ask.

</div>
</div>

## Translating an API in five steps

### Step 1: List the jobs, then map endpoints to them

Don't start from your endpoint list. Start from the sentences people say to an agent about your product, then find the endpoints each one needs. Here is the translation for the billing jobs of a Stripe-backed SaaS:

| What the user says | Stripe endpoints involved today | Parley capability |
|---|---|---|
| "What's going on with Chen's account?" | `GET /v1/customers/search`, `GET /v1/subscriptions`, `GET /v1/charges` | `ASK billing.customer {who}` |
| "Refund Chen's last payment" | the three reads above, `POST /v1/refunds` | `INTENT billing.refund {who}`, with full and unused-days proposals |
| "Refund $20 of it" | the same | `INTENT billing.refund {who, amount: 20}` |
| "Cancel Chen at the end of the month" | `GET /v1/subscriptions`, `POST /v1/subscriptions/:id` with `cancel_at_period_end=true` | `INTENT billing.cancel {who}`, first proposal (`undo: 13d`) |
| "Cancel Chen right now" | `GET /v1/subscriptions`, `DELETE /v1/subscriptions/:id` | `INTENT billing.cancel {who}`, second proposal (`undo: never`) |
| "Actually, keep Chen's subscription" | `POST /v1/subscriptions/:id` with `cancel_at_period_end=false` | `UNDO` the cancel receipt. No capability needed |
| "Move Chen to Pro" | `GET /v1/prices`, `POST /v1/invoices/create_preview`, `POST /v1/subscriptions/:id` | `INTENT billing.change_plan {who, plan}`, with "now, prorated" and "at renewal" proposals |
| "Move Chen to Pro at renewal" | `POST /v1/subscription_schedules`, then update its phases | the second proposal of the same intent |

The [full example](#the-full-example) implements the first six rows. The made-up-data version also has `billing.change_plan`.

Three things happen in this step:

- **Reads merge.** Three `GET`s that are always called together become one `ASK`.
- **Writes gain alternatives.** Two endpoints that do the same job in different ways (`DELETE` vs. `cancel_at_period_end`) become two proposals of one intent, labeled with their consequences.
- **Some endpoints disappear.** Reversing an action becomes `UNDO`. Endpoints agents shouldn't touch at all, like API key management or webhook configuration, are simply left out.

Aim for a handful of capabilities, not hundreds. The full example has three, and its `HELLO` brief is 136 tokens.

### Step 2: Turn reads into ASKs

An ASK's `run()` makes whatever REST calls it needs, then returns only what the agent needs to answer the question.

<div class="side-by-side">
<div>

**REST: three responses, abridged**

```json
{ "object": "search_result", "data": [{
    "id": "cus_chen",
    "object": "customer",
    "address": null, "balance": 0,
    "created": 1680893993,
    "email": "chen@wei.studio",
    "invoice_settings": { … },
    "name": "Chen Wei", …
}]}
{ "object": "list", "data": [{
    "id": "sub_chen",
    "items": { "data": [{
      "current_period_end": 1791504000,
      "price": { "id": "price_1Mo…", … }, …
}]}
{ "object": "list", "data": [{
    "id": "ch_2",
    "amount": 4900, "amount_refunded": 0,
    "billing_details": { … },
    "outcome": { … },
    "payment_method_details": { … }, …
```

</div>
<div>

**Parley: what the agent reads**

```text
id: cus_chen
name: Chen Wei
email: chen@wei.studio
plan: pro
renews: 2026-10-09
payments[2]{id,date,amount,refunded,status}:
  ch_2,2026-09-09,49.00 USD,0.00 USD,succeeded
  ch_1,2026-08-10,49.00 USD,0.00 USD,succeeded
```

</div>
</div>

Ids on this page come from the example's test data; real Stripe ids are longer, and the ASK passes them through unchanged.

The ASK behind it, abridged (the [full code](#the-full-example) is below):

```ts
.ask("billing.customer", {
  summary: "A customer's subscription and recent payments",
  params: { who: "string — name, email or cus_ id" },
  async run({ params }) {
    const c = await findOne(params.who);
    const [sub, chs] = await Promise.all([subscription(c), charges(c)]);
    return {
      id: c.id, name: c.name, email: c.email,
      plan: sub?.items.data[0].price.nickname ?? "none",
      renews: day(period(sub).end),
      payments: chs.map((ch) => ({
        id: ch.id, date: day(ch.created),
        amount: amt(ch.amount, ch.currency),
        refunded: amt(ch.amount_refunded, ch.currency),
        status: ch.status,
      })),
    };
  },
})
```

Rules for reads:

- **Accept references the way people make them.** Take a name, email or id in one param, and resolve it in the service.
- **Join what's always read together.** Customer, subscription and payments come back as one answer.
- **Project.** Return the fields an agent reasons about, formatted for reading: dates, not Unix timestamps; `49.00 USD`, not `4900`.
- **Keep rows flat and uniform,** so [Lens](/guide/lens) renders them as a table.
- **Don't paginate.** Return the list; the library fits it to the agent's [budget](/guide/budgets) and hands out an `EXPAND` handle for the rest.

### Step 3: Turn writes into INTENTs

Each write becomes an intent whose `plan()` returns one or more **plans**. Every part of a plan comes from something you already know about the REST call:

| Plan field | Where it comes from | For `POST /v1/refunds` |
|---|---|---|
| `summary` | One line a person would read | `Refund 22.87 USD of ch_2 to Chen Wei (unused 14 days)` |
| `effects` | Everything the call changes, including side effects your docs mention | `~ charge/ch_2.amount_refunded`, `> send chen@wei.studio` |
| `cost` | The money the call moves | `22.87 USD` |
| `risk` | The consequence in the world, not the HTTP method | `medium`: money leaves for good |
| `apply()` | The REST call itself | `POST /v1/refunds` with an idempotency key |
| `revert()` | The inverse REST call, if one exists | none, so `undo: never` |
| `undoWindow` | How long the inverse keeps working | none |

In code:

```ts
// cur = ch.currency
const refund = (amount: number, why: string): Plan => ({
  summary: `Refund ${amt(amount, cur)} of ${ch.id} to ${c.name} (${why})`,
  effects: [
    update(`charge/${ch.id}`, "amount_refunded",
      amt(ch.amount_refunded, cur), amt(ch.amount_refunded + amount, cur)),
    send(c.email, "refund receipt; back on the card in 5–10 days"),
  ],
  cost: money(amount, cur.toUpperCase()),
  apply: () =>
    stripe(
      "POST",
      "/refunds",
      {
        charge: ch.id,
        amount: String(amount),
        reason: "requested_by_customer",
      },
      idempotencyKey,
    ),
  // No revert: Stripe can't reverse a refund, so it's never auto-committed.
});
return [refund(left, "full"), refund(unused, `unused ${days} days`)];
```

Where an inverse call exists, `revert()` makes it, and the plan becomes undoable. Cancelling at the end of the period is reversed by setting `cancel_at_period_end` back to `false`:

```ts
{
  summary: `Cancel ${c.name} on ${day(end)}; access until then`,
  effects: [
    update(`subscription/${sub.id}`, "cancel_at_period_end", false, true),
  ],
  // "undo: 13d": rounded down, so it never outlives the period
  undoWindow: roundDown(end - now),
  apply: () => stripe("POST", path, { cancel_at_period_end: "true" }),
  revert: () => stripe("POST", path, { cancel_at_period_end: "false" }),
}
```

Rules for writes:

- **List every effect.** If `apply()` does something the proposal doesn't list, it breaks the contract the human signed ([SPEC §5.1](/reference/spec#51-proposal)).
- **Give a plan `revert()` only if it truly restores the old state.** Parley's auto-commit only ever applies to undoable plans, so an honest `undo: never` is what keeps a refund from going out unreviewed.
- **Offer the alternatives a person would.** With `auto: true`, the service commits the *first* proposal if the policy allows it, so put the most common, most reversible choice first.
- **Round undo windows down** to whole days or hours. Lens prints durations exactly, so `1209599s` reads worse than `13d`.

### Step 4: Map your errors

Validate params before any REST call, so what's left from upstream is mostly about state. Then translate status codes into errors that teach:

| Upstream | Parley error | The fix to include |
|---|---|---|
| Your own validation fails | `invalid_params` | The valid range, with a params patch: `refund the rest (49.00 USD) → {"amount":49}` |
| Several records match | `CLARIFY` for an intent, `invalid_params` for an ASK | One option or fix per candidate, each a params patch |
| `404` | `not_found` | The ASK that would find the right id |
| `400`/`409` after validation passed | `conflict` | What changed, such as "already refunded" |
| `429` | `limit` | `retry` in seconds |
| `5xx` | `unavailable` | `retry` in seconds |

### Step 5: Delete the plumbing

You don't write idempotency handling (beyond the upstream key in `apply()`), pagination, confirmation flows, or scope checks. The library handles `EXPAND`, replays, requester binding, grant verification, spend reservation, consent and undo windows. See [Build a service](/guide/build-a-service) for the API.

## The full example

Three capabilities in front of the real Stripe API, in about 260 lines. The tests run it against a fake of the Stripe endpoints it uses ([`ts/test/stripe-billing.test.ts`](../../ts/test/stripe-billing.test.ts)).

```sh
export STRIPE_SECRET_KEY=sk_test_…   # a test-mode key
export PARLEY_TRUST="$(parley whoami | awk '/principal/{print $2}')"
node examples/stripe-billing.ts
parley add parley://127.0.0.1:7453   # now your AI tool can use it
```

<<< ../../examples/stripe-billing.ts

## Checklist

- [ ] Each intent is a sentence a user would say, and there are a handful, not hundreds
- [ ] Names and emails are accepted wherever ids are; ambiguity returns `CLARIFY`
- [ ] Each ASK answers a whole question in one call, with flat rows and readable values
- [ ] `apply()` makes the REST call; `revert()` makes the inverse call, or doesn't exist
- [ ] Every proposal lists all its effects, including emails and charges, and its real cost
- [ ] Risk reflects consequences, not HTTP methods
- [ ] Alternatives are separate proposals, with the safest common choice first
- [ ] Undo windows are rounded down and never outlive what `revert()` can undo
- [ ] Every error carries a fix, with a params patch where possible
- [ ] No pagination, idempotency or confirmation flows of your own
