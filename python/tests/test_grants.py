import pytest

from parley import (
    GrantContext, consent_grant, decode_grant, issue_grant, key_from_seed, sign_proof, verify_grant, verify_proof,
)
from parley.keys import KeyPair

ALICE = key_from_seed(bytes(32))
AGENT = key_from_seed(bytes([1]) * 32)
SUB = key_from_seed(bytes([2]) * 32)
NOW = 1_790_000_000


def ctx(**kw):
    base = dict(service="svc", verb="COMMIT", capability="calendar.move", now=NOW,
                proposal={"hash": "H", "cost": {"amount": 500, "currency": "USD"}, "risk": "low"})
    base.update(kw)
    return GrantContext(**base)


def test_key_from_seed_known_vector():
    # RFC 8032 test 1: secret 9d61b19d..., public d75a9801...
    seed = bytes.fromhex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
    k = key_from_seed(seed)
    assert k.public == "ed25519:11qYAYKxCrfVS_7TyWQHOg7hcvPapiMlrwIaaPcHURo"
    assert "seed" not in repr(k) and seed.hex() not in repr(k)


def test_roundtrip_and_ids():
    g = issue_grant(ALICE, AGENT.public, [{"can": ["calendar.*"]}], iat=NOW, nonce="n")
    d = decode_grant(g.encode())
    assert d == g and d.id == g.block_ids[0] and d.holder == AGENT.public and d.principal == ALICE.public


def test_ok_and_attenuation():
    g = issue_grant(ALICE, AGENT.public, [{"can": ["calendar.*"]}], iat=NOW)
    assert verify_grant(g.encode(), [ALICE.public], AGENT.public, ctx()).ok
    d = g.delegate(AGENT, SUB.public, [{"verbs": ["ASK"]}], iat=NOW)
    # The sub-agent holds it now; the original holder no longer does.
    assert verify_grant(d, [ALICE.public], AGENT.public, ctx()).code == "unauthorized"
    r = verify_grant(d, [ALICE.public], SUB.public, ctx())
    assert r.code == "forbidden" and r.failed == [{"verbs": ["ASK"]}]
    assert verify_grant(d, [ALICE.public], SUB.public, ctx(verb="ASK", proposal=None)).ok


def test_only_holder_can_delegate():
    g = issue_grant(ALICE, AGENT.public, [])
    with pytest.raises(ValueError):
        g.delegate(SUB, SUB.public, [])


def test_tampering_and_trust():
    g = issue_grant(ALICE, AGENT.public, [{"exp": NOW + 10}], iat=NOW)
    bad = type(g)(({"p": {**g.blocks[0]["p"], "caveats": []}, "s": g.blocks[0]["s"]},))
    assert verify_grant(bad, [ALICE.public], AGENT.public, ctx()).code == "unauthorized"
    assert verify_grant(g, [SUB.public], AGENT.public, ctx()).code == "unauthorized"
    assert verify_grant("pg1.!!", [ALICE.public], AGENT.public, ctx()).code == "unauthorized"
    assert verify_grant("xx", [ALICE.public], AGENT.public, ctx()).code == "unauthorized"


@pytest.mark.parametrize(
    "caveat,kw,code",
    [
        ({"exp": NOW}, {}, "forbidden"),
        ({"exp": NOW + 1}, {}, None),
        ({"nbf": NOW}, {}, None),
        ({"nbf": NOW + 1}, {}, "forbidden"),
        ({"svc": ["other"]}, {}, "forbidden"),
        ({"can": ["*"]}, {}, None),
        ({"can": ["calendar.move"]}, {}, None),
        ({"can": ["calendar.mo"]}, {}, "forbidden"),
        ({"can": ["mail.*"]}, {}, "forbidden"),
        ({"per": {"max": 500, "currency": "USD"}}, {}, None),
        ({"per": {"max": 499, "currency": "USD"}}, {}, "consent_required"),
        ({"per": {"max": 5000, "currency": "EUR"}}, {}, "consent_required"),
        ({"risk": "low"}, {}, None),
        ({"risk": "low"}, {"proposal": {"hash": "H", "cost": None, "risk": "high"}}, "consent_required"),
        ({"risk": "extreme"}, {}, "forbidden"),  # malformed values fail closed, hard
        ({"svc": "svc"}, {}, "forbidden"),
        ({"exp": "tomorrow"}, {}, "forbidden"),
        ({"exp": True}, {}, "forbidden"),
        ({"only": 5}, {"verb": "ASK", "proposal": None}, "forbidden"),
        ({"only": "H"}, {}, None),
        ({"only": "X"}, {}, "forbidden"),
        ({"only": "X"}, {"verb": "ASK", "proposal": None}, None),
        ({"per": {"max": 1, "currency": "USD"}}, {"verb": "INTENT"}, None),
        ({"brand_new": 1}, {}, "forbidden"),
        ({"exp": NOW + 5, "nbf": 0}, {}, "forbidden"),
    ],
)
def test_caveats(caveat, kw, code):
    g = issue_grant(ALICE, AGENT.public, [caveat], iat=NOW)
    r = verify_grant(g, [ALICE.public], AGENT.public, ctx(**kw))
    assert r.code == code and r.ok == (code is None)


def test_spend_is_per_block():
    g = issue_grant(ALICE, AGENT.public, [{"spend": {"max": 1000, "currency": "USD"}}], iat=NOW)
    bid = g.block_ids[0]
    assert verify_grant(g, [ALICE.public], AGENT.public, ctx(spent={bid: 500})).ok
    assert verify_grant(g, [ALICE.public], AGENT.public, ctx(spent={bid: 501})).code == "consent_required"
    assert verify_grant(g, [ALICE.public], AGENT.public, ctx(spent={"other": 10_000})).ok


def test_mixed_consent_and_forbidden_is_forbidden():
    g = issue_grant(ALICE, AGENT.public, [{"risk": "low"}, {"svc": ["nope"]}], iat=NOW)
    r = verify_grant(g, [ALICE.public], AGENT.public, ctx(proposal={"hash": "H", "cost": None, "risk": "high"}))
    assert r.code == "forbidden"


def test_consent_grant():
    g = consent_grant(ALICE, AGENT.public, {"hash": "H", "expires": NOW + 60})
    assert verify_grant(g, [ALICE.public], AGENT.public, ctx()).ok
    assert verify_grant(g, [ALICE.public], AGENT.public, ctx(proposal={"hash": "Z", "cost": None, "risk": "low"})).code == "forbidden"


def test_proof():
    p = sign_proof(AGENT, "svc", "COMMIT", "H", NOW)
    assert p["key"] == AGENT.public
    assert verify_proof(p, "svc", "COMMIT", "H", NOW + 300) is None
    assert verify_proof(p, "svc", "COMMIT", "H", NOW + 301)
    assert verify_proof(p, "other", "COMMIT", "H", NOW)
    assert verify_proof(p, "svc", "COMMIT", "X", NOW)
    assert verify_proof({**p, "key": SUB.public}, "svc", "COMMIT", "H", NOW)
    assert verify_proof(None, "svc", "COMMIT", "H", NOW)


def test_generate_is_random():
    assert KeyPair.generate().public != KeyPair.generate().public
