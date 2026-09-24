# Parley vs REST-style MCP — token benchmark

Tokenizer: o200k_base (gpt-tokenizer). Claude's tokenizer differs, but ratios are what matter here. Same data on both sides.

Tool definitions in context every turn: **REST MCP 644 tokens** (9 tools) vs **Parley 640 tokens** (4 generic tools + service briefs).

## REST results pretty-printed (`JSON.stringify(x, null, 2)`, the common MCP default)

| Task | Calls (REST → Parley) | Result tokens read (REST → Parley) | Total input tokens over the task (REST → Parley) | Saved |
|---|---|---|---|---|
| Reschedule a meeting into a free slot | 3 → 1 | 393 → 131 (67% less) | 3494 → 1456 | **58%** |
| Find vegan meals < 700 kcal and order four | 2 → 2 | 723 → 309 (57% less) | 3285 → 2567 | **22%** |
| Read the full 60-item menu | 1 → 1 | 3019 → 1095 (64% less) | 4318 → 2401 | **44%** |
| Skim the menu (800-token budget) | 1 → 1 | 3019 → 556 (82% less) | 4318 → 1862 | **57%** |
| **All tasks** | | | 15415 → 8286 | **46%** |

## REST results minified JSON (best case for REST)

| Task | Calls (REST → Parley) | Result tokens read (REST → Parley) | Total input tokens over the task (REST → Parley) | Saved |
|---|---|---|---|---|
| Reschedule a meeting into a free slot | 3 → 1 | 316 → 130 (59% less) | 3339 → 1455 | **56%** |
| Find vegan meals < 700 kcal and order four | 2 → 2 | 462 → 310 (33% less) | 2823 → 2568 | **9%** |
| Read the full 60-item menu | 1 → 1 | 1919 → 1095 (43% less) | 3218 → 2401 | **25%** |
| Skim the menu (800-token budget) | 1 → 1 | 1919 → 558 (71% less) | 3218 → 1864 | **42%** |
| **All tasks** | | | 12598 → 8288 | **34%** |

## What the model actually reads

### Reschedule, REST (3 calls)

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

### Reschedule, Parley (1 call)

```
✓ Move "1:1 with Ana" to 2026-09-27T09:30:00Z (receipt r_gKZsP90N) · undo until 2026-09-25T02:06:02Z
  ~ update event/e2.start: 2026-09-25T14:00:00Z → 2026-09-27T09:30:00Z
  > send ana.ruiz@acme.co — updated invite
  result:
    event: e2
    start: 2026-09-27T09:30:00Z
```

Tokens are only half the story. The REST agent moved the meeting blind: no preview of the invite that goes to Ana, no undo, and a key that can do anything. The Parley agent acted only because the principal's grant allows low-risk, undoable changes. It got back exactly what happened and a 24h undo window, and anything costlier or irreversible would have stopped for review.
