# Troubleshooting

Start with:

```sh
npx parley-protocol doctor
```

It checks your node version, keys, grants, services and AI-tool registration, and says what to run for each problem.

## My AI tool doesn't show the Parley tools

- Restart the tool after `parley install` or `parley add`. Most clients read MCP config only at startup.
- Run `parley doctor` and look for "registered with". If your tool isn't listed, run `parley install --target <tool>`, or add it by hand from [Integrations](/guide/integrations).
- In Claude Code, `claude mcp list` should show `parley`. The installer sets `alwaysLoad` so the tools aren't hidden behind deferred tool search.
- `npx` needs Node 20 or newer on the `PATH` your tool uses. GUI apps sometimes see a different `PATH` than your shell; use an absolute path to `npx` in the config if so.

## The tools are there, but there are no capabilities

The bridge serves the services in `parley services`. Add one with `parley add <url>`, or start the examples with `parley examples` and add `parley://127.0.0.1:7447` and `parley://127.0.0.1:7449`.

## `unauthorized`

- **"needs a grant from your principal"**: there's no grant for this agent key. Run `parley grant …` as the principal (`parley doctor` lists your grants).
- **"proof timestamp is outside the 300s window"**: your clock is off by more than five minutes. Fix the system time.
- **"grant is issued by a principal this service does not trust"**: the service doesn't trust your principal key. For `parley examples` and `parley openapi`, set `PARLEY_TRUST` to your principal's public key (`parley whoami`).
- **"proof key is not the grant holder"**: the grant was issued to a different key than the one signing. `parley doctor` flags grants "held by another key".

## `forbidden`

A valid grant doesn't cover this request, and `need` lists the caveats that blocked it, for example `[{"svc":["other.example"]}]`. Issue a grant that covers it, or use the right service.

`forbidden: only the agent that requested this proposal can commit it` means a proposal is being committed by a different agent key than the one that asked for it. Send the `INTENT` again from the committing agent.

## `consent_required`

That's working as intended: the action is outside the policy (per-action cap, total spend or risk ceiling). The human approves it with `parley approve <pc1.code>`, or in the client's own prompt when it supports MCP elicitation. The approval covers that one proposal only.

## `expired`

Proposals are committable for about 10 minutes, handles for at least 10, and undo only inside its window. Send the `INTENT` again for fresh proposals.

## The playground doesn't start

It needs Ed25519 in the browser's WebCrypto: current Chrome, Firefox or Safari.

## Still stuck?

Open an issue with the output of `parley doctor` (it contains public keys only): [github.com/solomonjames/parley/issues](https://github.com/solomonjames/parley/issues).
