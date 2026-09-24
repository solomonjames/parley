import asyncio
import json
import sys
import urllib.request

from calendar_example import calendar
from conftest import ROOT

from parley import (
    Client, ParleyError, Plan, Service, charge, clarify, connect, consent_grant, est, issue_grant, key_from_seed, local, money, serve_http, serve_tcp,
)

PRINCIPAL = key_from_seed(bytes([1]) * 32)
AGENT = key_from_seed(bytes([2]) * 32)
OTHER = key_from_seed(bytes([3]) * 32)


def run(coro):
    return asyncio.run(coro)


def grant(*caveats, sub=AGENT, iss=PRINCIPAL):
    return issue_grant(iss, sub.public, list(caveats))


def shop():
    svc = Service("shop.example", "Shop", "Buy things.", trust=[PRINCIPAL.public])
    orders = []

    @svc.intent("shop.order", "Order an item", {"sku": "string", "qty": "int"}, risk="medium")
    def order(ctx):
        qty = ctx.params["qty"]
        if qty > 100:
            raise ParleyError("limit", "at most 100 per order", fix=[{"say": "order 100", "params": {"qty": 100}}])

        def apply(c):
            c.progress("charging card", 0.5)
            orders.append(qty)
            return {"order": len(orders)}

        return Plan(f"Order {qty}× {ctx.params['sku']}", [charge("card/default", f"{qty} items")], apply,
                    cost=money(1500 * qty), revert=lambda c: orders.pop(), undo_window=600)

    @svc.intent("shop.pick", "Ambiguous", {})
    def pick(ctx):
        return clarify("Which?", [{"label": "A", "params": {"x": 1}}])

    @svc.ask("shop.catalog", "Everything", {})
    def catalog(ctx):
        return {"items": [{"sku": f"m{i:03d}", "name": "widget " * 5, "price": 1500} for i in range(300)], "note": "x" * 5000}

    svc.orders = orders
    return svc


# ------------------------------------------------------------ service semantics


def test_bad_frames():
    svc = shop()
    for frame, code in [
        (None, "bad_frame"), ({"id": "1", "verb": "HELLO"}, "bad_frame"), ({"parley": 1, "id": "1", "verb": "GET"}, "bad_frame"),
        ({"parley": 1, "id": "1", "verb": "ASK", "capability": "shop.catalgo"}, "unknown_capability"),
        ({"parley": 1, "id": "1", "verb": "INTENT", "capability": "shop.order", "params": {"sku": 1}}, "invalid_params"),
        ({"parley": 1, "id": "1", "verb": "COMMIT", "proposal": "p_x", "hash": "h"}, "not_found"),
        ({"parley": 1, "id": "1", "verb": "EXPAND", "handle": "h_x"}, "expired"),
    ]:
        r = run(svc.handle(frame))
        assert r["kind"] == "ERROR" and r["code"] == code, r
    r = run(svc.handle({"parley": 1, "id": "1", "verb": "ASK", "capability": "shop.catalgo"}))
    assert r["fix"] == [{"say": "did you mean shop.catalog?"}]


def test_intent_validation_paths():
    svc = Service("s", "S", trust=[PRINCIPAL.public])
    svc.intent("x.order", "o", {"items?": [{"sku": "string", "qty": "int"}]})(lambda ctx: [])
    r = run(svc.handle({"parley": 1, "id": "1", "verb": "INTENT", "capability": "x.order", "params": {"items": [{"sku": "a", "qty": "2"}]}}))
    assert r["code"] == "invalid_params" and "`items.0.qty` must be an integer" in r["message"]


def test_commit_flow_replay_undo_and_events():
    async def go():
        svc = shop()
        c = Client(local(svc), key=AGENT, grants=[grant({"can": ["shop.*"]})])
        props = await c.intent("shop.order", {"sku": "m002", "qty": 2})
        assert props.kind == "PROPOSALS"
        p = props.proposals[0]
        assert p["undo"] == {"window": 600} and p["cost"] == {"amount": 3000, "currency": "USD"}
        events = []
        rc = await c.commit(p, on_event=events.append)
        assert rc.kind == "RECEIPT" and svc.orders == [2]
        assert [e.lens for e in events] == ["… charging card (50%)"]
        again = await c.commit(p)
        assert again.replay is True and again.receipt == rc.receipt and svc.orders == [2]
        assert "(replay)" in again.lens.splitlines()[0]
        un = await c.undo(rc.receipt["id"])
        assert un.receipt["undoes"] == rc.receipt["id"] and svc.orders == []
        assert un.receipt["effects"] == [{"op": "other", "target": "card/default", "detail": "refund"}]
        assert (await c.undo(rc.receipt["id"])).replay is True and svc.orders == []
        assert (await c.undo(un.receipt["id"])).code == "not_found"

    run(go())


