# Grants and consent

A grant answers two questions: who is this agent acting for, and what exactly may it do?

## A grant is a signed chain

The **principal**, usually a person, holds an Ed25519 key and signs a root block naming the agent's key and a list of **caveats**. The agent can append a block that delegates a *narrower* grant to a sub-agent's key. Caveats only accumulate, so delegation can only restrict. Any service that trusts the principal's key verifies the whole chain offline ([SPEC §6](/reference/spec#6-grants--delegation-for-agents)).

```sh
parley grant --svc cal.example.com --svc shop.example --risk low --per 40USD --spend 100USD --exp 8h
parley delegate <token> --to <sub-agent key> --verbs ASK,INTENT
parley inspect <token>
```

## Caveats

| Caveat | Satisfied when |
|---|---|
| `svc` | the service's id is listed |
| `verbs` | the request's verb is listed |
| `can` | the capability matches a pattern, such as `calendar.*` |
| `exp` / `nbf` | now is before / at or after the time |
| `per` | a commit's cost is within a per-action limit |
| `spend` | cumulative committed spend through this grant stays within a limit |
| `risk` | a commit's risk is at or below a ceiling |
| `only` | the commit is for one specific proposal hash |

Unknown caveats, and caveats with malformed values, fail closed. An older service never over-authorizes a newer grant.

Pair `per` with `spend`. A per-action cap alone can be dodged by splitting a purchase; `spend` bounds the total, and services reserve it atomically before executing, so concurrent commits can't exceed it together. Totals are counted per service: a grant used at two services has two independent totals, so scope money grants with `svc`.

## Proof of possession

A leaked grant alone is useless. Every request that uses one also carries a proof, a signature by the holder's key over the service id, verb, target and a timestamp. Services reject proofs more than 300 seconds off.

## Consent: when the policy says ask

If a commit would be allowed except for a `per`, `spend` or `risk` caveat, the service replies `consent_required` instead of `forbidden`. That's the protocol's "ask the human".

The agent's tooling shows the human the proposal's real effects, cost, risk and undo window, after checking that the consent request matches the proposal the agent actually received and that its content hashes to the hash being approved. If the human approves, they sign a **consent grant** that authorizes exactly one thing:

```json
[{"svc": ["shop.example"]}, {"verbs": ["COMMIT"]}, {"can": ["shop.order"]}, {"only": "<proposal hash>"}, {"exp": 1790000600}]
```

COMMIT of that proposal hash, for that capability, at that service, until the proposal expires. Nothing else. In the [playground](/playground), try "Order over the limit" and approve it as the human.

::: warning Where the principal key lives is the whole game
If the agent can read the principal key, it can sign its own consent. Keep it on another OS user, machine or phone. See the [security model](/guide/security).
:::
