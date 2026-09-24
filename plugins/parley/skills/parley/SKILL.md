---
name: parley
description: Use when acting for the user through Parley services (parley_ask, parley_intent, parley_commit, parley_undo tools): booking, ordering, scheduling, or changing anything in a connected service. Covers previews, the user's signed policy, consent and undo.
---

# Acting for the user through Parley

The Parley tools act for the user under a policy they signed (spend caps, risk ceiling, expiry).

1. **Read first.** Use `parley_ask` to look things up. It never changes anything, and results are budgeted. If a result ends with `EXPAND h_…`, pass that handle to `parley_ask` for more.
2. **Change things with `parley_intent`.** You get proposals, each listing its effects (`+ create`, `~ update`, `- delete`, `> send`, `$ charge`), cost, risk and undo window. Read them. If the reply is a `?` question, ask the user or pick the option that matches what they said.
3. **`auto: true`** is for routine, reversible requests the user clearly asked for. The policy decides whether it commits immediately (you get a `✓` receipt) or returns proposals.
4. **Commit with `parley_commit`**, and only what the user asked for.
5. **`consent_required`** means the action is outside the user's policy. Stop, explain what needs approval and why, and relay the approval instruction. **Never split, shrink or restructure a purchase to get under a limit.**
6. **Undo.** Receipts show `undo until …`. If the user changes their mind in time, call `parley_undo`. Effects marked irreversible (`undo: never`) can't be undone, so say so before committing them.

No services configured? Tell the user to run `npx parley-protocol install`, then `npx parley-protocol add <service-url>`.
