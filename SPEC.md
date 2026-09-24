# Parley Protocol — Specification v1

**Status:** Draft 1 · **Version on the wire:** `"parley": 1`

The key words MUST, MUST NOT, SHOULD, SHOULD NOT and MAY are to be read as in RFC 2119.

---

## 0. Why this exists (non-normative)

HTTP moves *documents* between *browsers* and servers. Its verbs are about resources:
GET, PUT, POST, DELETE. REST APIs and MCP servers inherited that shape, so an agent
that wants an outcome has to break it into many CRUD calls. It reads bulky JSON it
pays for per token, guesses which calls are safe, and holds credentials that can do
anything the human can.

Parley is an application-layer protocol for the case where the client is a
**model acting for a person**. It is a peer of HTTP rather than a layer on it: it has
its own framing, verbs, reply kinds, error model and authorization model. Its design
goals:

| Goal | Mechanism |
|---|---|
| Outcomes, not CRUD | `INTENT` carries a goal; the service answers with **proposals** |
| Agents make mistakes | Nothing changes until `COMMIT`; proposals declare **effects, cost, risk, undo window** |
| Undo is not an afterthought | Receipts carry an undo window; `UNDO` is a verb |
| Context is expensive | Every request carries a **token budget**; replies fit it and leave `EXPAND` handles |
| Models read text, code reads JSON | Every message has a canonical compact rendering: **Lens** |
| Errors should teach | Errors carry machine-appliable **fixes**; ambiguity is a first-class reply (`CLARIFY`) |
| Agents act for someone | **Grants**: signed, attenuable, offline-verifiable delegation chains with spend caps, expiry, scopes and risk ceilings |
| Humans approve, not operate | **Consent** is a one-shot grant bound to a proposal hash |

---

## 1. Roles and terms

- **Principal**: the party on whose behalf actions happen (usually a human), identified by an Ed25519 public key.
- **Agent**: the client. It holds its own Ed25519 key and one or more grants.
- **Service**: the server. It exposes **capabilities**.
- **Capability**: a named operation, `kind` = `ask` (read-only, never changes anything) or `intent` (may produce proposals that change the world).
- **Proposal**: a concrete, inspectable plan the service offers in response to an intent. It is inert until committed.
- **Receipt**: proof that a proposal was executed, including what changed and how long it can be undone.
- **Grant**: a signed delegation chain that authorizes an agent to act for a principal within caveats.

---

## 2. Framing

### 2.1 Frames

A **frame** is a single JSON object (RFC 8259), UTF-8 encoded.

Every frame MUST contain `"parley": 1` and an `"id"` string that is unique among the
sender's frames on that connection.

- A **request** frame has a `"verb"`.
- A **reply** frame has a `"kind"` and a `"re"` naming the request `id` it answers.

Receivers MUST ignore unknown fields. A receiver that gets an unknown `verb` MUST reply
with `ERROR` `bad_frame`. A frame MUST NOT exceed 1 MiB when serialized.

### 2.2 Replies

Each request receives **exactly one final reply**. It MAY receive any number of
`EVENT` replies before that. `EVENT` is the only non-final reply kind.

Requests on a connection are multiplexed: replies MAY arrive in any order and are
correlated by `re`.

### 2.3 Transports

Parley runs over any reliable, ordered byte stream. Frames are newline-delimited
(NDJSON): each frame is serialized without literal newlines and terminated by `\n`.

| URL form | Transport |
|---|---|
| `parley://host[:port]` | TCP. The default port is **7447**. |
| `parleys://host[:port]` | TLS over TCP. The default port is **7448**. |
| `stdio:` | stdin/stdout of a child process (local services) |
| `http://…`, `https://…` | HTTP bridge (§2.4) |

### 2.4 HTTP bridge

The bridge lets Parley services run on serverless platforms and pass through existing
infrastructure. It is a *transport*: Parley semantics are unchanged.

