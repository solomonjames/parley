<!-- DRAFT ONLY. Not built into the site (srcExclude: drafts/**). Not submitted: James decides. -->

# Draft: add Parley to hermes-agent `optional-mcps/`

## Before submitting

- Confirm the stdio `transport` keys against Hermes's catalog validator (the Asana entry shows the `http` shape; no stdio entry was found in the first 80 manifests checked). Adjust `manifest.yaml` to match.
- Wait for the npm release of `parley-protocol`, and ideally the hosted demo URL, so reviewers can try it without cloning.
- Read their catalog admission policy (no self-updaters; declared capabilities must match) and CONTRIBUTING.

## `optional-mcps/parley/manifest.yaml`

```yaml
# Nous-approved MCP catalog entry.
manifest_version: 1

name: parley
connector_slug: parley
description: >-
  Act on the user's behalf with previews, consent and undo. Parley services answer
  intents with proposals whose effects, cost, risk and undo window are shown before
  anything happens; the user's signed policy decides what can commit without asking.
source: https://github.com/solomonjames/parley

transport:
  type: stdio          # confirm key names against the validator
  command: npx
  args: ["-y", "parley-protocol", "mcp"]
```

## PR title

`optional-mcps: add parley (previews, signed consent and undo for agent actions)`

## PR body

**What it is.** [Parley](https://github.com/solomonjames/parley) is an open protocol (Apache-2.0) for agents acting on behalf of people. Its MCP bridge exposes Parley services to any MCP client as four tools: `parley_ask`, `parley_intent`, `parley_commit`, `parley_undo`.

**Why it fits Hermes.**
- **Previews before side effects.** `parley_intent` returns proposals listing every effect, the cost, the risk and the undo window. Nothing changes until `parley_commit`.
- **Human approval that means something.** When an action exceeds the user's signed policy (per-action cap, total spend, risk ceiling), the service returns `consent_required`. The bridge asks the human through MCP elicitation, which Hermes routes through its approval surface. The approval is a signature bound to that exact proposal and nothing else.
- **Undo.** Reversible commits return a receipt with an undo window.
- **Token budgets.** Replies fit the requested budget and leave `EXPAND` handles, and results come back as compact text (Lens), not raw JSON.
- **Any REST API.** `parley openapi <spec>` wraps an existing API so writes become proposals.

**Security.** No credentials in the manifest. The bridge uses the user's local agent key and grants from `~/.parley`, and it never signs approvals on the model's behalf. The project has had an adversarial security audit, with all findings fixed; see its security model.

**Testing.** `npx parley-protocol setup`, `parley examples`, then in Hermes: "move my 1:1 with Ana to Thursday", and "order four vegan meals" (which triggers an approval).

**Maintainer.** @solomonjames