def test_commit_needs_grant_and_matching_hash():
    async def go():
        svc = shop()
        anon = Client(local(svc))
        p = (await anon.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0]
        assert (await anon.commit(p)).code == "unauthorized"
        c = Client(local(svc), key=AGENT, grants=[grant()])
        assert (await c.commit({**p, "hash": "nope"})).code == "conflict"
        thief = Client(local(svc), key=OTHER, grants=[grant()])  # someone else's grant, own key
        assert (await thief.commit(p)).code == "unauthorized"
        assert (await c.commit(p)).kind == "RECEIPT"

    run(go())


def test_forbidden_carries_need():
    async def go():
        svc = shop()
        c = Client(local(svc), key=AGENT, grants=[grant({"can": ["calendar.*"]})])
        p = (await c.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0]
        r = await c.commit(p)
        assert r.code == "forbidden" and r.need == [{"can": ["calendar.*"]}]
        assert '  need: [{"can":["calendar.*"]}]' in r.lens

    run(go())


def test_consent_flow_and_spend_accounting():
    async def go():
        svc = shop()
        g = grant({"per": {"max": 5000, "currency": "USD"}}, {"spend": {"max": 6000, "currency": "USD"}})
        c = Client(local(svc), key=AGENT, grants=[g])
        big = (await c.intent("shop.order", {"sku": "m002", "qty": 4})).proposals[0]  # 6000 > per 5000
        r = await c.commit(big)
        assert r.code == "consent_required"
        assert r.consent["hash"] == big["hash"] and r.consent["principal"] == PRINCIPAL.public
        assert f"  consent: principal must approve {big['hash']}" in r.lens
        ok = await c.commit(big, grants=[consent_grant(PRINCIPAL, AGENT.public, r.consent)])
        assert ok.kind == "RECEIPT"
        # The consent grant authorized that commit, so the spend cap block was not charged:
        small = (await c.intent("shop.order", {"sku": "m002", "qty": 3})).proposals[0]  # 4500
        assert (await c.commit(small)).kind == "RECEIPT"
        # ...but now 4500 of 6000 is spent through g, so another 3000 needs consent.
        more = (await c.intent("shop.order", {"sku": "m002", "qty": 2})).proposals[0]
        assert (await c.commit(more)).code == "consent_required"
        # A consent grant for one proposal doesn't cover another.
        wrong = consent_grant(PRINCIPAL, AGENT.public, r.consent)
        assert (await c.commit(more, grants=[wrong])).code == "consent_required"

    run(go())


def test_undo_requires_same_principal():
    async def go():
        svc = shop()
        other_principal = key_from_seed(bytes([9]) * 32)
        svc.trust.append(other_principal.public)
        c = Client(local(svc), key=AGENT, grants=[grant()])
        rc = await c.commit((await c.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0])
        c2 = Client(local(svc), key=AGENT, grants=[grant(iss=other_principal)])
        assert (await c2.undo(rc.receipt["id"])).code == "forbidden"

    run(go())


def test_expired_proposal_and_proof_window():
    async def go():
        clock = [1_790_000_000]
        svc = Service("s", "S", trust=[PRINCIPAL.public], now=lambda: clock[0])
        svc.intent("x.do", "d")(lambda ctx: Plan("do", [], lambda c: None, expires_in=60))
        p = (await Client(local(svc)).intent("x.do")).proposals[0]
        assert p["expires"] == clock[0] + 60
        c = Client(local(svc), key=AGENT, grants=[grant()])
        r = await c.commit(p)  # proof ts is real time, far from the fake clock
        assert r.code == "unauthorized" and "300s" in r.message
        # Even where grants are optional, a presented grant with a bad proof is rejected (as in TS).
        assert (await c.intent("x.do")).code == "unauthorized"

    run(go())


def test_clarify_and_ask_grants_optional():
    async def go():
        svc = shop()
        c = Client(local(svc), key=AGENT, grants=[grant({"verbs": ["COMMIT"]})])
        r = await c.intent("shop.pick")
        assert r.kind == "CLARIFY" and r.lens == "? Which?\n  1. A"

    run(go())


def test_require_grants():
    svc = Service("s", "S", trust=[PRINCIPAL.public], require_grants=True)
    svc.ask("x.read", "r")(lambda ctx: ctx.principal)

    async def go():
        assert (await Client(local(svc)).ask("x.read")).code == "unauthorized"
        assert (await Client(local(svc), key=AGENT, grants=[grant()]).ask("x.read")).data == PRINCIPAL.public
        assert (await Client(local(svc), key=AGENT, grants=[grant({"verbs": ["COMMIT"]})]).ask("x.read")).code == "forbidden"

    run(go())


def test_client_skips_grants_for_other_services():
    async def go():
        svc = shop()
        c = Client(local(svc), key=AGENT, grants=[grant({"svc": ["calendar.example"]})])
        p = (await c.intent("shop.order", {"sku": "a", "qty": 1})).proposals[0]
        r = await c.commit(p)
        assert r.code == "unauthorized" and "needs a grant" in r.message

    run(go())


