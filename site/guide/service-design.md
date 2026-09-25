# Designing a good service

Pointing [the OpenAPI adapter](/guide/openapi) at an existing API gets you Parley's safety: signed policy, previews, consent and budgets. It doesn't change the shape of the API. The agent still has to chain endpoints together, one turn at a time, and every turn re-reads the whole conversation. Most of what an agent spends goes on those turns, not on payload bytes ([live eval](/benchmark/live)).

A service designed for Parley does that orchestration itself. The agent states the outcome, and the service answers with concrete plans. This page shows what that looks like, using a subscription-billing API shaped like Stripe's.

::: info Why Stripe
Stripe's API is one of the best-designed REST APIs there is, for its intended reader: a developer writing code in advance. The point here isn't that it's badly made. An agent is a different reader, one that decides at runtime, pays per token, and acts for someone who isn't watching. The Parley side is a runnable example with made-up data: [`ts/src/examples/billing.ts`](../../ts/src/examples/billing.ts), under 200 lines.
:::

## One job, side by side

A customer emails support: *"Please refund the rest of this month, I'm cancelling."* The agent has the customer's name.

<div class="side-by-side">
<div>

**REST: four calls, and the agent does the math**

```http
GET  /v1/customers/search?query=name:'Chen Wei'
GET  /v1/subscriptions?customer=cus_Nf3…
     → period dates, to work out the unused part
GET  /v1/charges?customer=cus_Nf3…&limit=3
     → find the latest payment
POST /v1/refunds
     charge=ch_3P…  amount=2287
     reason=requested_by_customer
```

Each response is a full object with dozens of fields and long ids. Nothing in the API says a refund is permanent, or that the customer gets an email. The agent's credential can refund any amount to anyone.

</div>
<div>

**Parley: one call, and the service does the math**

```text
INTENT billing.refund {who: "Chen"}

2 proposals — risk: medium · undo: never
[p_2kOHY6Sz] Refund 49.00 USD of pay_112 to
              Chen Wei (full)
  ~ update payment/pay_112.refunded:
      0.00 USD → 49.00 USD
  > send chen@wei.studio — refund receipt
  cost: 49.00 USD
[p_GrZxWvUD] Refund 22.87 USD of pay_112 to
              Chen Wei (unused 14 days)
  …
  cost: 22.87 USD
```

The agent picks the second proposal. The refund can't be undone, so the service never auto-commits it. The human's grant decides whether the agent can commit it alone or has to ask.

</div>
</div>

The same pattern holds across the API:

| The job | REST calls the agent makes | Parley |
|---|---|---|
| Look up a customer | search, then subscriptions, then charges | `ASK billing.customer {who}`, one joined answer |
| Refund the unused part of the month | 4, and the agent does the arithmetic | `INTENT billing.refund`, which offers full or unused |
| Upgrade now, with proration | 5: search, subscription, price lookup, `POST /v1/invoices/create_preview` to see the charge, then the update | `INTENT billing.change_plan`; the proposal's `cost` is the preview |
| Change plan at renewal instead | a different API: subscription schedules, 2 more calls | the second proposal of the same intent |
| Cancel | `DELETE /v1/subscriptions/:id` (immediate, permanent) or `POST … cancel_at_period_end=true` (reversible), and the agent must know which is which | `INTENT billing.cancel`: two proposals, labeled `undo: 3d` and `undo: never` |

The whole service is five capabilities, and its `HELLO` brief is about 200 tokens.

## The principles

### 1. Name capabilities after jobs, not resources

Start from the sentences a user says to an agent ("refund Chen", "move Dana to Pro", "cancel Ben at the end of the month"), not from your database tables. Each sentence becomes one intent. Reads work the same way: `billing.customer` answers "what's going on with this customer", which in REST takes three resources.

A good service has a handful of capabilities, not hundreds. If one intent needs a flag that changes what it does entirely, split it into two.

### 2. Accept references the way people make them

The user said "Chen", not `cus_Nf3ZkqX8a2`. Let the service resolve names, emails and ids, so the agent doesn't spend a lookup turn on it.

When a reference is ambiguous, don't guess. An intent replies `CLARIFY`, and each option carries a params patch the agent merges:

```text
? 2 customers match "Ana". Which one?
  1. Ana Ruiz <ana.ruiz@acme.co> · pro
  2. Ana Li <ana@northwind.io> · team
```

