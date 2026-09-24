# Quickstart

Parley has two implementations that interoperate and pass the same conformance vectors: TypeScript (the reference, zero runtime dependencies) and Python.

::: warning Not on npm or PyPI yet
Until the first release, install from a checkout of [the repository](https://github.com/solomonjames/parley): `npm install && npm run build` for TypeScript, or `pip install ./python` for Python.
:::

```sh
npm install parley-protocol   # TypeScript/JavaScript: Node ≥ 20, Bun, Deno
pip install parley-protocol   # Python ≥ 3.10, imports as `parley`
```

## See it run

```sh
npx parley demo       # a narrated end-to-end run: two services, consent, undo, sub-agents
```

Or skip installing and open the [playground](/playground), which runs the same core in your browser.

## Build a service

A service declares **capabilities**. An `ask` reads; an `intent` returns **plans**, and each plan becomes a proposal the agent can inspect before anything happens.

```ts
import { service, update, send, clarify } from "parley-protocol";
import { listen } from "parley-protocol/node";

const cal = service({ id: "cal.example.com", name: "Calendar", summary: "Move meetings.", trust: [PRINCIPAL_KEY] })
  .ask("calendar.agenda", {
    summary: "Upcoming events",
    params: { "day?": "date" },
    run: ({ params }) => db.events(params.day),
  })
  .intent("calendar.reschedule", {
    summary: "Move a meeting",
    params: { event: "string — id or title", to: "datetime" },
    plan: ({ params }) => {
      const matches = db.find(params.event);
      if (matches.length > 1) return clarify("Which one?", matches.map((e) => ({ label: e.title, params: { event: e.id } })));
      const e = matches[0], before = e.start;
      return {
        summary: `Move "${e.title}" to ${params.to}`,
        effects: [update(`event/${e.id}`, "start", before, params.to), send(e.owner, "updated invite")],
        apply: () => db.move(e.id, params.to),   // runs only on COMMIT, at most once
        revert: () => db.move(e.id, before),     // present, so the proposal is undoable
        undoWindow: 86400,
      };
    },
  });

await listen(cal); // parley://127.0.0.1:7447, or serveHttp(cal) / fetchHandler(cal) for Workers, Bun and Deno
```

Params are validated against the compact schema, and typos get fixes like ``rename `dya` to `day` ``. Budgets, `EXPAND`, idempotent commits, replay protection, grant verification, spend accounting and consent are handled for you. More in [Build a service](/guide/build-a-service).

## Act as an agent

```ts
import { connect } from "parley-protocol/node";

const cal = await connect("parley://cal.example.com", { key: AGENT_SEED, grants: [GRANT] });
const r = await cal.intent("calendar.reschedule", { event: "Ana", to: "2026-09-24T15:00:00Z" }, { auto: true });
console.log(r.lens); // give this to your model
if (r.kind === "PROPOSALS") await cal.commit(r.proposals[0]);
```

With `auto: true`, the service commits straight away when the human's grant already allows it and the change can be undone. Otherwise you get proposals back. See [Intents and proposals](/guide/intents).

## Python

The same protocol API in snake_case, with decorators and a `Plan` dataclass instead of chaining:

```python
from parley import Plan, Service, send, serve_tcp, update

svc = Service("cal.example", "Calendar", "Move meetings.", trust=["ed25519:…principal…"])

@svc.intent("calendar.move", "Move a meeting", {"event": "string", "to": "datetime"}, risk="low")
def move(ctx):
    e, to = ctx.params["event"], ctx.params["to"]
    return Plan(f"Move {e} to {to}", [update(f"event/{e}", "start", "…", to), send("ana@x.co", "invite")],
                apply=lambda c: {"moved": e}, revert=lambda c: None, undo_window=3600)
```

The [Python page](/guide/python) has the client side too. The CLI and the MCP bridge are TypeScript-only.

## Delegate

```sh
parley init                                                   # a principal key and an agent key
parley grant --svc cal.example.com --svc shop.example \
             --risk low --per 40USD --spend 100USD --exp 8h   # the human's signed policy
parley inspect <token>                                        # read any grant chain
parley delegate <token> --to <sub-agent key> --verbs ASK,INTENT
parley approve <pc1.code>                                     # review and sign one consent
```

Before relying on grants, read the [security model](/guide/security): the principal key must live somewhere the agent can't reach.