def test_budget_and_expand():
    async def go():
        svc = shop()
        c = Client(local(svc))
        r = await c.ask("shop.catalog", budget=300)
        assert est(r.lens) <= 300
        paths = {m["path"]: m for m in r.more}
        assert set(paths) == {"data.items", "data.note"}
        assert r.data["note"].endswith("…") and len(r.data["note"]) < 5000
        items = list(r.data["items"])
        handle = paths["data.items"]["handle"]
        while handle:
            x = await c.expand(handle, budget=2000)
            assert x.kind == "ANSWER"
            items += x.data["items"]
            handle = next((m["handle"] for m in x.get("more", []) if m["path"] == "data.items"), None)
        assert [i["sku"] for i in items] == [f"m{i:03d}" for i in range(300)]
        t = await c.expand(paths["data.note"]["handle"], budget=5000)
        assert r.data["note"][:-1] + t.data["text"] == "x" * 5000

    run(go())


def test_proposals_are_never_altered_by_budget():
    async def go():
        svc = Service("s", "S", trust=[PRINCIPAL.public])
        svc.intent("x.many", "m")(lambda ctx: [Plan("s" * 400, [charge("card", "d" * 300)], lambda c: None, data={"k": 1}) for _ in range(6)])
        r = await Client(local(svc)).intent("x.many", budget=500)
        assert est(r.lens) <= 500 and r.more[0]["path"] == "proposals"
        assert 0 < len(r.proposals) < 6
        for p in r.proposals:
            assert p["summary"] == "s" * 400 and p["effects"][0]["detail"] == "d" * 300

    run(go())


# ------------------------------------------------------------ transports


async def _tcp_and_http():
    svc = calendar([PRINCIPAL.public])
    tcp = await serve_tcp(svc, "127.0.0.1", 0)
    http = await serve_http(svc, "127.0.0.1", 0)
    return svc, tcp, http, tcp.sockets[0].getsockname()[1], http.sockets[0].getsockname()[1]


def _flow_against(url_of):
    async def go():
        svc, tcp, http, tport, hport = await _tcp_and_http()
        try:
            url = url_of(tport, hport)
            g = grant({"svc": ["calendar.example"]}, {"can": ["calendar.*"]})
            async with await connect(url, key=AGENT.seed, grants=[g]) as c:
                brief = await c.hello()
                assert brief.kind == "BRIEF" and c.service_id == "calendar.example"
                clar = await c.intent("calendar.reschedule", {"event": "Ana"})
                assert clar.kind == "CLARIFY"
                props = await c.intent("calendar.reschedule", {"event": "Ana", **clar.options[0]["params"]})
                events = []
                rc = await c.commit(props.proposals[0], on_event=events.append)
                assert rc.kind == "RECEIPT", rc.lens
                assert (await c.commit(props.proposals[0])).replay is True
                assert (await c.undo(rc.receipt["id"])).receipt["undoes"] == rc.receipt["id"]
                # Concurrency on one connection: replies are correlated by `re`.
                rs = await asyncio.gather(*(c.ask("calendar.free", {"day": "2030-01-0" + str(i)}) for i in range(1, 8)))
                assert [r.data["day"] for r in rs] == [f"2030-01-0{i}" for i in range(1, 8)]
        finally:
            tcp.close()
            http.close()

    run(go())


def test_tcp_flow():
    _flow_against(lambda t, h: f"parley://127.0.0.1:{t}")


def test_http_flow():
    _flow_against(lambda t, h: f"http://127.0.0.1:{h}/parley")


def test_http_discovery_and_raw_bad_frames():
    async def go():
        svc, tcp, http, tport, hport = await _tcp_and_http()
        try:
            def get(path):
                with urllib.request.urlopen(f"http://127.0.0.1:{hport}{path}") as r:
                    return r.headers["Content-Type"], json.loads(r.read())

            ctype, brief = await asyncio.to_thread(get, "/.well-known/parley")
            assert ctype == "application/json" and brief["kind"] == "BRIEF" and brief["endpoint"] == "/parley"
            reader, writer = await asyncio.open_connection("127.0.0.1", tport)
            writer.write(b"not json\n{\"parley\":1,\"id\":\"x\",\"verb\":\"NOPE\"}\n")
            await writer.drain()
            replies = [json.loads(await reader.readline()) for _ in range(2)]
            assert sorted(r["re"] for r in replies) == ["?", "x"]
            assert all(r["code"] == "bad_frame" for r in replies)
            writer.close()
        finally:
            tcp.close()
            http.close()

    run(go())


def test_stdio_flow():
    async def go():
        serve = ROOT / "examples" / "serve.py"
        c = await connect(f"stdio:{sys.executable} {serve} --stdio", key=AGENT)
        try:
            assert (await c.hello()).frame["service"]["id"] == "calendar.example"
            assert (await c.ask("calendar.agenda", {"query": "planning"})).data[0]["id"] == "e8"
        finally:
            await c.close()

    run(go())