- `POST <endpoint>` with body = one request frame (`Content-Type: application/json`).
  The response is `200` with `Content-Type: application/x-ndjson`, containing zero or
  more `EVENT` frames followed by exactly one final reply frame. Parley errors are still
  returned with HTTP status `200`, because status codes belong to HTTP, not Parley.
- `GET <endpoint>` or `GET /.well-known/parley` MUST return the `BRIEF` reply to a
  default `HELLO`, as a single JSON object. This is how services are discovered.

---

## 3. Common request fields

| Field | Type | Meaning |
|---|---|---|
| `budget` | int | The maximum size, in estimated tokens (§8), that the agent wants for this reply's Lens rendering. The service SHOULD fit the reply within it (§8). Default `2000`. |
| `grants` | string[] | Grant tokens (§6). Required for `COMMIT` and `UNDO`; a service MAY require them for `ASK`/`INTENT`. |
| `proof` | object | Proof of possession (§6.5). Required whenever `grants` is present. |

---

## 4. Verbs

### 4.1 `HELLO` — discover what the service can do

```json
{"parley":1,"id":"1","verb":"HELLO","agent":{"name":"claude","key":"ed25519:…"},"budget":800}
```

Reply: `BRIEF`

```json
{"parley":1,"id":"s1","re":"1","kind":"BRIEF",
 "service":{"id":"cal.example.com","name":"Example Calendar","summary":"Your calendar. Find time, book, move and cancel meetings."},
 "capabilities":[
   {"name":"calendar.find","kind":"ask","summary":"Search events","params":{"query?":"string","day?":"date"}},
   {"name":"calendar.reschedule","kind":"intent","summary":"Move a meeting","params":{"event":"string — id or title","to":"datetime"},"risk":"low"}
 ]}
```

`service.id` is the service's **audience identifier** and MUST be stable. Proofs are bound to it (§6.5).

Capabilities MAY omit `params` when the budget is small. The service then adds a `more`
handle (§8) from which the full list can be expanded.

#### 4.1.1 Compact parameter schema

`params` is an object that maps parameter names to **type strings**. A name ending in `?`
is optional. A type string is:

```
type     := base [ "[]" ] [ " — " description ]
base     := "string" | "int" | "number" | "bool" | "date" | "datetime" | "any" | enum
enum     := literal ( "|" literal )+          e.g.  "low|medium|high"
```

A nested object is written as a nested params object. An array of objects is written as a one-element JSON array holding the element schema, e.g. `"items": [{"sku": "string", "qty": "int"}]`; Lens renders it as `[{sku: string, qty: int}]`. This is a deliberately lossy,
token-lean alternative to JSON Schema: it is written for models to read, not for
validators.

### 4.2 `ASK` — read without side effects

```json
{"parley":1,"id":"2","verb":"ASK","capability":"calendar.find","params":{"day":"2026-09-24"},"budget":600}
```

Reply: `ANSWER` `{ "data": any, "more"?: More[] }`

`ASK` MUST NOT change state that is observable to the principal. Agents MAY retry `ASK` freely.

### 4.3 `INTENT` — say what you want, get proposals back

```json
{"parley":1,"id":"3","verb":"INTENT","capability":"calendar.reschedule",
 "goal":"push my 1:1 with Ana to later this week",
 "params":{"event":"1:1 with Ana","to":"2026-09-24T15:00:00Z"},"budget":900}
```

`goal` is an OPTIONAL natural-language statement of the purpose, for services that reason
about intent. `params` carries the structured request. The reply is one of:

- `PROPOSALS` `{ "proposals": Proposal[], "more"?: More[] }`: one or more ways to achieve the intent. **Nothing has changed yet.**
- `CLARIFY` `{ "question": string, "options": [{ "label": string, "params": object }] }`: the intent is ambiguous. Each option carries a params **merge patch** (RFC 7396) that resolves it. To pick option *k*, re-send the `INTENT` with its `params` merged in.
- `ERROR`

