<img alt="parley" src="https://raw.githubusercontent.com/solomonjames/parley/main/docs/brand/logo-light.svg" height="48">

# parley-protocol (Python)

**[Parley](https://github.com/solomonjames/parley) is the open protocol for AI agents acting on
behalf of people.** Agents state an intent, services reply with proposals whose effects are
listed up front, the human's signed policy decides what can go ahead without asking, and
reversible commits come with an undo window.

This is the Python implementation of the [spec](https://github.com/solomonjames/parley/blob/main/SPEC.md).
It's checked against the shared [conformance vectors](https://github.com/solomonjames/parley/tree/main/conformance)
and tested for interop, in both directions, against the TypeScript reference. Python ≥ 3.10; its only
dependency is `cryptography`.

```sh
pip install parley-protocol  # imports as `parley`
cd python && uv run pytest   # from a checkout: conformance + TS interop (node ≥ 22.18)
```

## Quickstart

```python
from parley import Plan, Service, send, serve_tcp, update

svc = Service("cal.example", "Calendar", "Move meetings.", trust=["ed25519:…principal…"])

@svc.intent("calendar.move", "Move a meeting", {"event": "string", "to": "datetime"}, risk="low")
def move(ctx):
    e, to = ctx.params["event"], ctx.params["to"]
    return Plan(f"Move {e} to {to}", [update(f"event/{e}", "start", "…", to), send("ana@x.co", "invite")],
                apply=lambda c: {"moved": e}, revert=lambda c: None, undo_window=3600)

# await serve_tcp(svc, port=7447)   (or serve_http(svc, port=8080) for POST /parley)
```

```python
from parley import connect, consent_grant, generate_key, issue_grant

principal, agent = generate_key(), generate_key()   # normally: the human's key, and the agent's
g = issue_grant(principal, agent.public, [{"svc": ["cal.example"]}, {"per": {"max": 5000, "currency": "USD"}}])
async with await connect("parley://127.0.0.1:7447", key=agent, grants=[g]) as c:
    props = await c.intent("calendar.move", {"event": "e2", "to": "2026-09-24T15:00:00Z"})
    print(props.lens)                          # what the model reads
    r = await c.commit(props.proposals[0])     # signs the proof automatically
    if r.code == "consent_required":           # ask the human (consent_code(r.consent) for out-of-band), then:
        r = await c.commit(props.proposals[0], grants=[consent_grant(principal, agent.public, r.consent)])
    await c.undo(r.receipt["id"])
    # auto=True: commit in one round trip when the grant already allows it and it's undoable
    r = await c.intent("calendar.move", {"event": "e3", "to": "2026-09-25T10:00:00Z"}, auto=True)
```

`consent_grant` signs with the principal's key. Run it in the human's own tool, never
somewhere the agent can trigger it (SPEC §6.6).

API names mirror `ts/src` in snake_case (`issue_grant`, `verify_grant`, `consent_grant`,
`lean`, `lens`, `fit`, `Plan.expires_in`/`undo_window`). `examples/serve.py` runs the shared
example calendar on `parley://127.0.0.1:7457` and `http://127.0.0.1:8457/parley`.

The CLI (`parley`), the MCP bridge for Claude Code, and the OpenAPI adapter ship with the
TypeScript package: `npx parley-protocol --help`. See the
[main README](https://github.com/solomonjames/parley#readme) and the
[docs](https://solomonjames.github.io/parley/).