Match carefully. Our first version used substring matching, so "Ana" also matched "D**ana** Park". Match on the start of words.

### 3. Shape reads for the question

Return what the agent needs to answer the question in one pass: the customer's plan, card and recent payments together. Keep rows flat and uniform so [Lens](/guide/lens) can render them as tables, keep ids short, and leave out fields no agent will read.

```text
payments[3]{id,date,usd,status,refunded_usd}:
  pay_101,2026-07-18,49,paid,0
  pay_102,2026-08-17,49,paid,0
  pay_103,2026-09-16,49,paid,0
```

Don't build pagination. Return the whole list; the library fits it to the agent's [budget](/guide/budgets) and hands out an `EXPAND` handle for the rest.

### 4. Put the preview in the proposal

In REST, finding out what a write will do takes a separate API when one exists at all: Stripe offers `create_preview` for invoices, but most writes have no preview. In Parley, every write is previewed by definition. A proposal lists:

- **every effect**, including the ones people forget: the receipt email, the card charge, the account credit
- **the cost**, in minor units, which is what the human's spend caps are checked against
- **the risk and the undo window**

If you can't list an effect in the proposal, `apply()` must not do it ([SPEC §5.1](/reference/spec#51-proposal)).

### 5. Rate risk by consequence, and be honest about undo

HTTP methods say nothing about consequences. `POST /v1/refunds` sends money away for good; `POST /v1/customers` is harmless. Rate each plan by what happens in the world:

- A refund is `undo: never`, even for a dollar. Money that has left can't be pulled back, so the plan has no `revert`, and Parley never auto-commits it.
- Cancelling at the end of the period is low risk and undoable until then, because the customer can simply stay. Cancelling now is medium risk and final.

Give a plan a `revert` only if it really restores the previous state. The human's policy relies on it: auto-commit only ever applies to undoable plans.

### 6. Offer the alternatives a person would

CRUD gives one way to do each thing. A good employee would ask "full refund, or just the unused days?" and "now, or at renewal?" Return those as separate proposals, each with its own cost, risk and undo. In REST, the second option is often a different API entirely.

Order matters. With `auto: true`, the service commits the **first** proposal if the policy allows. Put the most common, most reversible choice first.

### 7. Make errors teach

Every error should tell the agent how to succeed next time, with a params patch it can apply without thinking:

```text
✗ invalid_params: refund must be between 0.01 and 49.00 USD
  fix: refund the rest (49.00 USD) → params {"usd":49}
```

A reference that matches nothing points to the read that would find it. A plan change to the current plan offers the other plans.

### 8. Leave the plumbing to the protocol

Delete these from your design; Parley already has them:

| REST concern | In Parley |
|---|---|
| `Idempotency-Key` headers | `COMMIT` is idempotent by proposal hash. A retry returns the original receipt |
| Pagination cursors | Budgets and `EXPAND` |
| API keys scoped to resources | Grants scoped to actions, risk and spend, signed by the human |
| "Are you sure?" flows in your own UI | `consent_required`, and the human signs the exact proposal |
| Webhooks for long operations | `EVENT` progress frames during `COMMIT` |

## From wrapper to native

You don't have to rewrite your API. A practical path:

1. **Wrap it.** `parley openapi <spec>` works today, with risk overrides and field projections in a [preset](/guide/openapi).
2. **Write intents for the top jobs.** A native service can sit in front of your existing REST API. In production, `billing.refund`'s `apply()` would call `POST /v1/refunds` with `Idempotency-Key` set to the proposal hash. The agent never sees the REST calls.
3. **Retire the wrapped endpoints** as native intents cover them.

## Checklist

- [ ] Each intent is a sentence a user would say, and the service has a handful, not hundreds
- [ ] Names and emails are accepted wherever ids are; ambiguity returns `CLARIFY`
- [ ] Each read answers a whole question in one call, with flat rows and short ids
- [ ] Every proposal lists all its effects, including emails and charges, and its real cost
- [ ] Risk reflects consequences, not HTTP methods; `revert` exists only when it truly restores state
- [ ] Alternatives are separate proposals, with the safest common choice first
- [ ] Every error carries a fix, with a params patch where possible
- [ ] No pagination, idempotency keys or confirmation flows of your own

Next: [Build a service](/guide/build-a-service) covers the API these examples use.