`INTENT` MUST NOT change principal-observable state, except as described in §4.3.1. It MAY place internal holds.

#### 4.3.1 Policy-gated auto-commit

An `INTENT` MAY carry `"auto": true`. The service then MUST commit the **first**
proposal in the same round trip if, and only if, both of these hold:

1. one of the request's grants authorizes a `COMMIT` of that proposal outright (§6.3), with no consent needed; and
2. the proposal is undoable (`undo` is not `null`).

The reply is then a `RECEIPT` with `"auto": true` on the reply frame. In every other
case the service replies exactly as it would without `auto`.

The principal's grant, not the agent, decides what may skip the preview. Low-risk,
reversible actions inside the policy take one round trip. Anything costlier, riskier or
irreversible still stops for review.

For an auto `INTENT`, the proof target is `auto:{capability}:{frame id}` (§6.5). A service
MUST remember `(proof.key, frame id)` for auto requests for at least 600 seconds and
answer a repeat with the original reply (`"replay": true` on receipts), never committing twice.

### 4.4 `COMMIT` — make it happen

```json
{"parley":1,"id":"4","verb":"COMMIT","proposal":"p_7Hc2","hash":"Qm9…",
 "grants":["pg1.…"],"proof":{"key":"ed25519:…","ts":1790000000,"sig":"…"}}
```

`hash` MUST equal the proposal's `hash` (§5.1). A service MUST reject a mismatch with
`conflict`, which guarantees that the agent commits exactly what it (and possibly a
human) saw.

Reply: `RECEIPT`, optionally preceded by `EVENT`s.

**Idempotency:** `COMMIT` of an already-committed proposal MUST return the original
receipt with `"replay": true` and MUST NOT execute again.

### 4.5 `UNDO` — reverse a receipt within its window

```json
{"parley":1,"id":"5","verb":"UNDO","receipt":"r_91","grants":["pg1.…"],"proof":{…}}
```

Reply: `RECEIPT` describing the reversal (`"undoes": "r_91"`), or `ERROR` `expired` if
the window has closed. `UNDO` MUST be authorized by a grant rooted in the same principal
as the original commit. Undoing an already-undone receipt returns the original reversal
receipt with `"replay": true`.

### 4.6 `EXPAND` — get the rest

```json
{"parley":1,"id":"6","verb":"EXPAND","handle":"h_3kd","budget":1500}
```

Reply: `ANSWER` containing the next slice of the elided value, possibly with further
`more` handles. Handles SHOULD live at least 10 minutes.

---

## 5. Reply kinds

| kind | Final | Body |
|---|---|---|
| `BRIEF` | yes | `service`, `capabilities`, `more?` |
| `ANSWER` | yes | `data`, `more?` |
| `PROPOSALS` | yes | `proposals`, `more?` |
| `CLARIFY` | yes | `question`, `options` |
| `RECEIPT` | yes | `receipt` |
| `ERROR` | yes | §7 |
| `EVENT` | **no** | `message`, `progress?` (0–1), `data?` |

Any reply MAY include `lens`: a string with the service's own Lens rendering. When it is
absent, clients render Lens locally (§9).

### 5.1 Proposal

```json
{
  "id": "p_7Hc2",
  "capability": "calendar.reschedule",
  "summary": "Move \"1:1 with Ana\" to Thu 15:00",
  "effects": [
    {"op":"update","target":"event/e42","field":"start","from":"2026-09-22T14:00:00Z","to":"2026-09-24T15:00:00Z"},
    {"op":"send","target":"ana@example.com","detail":"update notification"}
  ],
  "cost": null,
  "risk": "low",
  "undo": {"window": 3600},
  "expires": 1790000600,
  "hash": "…"
}
```

- `effects`: every principal-observable change the commit will cause. `op` is one of
  `create`, `update`, `delete`, `send`, `charge`, `other`. `field`, `from`, `to` and
  `detail` are optional; `from` and `to` MUST be scalars.
