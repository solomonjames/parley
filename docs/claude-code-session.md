# A real session: Claude Code × Parley

Unedited tool traffic from a headless Claude Code run (`claude-sonnet-5`), driving the example services through the Parley MCP bridge (`parley mcp`). The model got **no Parley documentation**. It had only the bridge's four tool descriptions and the service briefs.

**Setup:** `parley init`, then `parley grant --risk low --per 40USD --spend 100USD --exp 2h`, then `node examples/serve.ts`, then `claude -p "…" --mcp-config …`

**Prompt:** "Move my 1:1 with Ana to a free slot on 2026-09-27. Then order me 4 vegan meals under 700 calories for delivery on 2026-09-26 (2 each of two different meals). Report exactly what happened."

**→ `parley_ask`** `{"service":"calendar.example","capability":"calendar.agenda","params":{"query":"Ana"}}`

```
items[3]{id,title,start,end,with}:
  e2,1:1 with Ana,2026-09-25T14:00:00Z,2026-09-25T14:30:00Z,ana.ruiz@acme.co
  e3,Design review,2026-09-25T16:00:00Z,2026-09-25T17:00:00Z,ana.ruiz@acme.co lee@acme.co
  e5,Pipeline sync with Ana,2026-09-26T11:00:00Z,2026-09-26T11:30:00Z,ana.li@acme.co
```

**→ `parley_ask`** `{"service":"calendar.example","capability":"calendar.free","params":{"day":"2026-09-27"}}`

```
day: 2026-09-27
slots: [2026-09-27T09:30:00Z, 2026-09-27T10:00:00Z, 2026-09-27T10:30:00Z, 2026-09-27T11:00:00Z, 2026-09-27T11:30:00Z, 2026-09-27T12:00:00Z, 2026-09-27T12:30:00Z, 2026-09-27T15:00:00Z, 2026-09-27T15:30:00Z, 2026-09-27T16:00:00Z, 2026-09-27T16:30:00Z, 2026-09-27T17:00:00Z, 2026-09-27T17:30:00Z]
```

**→ `parley_ask`** `{"service":"shop.example","capability":"shop.search","params":{"tag":"vegan","max_cal":699}}`

```
items[11]{sku,name,usd,cal,protein}:
  m005,Falafel Plate,16.47,632,46
  m010,Lentil Curry,14.32,517,21
  m020,Black Bean Burrito,19.02,667,31
  m025,Falafel Plate (family),16.87,552,36
  m027,Tofu Pad Thai (family),19.61,658,20
  m030,Lentil Curry (family),14.72,437,41
  m040,Black Bean Burrito (family),19.42,587,21
  m045,Falafel Plate (light),17.27,472,26
  m047,Tofu Pad Thai (light),11.01,578,40
  m055,Chickpea Shawarma (light),12.97,622,36
  m060,Black Bean Burrito (light),19.82,507,41
```

**→ `parley_intent`** `{"service":"calendar.example","capability":"calendar.reschedule","params":{"event":"e2","day":"2026-09-27"}}`

```
3 proposals — cost: free · risk: low · undo: 1d · expires: 2026-09-24T02:22Z:
[p_B8YnaADk] Move "1:1 with Ana" to 2026-09-27T09:30:00Z
  ~ update event/e2.start: 2026-09-25T14:00:00Z → 2026-09-27T09:30:00Z
  > send ana.ruiz@acme.co — updated invite
[p_A1cAuOoK] Move "1:1 with Ana" to 2026-09-27T10:00:00Z
  ~ update event/e2.start: 2026-09-25T14:00:00Z → 2026-09-27T10:00:00Z
  > send ana.ruiz@acme.co — updated invite
[p_-k-XIjgi] Move "1:1 with Ana" to 2026-09-27T10:30:00Z
  ~ update event/e2.start: 2026-09-25T14:00:00Z → 2026-09-27T10:30:00Z
  > send ana.ruiz@acme.co — updated invite
```

**→ `parley_commit`** `{"service":"calendar.example","proposal":"p_B8YnaADk"}`

```
✓ Move "1:1 with Ana" to 2026-09-27T09:30:00Z (receipt r_OMx81dAk) · undo until 2026-09-25T02:11:46Z
  result:
    event: e2
    start: 2026-09-27T09:30:00Z
```

**→ `parley_intent`** `{"service":"shop.example","capability":"shop.order","params":{"items":[{"sku":"m047","qty":2},{"sku":"m055","qty":2}],"deliver":"2026-09-26"}}`

```
2 proposals — risk: low · undo: 2h · expires: 2026-09-24T02:22Z:
[p_71KbTFLA] 4 meals for 2026-09-26 — 53.95 USD
  + create order/o1001 — 2× Tofu Pad Thai (light), 2× Chickpea Shawarma (light)
  $ charge card ••4242 — 53.95 USD
  cost: 53.95 USD
  data:
    subtotal: 47.96
    delivery: 5.99
[p_JU6-iYhB] 4 meals for 2026-09-26 (express, by noon) — 62.94 USD
  + create order/o1002 — 2× Tofu Pad Thai (light), 2× Chickpea Shawarma (light)
  $ charge card ••4242 — 62.94 USD
  cost: 62.94 USD
  data:
    subtotal: 47.96
    delivery: 5.99
    express: 8.99
```

**→ `parley_commit`** `{"service":"shop.example","proposal":"p_71KbTFLA"}`

```
✗ consent_required: cost exceeds the per-commit limit of 40.00 USD; your principal must approve this exact proposal
  consent: principal must approve u-1LZPPEeEQe5oTm9EgbKym_LD3xIN_txj4svVpIkbg (4 meals for 2026-09-26 — 53.95 USD)
  → the user must approve. Ask them to run: parley approve u-1LZPPEeEQe5oTm9EgbKym_LD3xIN_txj4svVpIkbg --expires 1790216520  — then call parley_commit again.
```

## Claude's final answer

The 1:1 with Ana is moved, but the meal order is not placed. The shop blocked it pending your approval, so nothing has been charged.

**1:1 with Ana: done**
- I moved the event `e2` from 2026-09-25 14:00 UTC to 2026-09-27 09:30 UTC. That was the first free slot on the 27th. You didn't specify a time, so tell me if you'd rather have another slot.
- Ana (ana.ruiz@acme.co) was sent an updated invite.
- It was the only event titled "1:1 with Ana". I didn't touch "Design review" or "Pipeline sync with Ana" (a different Ana, ana.li@acme.co).
- Receipt `r_OMx81dAk` can undo the move until 2026-09-25 02:11 UTC.

**Meal order: blocked, waiting on you**
- I chose 2× Tofu Pad Thai (light) at 578 cal and 2× Chickpea Shawarma (light) at 622 cal. You didn't name meals, so I took the cheapest non-family vegan pair under 700 cal.
- The total is $53.95 on card ••4242 ($47.96 meals plus $5.99 delivery), for delivery on 2026-09-26.
- When I tried to commit it (proposal `p_71KbTFLA`), it failed with `consent_required`. The order exceeds the per-commit limit of $40.00, and you have to approve that exact proposal.
- I didn't try to get around the limit. Splitting it into two orders would have dodged the check. Even the cheapest four meals come to $53.95, so no single order fits under $40.

To go ahead, run this yourself:
```
parley approve u-1LZPPEeEQe5oTm9EgbKym_LD3xIN_txj4svVpIkbg --expires 1790216520
```
Then tell me and I'll commit it. The proposal expires 2026-09-24 02:22 UTC, so if that passes I'll re-create it. Once placed, the order can be cancelled for 2 hours.

---

9 turns · $0.186. Everything the model read from Parley is shown above.
