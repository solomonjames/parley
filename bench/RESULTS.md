# Parley vs REST-style MCP — token benchmark

Tokenizer: o200k_base (gpt-tokenizer). Claude's tokenizer differs; the ratios are what matter. Both sides serve the same data. Ids are seeded, so runs are reproducible.

**Total input** counts what you pay for: each model turn re-reads the tool definitions plus the conversation so far (calls and results), and there's one final turn to answer.

Tool definitions in context every turn: REST MCP **729** tokens (10 tools) vs Parley **640** (4 generic tools + service briefs).

| Task | Calls (REST → Parley) | Total input: REST minified JSON | REST pretty JSON | Parley | Saved vs minified | vs pretty |
|---|---|---|---|---|---|---|
| Reschedule a meeting (REST: search → free slots → update) | 3 → 1 | 3,679 | 3,834 | 1,454 | **60%** | 62% |
| Reschedule a meeting (REST: one outcome-level endpoint) | 1 → 1 | 1,545 | 1,566 | 1,454 | **6%** | 7% |
| Find vegan meals < 700 kcal and order four | 2 → 2 | 3,080 | 3,542 | 2,567 | **17%** | 28% |
| Read the full 60-item menu | 1 → 1 | 3,388 | 4,488 | 2,401 | **29%** | 47% |
| Skim the menu (first 30 items: REST limit=30, Parley budget=800) | 1 → 1 | 2,403 | 2,963 | 1,867 | **22%** | 37% |
| **All tasks** (CRUD reschedule row) | | 12,550 | 14,827 | 8,289 | **34%** | 44% |

Result tokens read, per task (minified REST → Parley): 316 → 129 · 62 → 129 · 462 → 308 · 1919 → 1095 · 932 → 558

## What the model actually reads

### Reschedule, REST CRUD (3 calls, pretty JSON)

```json
[
  {
    "id": "e2",
    "title": "1:1 with Ana",
    "start": "2026-09-25T14:00:00Z",
    "end": "2026-09-25T14:30:00Z",
    "attendees": [
      "ana.ruiz@acme.co"
    ]
  }
]

{
  "day": "2026-09-27",
  "slots": [
    "2026-09-27T09:30:00Z",
    "2026-09-27T10:00:00Z",
    "2026-09-27T10:30:00Z",
    "2026-09-27T11:00:00Z",
    "2026-09-27T11:30:00Z",
    "2026-09-27T12:00:00Z",
    "2026-09-27T12:30:00Z",
    "2026-09-27T15:00:00Z",
    "2026-09-27T15:30:00Z",
    "2026-09-27T16:00:00Z",
    "2026-09-27T16:30:00Z",
    "2026-09-27T17:00:00Z",
    "2026-09-27T17:30:00Z"
  ]
}

{
  "id": "e2",
  "title": "1:1 with Ana",
  "start": "2026-09-27T09:30:00Z",
  "end": "2026-09-27T10:00:00Z",
  "attendees": [
    "ana.ruiz@acme.co"
  ],
  "updated": true
}
```

### Reschedule, Parley (1 call, auto-commit)

```
✓ Move "1:1 with Ana" to 2026-09-27T09:30:00Z (receipt r_Fgb6EIWi) · undo until 2026-09-25T02:25:28Z
  ~ update event/e2.start: 2026-09-25T14:00:00Z → 2026-09-27T09:30:00Z
  > send ana.ruiz@acme.co — updated invite
  result:
    event: e2
    start: 2026-09-27T09:30:00Z
```

What the tokens don't show: the Parley agent acted only because the principal's grant allows low-risk, undoable changes, and it got back exactly what happened with a 24h undo window. In the auto-commit case the *service* chose the slot (the first free one), just like the REST outcome endpoint. An agent that wants to choose omits `auto` and gets three proposals instead.