- `cost`: `null` or `{"amount": int, "currency": "USD"}`. `amount` is in **minor units** (cents).
- `risk`: `low` | `medium` | `high`, as assessed by the service.
- `undo`: `null` if irreversible, else `{"window": seconds}` counted from commit.
- `expires`: unix seconds after which the proposal cannot be committed. Services SHOULD use whole minutes (the reference implementation rounds up: `ceil(t/60)*60`).
- `hash`: `b64url(sha256(canonical(proposal without "hash" and "data")))` (§10). The hash binds everything a human is shown: summary, effects, cost, risk, undo and expiry. Numbers inside hashed fields MUST be integers.
- `data`: OPTIONAL extra structured detail. It is not covered by the hash and MUST NOT describe effects.

A service MUST NOT perform effects beyond those declared in the committed proposal.

### 5.2 Receipt

```json
{"id":"r_91","proposal":"p_7Hc2","capability":"calendar.reschedule","summary":"…",
 "at":1790000100,"effects":[…],"cost":null,"undo":{"until":1790003700},"result":{…}}
```

`undo` is `null` when the action cannot be undone. An undo receipt has `"undoes"` set and `"undo": null`.

---

## 6. Grants — delegation for agents

A grant answers: **who** is this agent acting for, and **what exactly** may it do?

### 6.1 Keys and encoding

- Public key: `"ed25519:" + b64url(raw 32-byte key)`
- Signature: `b64url(64-byte Ed25519 signature)`
- `b64url` is base64url **without padding** (RFC 4648 §5).

### 6.2 Structure

A grant is a non-empty list of **blocks**. Each block is `{"p": payload, "s": signature}`,
where `s` signs `utf8(canonical(p))`.

- **Root block** payload: `{"iss": principalKey, "sub": holderKey, "caveats": Caveat[], "iat": int, "nonce": string}`, signed by `iss`.
- **Delegation block** *i* > 0 payload: `{"prev": b64url(sha256(utf8(block[i-1].s))), "sub": holderKey, "caveats": Caveat[], "iat": int}`, signed by the private key of `block[i-1].p.sub`.

The **holder** of the grant is the `sub` of its last block. Anyone who holds a grant can
append a block to delegate a *narrower* grant to another key (a sub-agent). Caveats
accumulate, so a delegation can only restrict.

Token encoding: `"pg1." + b64url(utf8(canonical(blocks)))`.

**Block id:** `b64url(sha256(utf8(block.s)))`. The **grant id** is the id of its root block.

### 6.3 Caveats

Each caveat is a single-key object. A request is authorized by a grant only if **every
caveat in every block** is satisfied. **Unknown caveats, and caveats whose value is
malformed, MUST fail closed** as a hard (`forbidden`) failure. Well-formed values are:
`svc`, `verbs` and `can` take arrays of strings; `exp` and `nbf` take integers;
`per` and `spend` take `{max: int, currency: string}`; `risk` takes one of `low`,
`medium` or `high`; `only` takes a string. For example, `{"svc": "a.example"}` (a string,
not a list) and `{"risk": "extreme"}` both fail.

| Caveat | Satisfied when |
|---|---|
| `{"svc": [serviceId…]}` | the service's id is listed |
| `{"verbs": [verb…]}` | the request verb is listed |
| `{"can": [pattern…]}` | the capability matches a pattern. A pattern is an exact name, or a prefix followed by `*` (`"calendar.*"`). `"*"` matches all. |
| `{"exp": int}` | now < exp |
| `{"nbf": int}` | now ≥ nbf |
| `{"per": {"max": int, "currency": s}}` | `COMMIT` only: the proposal cost is null, or has the same currency and `amount ≤ max` |
| `{"spend": {"max": int, "currency": s}}` | `COMMIT` only: cumulative committed spend attributed to *this block's id* plus this proposal's cost ≤ max (currency must match) |
| `{"risk": level}` | `COMMIT` only: the proposal risk ≤ level (`low` < `medium` < `high`) |
| `{"only": proposalHash}` | `COMMIT` only: the proposal hash equals it |

`per`, `spend`, `risk` and `only` are ignored (satisfied) for verbs other than `COMMIT`.
For `UNDO`, `can` is checked against the capability of the receipt being undone.

When a commit succeeds, the service MUST add its cost to the spend total of every block
in the authorizing grant that carries a `spend` caveat. Totals are not reduced on
`UNDO` in v1 (conservative).

### 6.4 Verification

A service verifies a grant by:

1. Decoding the token and checking the prefix `pg1.`.
2. Verifying each block's signature against the right key: `iss` for the root, and the previous block's `sub` for every block after it.
3. Checking each `prev` against the previous block.
4. Checking that the root `iss` is a principal the service trusts (how principals are linked to accounts is out of scope).
5. Checking that the grant holder equals `proof.key`.
6. Evaluating all caveats.

### 6.5 Proof of possession

A leaked grant alone is useless. Requests with grants carry
`proof: {"key": holderKey, "ts": unixSeconds, "sig": sig}`, where `sig` signs
`utf8(canonical({"aud": serviceId, "verb": verb, "target": target, "ts": ts}))` and:

| verb | target |
|---|---|
| `COMMIT` | the proposal hash |
| `UNDO` | the receipt id |
| `ASK`, `INTENT` | the capability name |
| `INTENT` with `auto` | `auto:{capability}:{frame id}` |
| `EXPAND` | the handle |

Services MUST reject proofs with `|now − ts| > 300`.

### 6.6 Multiple grants and consent

A request MAY present several grants. It is authorized if **any single** presented
grant authorizes it on its own.

If a `COMMIT` would be authorized except for a `risk`, `per` or `spend` caveat, the
service MUST reply `ERROR` `consent_required` with:

```json
"consent": {"proposal":"p_7Hc2","hash":"…","principal":"ed25519:…","summary":"…","expires":1790000600}
```

The agent shows this to the principal, for example in a CLI prompt, a push
notification or a page. If the principal approves, they sign a **consent grant**:
a root grant with `iss` = principal, `sub` = agent key and caveats
`[{"only": hash}, {"exp": proposal.expires}]`. The agent then re-sends `COMMIT` with it.
The approval is cryptographic, one-shot and bound to the exact effects shown.

---

## 7. Errors

```json
{"parley":1,"id":"s9","re":"3","kind":"ERROR","code":"invalid_params",
 "message":"`to` must be in the future (got 2025-09-24T15:00:00Z)",
 "fix":[{"say":"use next year","params":{"to":"2026-09-24T15:00:00Z"}}],
 "retry": null}
```

| Field | Meaning |
|---|---|
| `code` | one of the codes below |
| `message` | a single sentence explaining the problem |
| `fix` | OPTIONAL list of `{ "say": string, "params"?: mergePatch }`. Applying `params` to the failed request's params is expected to succeed. |
| `need` | OPTIONAL, for `forbidden`: the caveat(s) a grant would need |
| `consent` | for `consent_required` (§6.6) |
| `retry` | OPTIONAL seconds after which a retry may succeed |

Codes: `bad_frame`, `unknown_capability`, `invalid_params`, `unauthorized` (missing or
invalid grant or proof), `forbidden` (a valid grant that doesn't cover the request),
`consent_required`, `not_found`, `expired` (proposal, handle or undo window), `conflict`
(the world changed or the hash mismatched; re-run `INTENT`), `limit`, `unavailable`,
`internal`.

---

## 8. Budgets and `EXPAND`

**Token estimate:** `est(text)` is the number of non-overlapping, leftmost matches of

```
[A-Za-z]+|[0-9]{1,3}|\n {2,}|[^ \t\n\r\f\vA-Za-z0-9]
```

over the text's Unicode code points. That counts letter runs, digit groups of up to
three, indentation runs and each other visible character. Both sides compute exactly
this number. It is not any model's tokenizer, but it averages ≈1.0× the token count of
modern BPE tokenizers on Lens text (measured with o200k), which a byte ratio does not.

A service SHOULD make `est(lens(reply)) ≤ budget`. When a value doesn't fit, the service
elides part of it and adds a `More` entry:

```json
{"handle":"h_3kd","path":"data.events","remaining":37,"est":1840}
```

- `path`: dotted path of the elided array or string within the reply body
- `remaining`: the number of elided array items, or characters for strings
- `est`: estimated tokens to fetch the remainder

**What may be elided.** Services MUST NOT alter any part of a proposal other than
`data`, or any part of a capability entry. They may only drop whole trailing items of
`PROPOSALS.proposals` and `BRIEF.capabilities` ("list roots"). Anything inside
`ANSWER.data`, a proposal's `data` and `RECEIPT.receipt.result` may be elided ("deep roots").

**Reference fitting algorithm** (informative): while the reply is over budget, pick the
largest candidate by serialized size among the deep roots: any non-empty array (halve it,
keeping the first items) or any string over 200 characters (keep
`max(200, floor(len/2))` characters and append `…`). Only when no deep candidate remains,
halve the largest list root. Stop when the reply fits or nothing can be elided.

`EXPAND` of a handle for an array returns `{"data": {"items": [...]}}`. For a string it
returns `{"data": {"text": "..."}}`. Both may carry a further `more`.

---

## 9. Lens — the model's view

Models read text. Lens is a **canonical, deterministic, compact text rendering** of
Parley replies and of arbitrary JSON values. Clients SHOULD show models the Lens
rather than raw JSON. Two conforming implementations MUST produce byte-identical Lens
for the same input (see `conformance/lens.json`).

### 9.1 Lean notation (values)

Rendering a value `v` at indent `n` (two spaces per level):

**Scalars**
- `null` → `-`
- `true` / `false` → `true` / `false`
- numbers → ECMAScript `Number::toString` (so `1.5`, `1e+21`, `1e-7`)
- strings → **bare** if they match `^[A-Za-z0-9_@./+\-:() '!?&%$#*=<>~^]+$`, do not start or end with a space, are not `-`, `true`, `false`, or `null`, and do not match the JSON number grammar. Otherwise they are quoted as in §10.
- object keys are rendered with the same string rule.

**Objects** (keys in insertion order), one line per key:
- scalar value → `key: scalar`
- empty object → `key: {}`; empty array → `key: []`
- non-empty object → `key:` then its entries at indent n+1
- array → per the array rules below

**Arrays**, under a key `k`:
- all scalars → `k: [a, b, c]`
- **table form**: every element is a non-empty object with the **same keys in the same order** and only scalar values → `k[N]{k1,k2,…}:` followed by one row per element at indent n+1: the values rendered as scalars and joined with `,`. (Strings containing `,` are never bare, so rows are unambiguous.)
- otherwise → `k[N]:` followed by each element at indent n+1 as `- ` plus the element: scalars inline; empty objects as `{}`; non-empty objects with their first entry on the dash line and later entries aligned under it (indent n+2); arrays as `[a, b]` in scalar-list form if all scalars, else compact JSON (no whitespace, insertion order).

A top-level object renders its entries at indent 0. A top-level array renders as if under the key `items`. A top-level scalar renders as a scalar.

### 9.2 Reply renderings

- Times (fields `expires`, `at`, `until`) render as UTC `YYYY-MM-DDTHH:MMZ`, with `:SS` inserted when seconds ≠ 0.
- Durations render in the largest of `d`/`h`/`m`/`s` that divides them exactly.
- Compact JSON (used in `fix`, `need` and non-scalar list items) is exactly ECMAScript
  `JSON.stringify(v)`: insertion order, no whitespace, numbers per `Number::toString`.
- Money renders as `amount/100` with two decimals (negative amounts get a leading `-`) and the currency (`12.50 USD`). Zero-decimal currencies (JPY, KRW, VND, CLP, ISK, UGX, XAF, XOF) render without decimals.

**Effect line:** `SYM op target[.field][: from → to][ — detail]`, where SYM is `+` create, `~` update, `-` delete, `>` send, `$` charge, `*` other. `from → to` appears when either is present. A missing side renders as `-`.

**BRIEF**
```
# {name} ({id})
{summary}
{kind} {name}({p1}: {type1}, {p2?}: {type2}) — {summary}[ [risk:{risk}]]
```
Services SHOULD provide summaries. A missing service summary omits its line, and a
missing capability summary omits ` — {summary}`.
One line per capability. The parameter list renders as `()` if `params` is absent.
Nested param objects render recursively as `{k: type, …}`.

**PROPOSALS**
```
{N} proposals[ — {shared attributes}]:
[{id}] {summary}
  {effect line}…
  {own attributes}
```
The attributes, in this fixed order, are `cost: {money|free}`, `risk: {risk}`,
`undo: {duration|never}` and `expires: {time}`, joined with ` · `. When N ≥ 2, every
attribute whose rendered value is identical across all proposals is **shared**. Shared
attributes appear once on the header after ` — `, and the rest appear on each proposal's
attribute line. The attribute line is omitted when it would be empty. When N = 1 the
header is `1 proposal:` and all attributes are the proposal's own. When nothing is
shared, the header is `{N} proposals:`.
If a proposal has `data`, it renders after the cost line under `  data:` in lean notation at indent 2.

**CLARIFY**
```
? {question}
  1. {label}
  2. {label}
```

**RECEIPT**
```
✓ {summary} (receipt {id})[ (replay)] · {undo until {time} | irreversible}
  {effect line}…            (only when the reply has "auto": true)
  result: …                 (lean, as a `result` entry at indent 1, when present)
```
Effects are shown only for auto-commits, because otherwise the model has already read
them in the proposal. For an undo receipt, the first line is
`↶ undid {undoes}: {summary} (receipt {id})[ (replay)]`, followed by the result, if any.

**ANSWER:** the lean rendering of `data`.

**ERROR**
```
✗ {code}: {message}
  fix: {say}[ → params {compact JSON of params}]
  need: {compact JSON of need}
  consent: principal must approve {hash} ({summary})
  retry in: {duration}
```
(Only the lines whose fields are present.)

**EVENT:** `… {message}[ ({floor(progress×100 + 0.5)}%)]`

**More (appended to any reply that has `more`):** `… {remaining} more at {path} — EXPAND {handle} (~{est} tokens)`

---

## 10. Canonical JSON

`canonical(v)` is used for hashing and signing:

- Objects: keys sorted by Unicode code point (keys SHOULD be ASCII), no whitespace.
- Arrays: in order, no whitespace.
- Strings: JSON-escaped with `\"`, `\\`, `\b`, `\f`, `\n`, `\r`, `\t`, and `\u00XX` (lowercase hex) for other control characters below U+0020. All other characters are literal UTF-8.
- Numbers: only integers in [−2^53+1, 2^53−1] are allowed in signed or hashed payloads, written in minimal decimal form.
- `true`, `false`, `null`.

---

## 11. Security considerations (non-normative summary)

- Grants are bearer-proof: without the holder key, a stolen token cannot be used (§6.5).
- Attenuation is monotonic: a delegation can only add caveats.
- Unknown caveats fail closed, so older services never over-authorize newer grants.
- Proposal hashes bind consent to exact effects; a service cannot swap in different effects after approval.
- `ASK` and `INTENT` are side-effect free, so agents can explore freely and safely.
- Replay protection: proofs are time-bound and `COMMIT` is idempotent.
- v1 does not define revocation. Keep grant lifetimes short (`exp`). Revocation lists are planned for v2.
