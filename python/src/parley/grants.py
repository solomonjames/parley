"""Grants: attenuable Ed25519 delegation chains (SPEC §6.2–6.4)."""

from __future__ import annotations

import os
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

from ._json import CanonicalError, b64url_decode, b64url_encode, canonical_bytes, compact, loads, sha256_b64url
from .keys import KeyPair, parse_public_key, verify

TOKEN_PREFIX = "pg1."
RISK_ORDER = {"low": 0, "medium": 1, "high": 2}
# Caveats that, when they are the only ones failing a COMMIT, mean "ask the human" (§6.6).
CONSENT_CAVEATS = frozenset({"risk", "per", "spend"})
COMMIT_ONLY = frozenset({"per", "spend", "risk", "only"})

Trusted = Iterable[str] | Callable[[str], bool]


def block_id(block: Mapping[str, Any]) -> str:
    """``b64url(sha256(utf8(block.s)))``."""
    return sha256_b64url(block["s"].encode("utf-8"))


@dataclass(frozen=True)
class Grant:
    blocks: tuple[dict, ...]

    @property
    def id(self) -> str:
        return block_id(self.blocks[0])

    @property
    def block_ids(self) -> list[str]:
        return [block_id(b) for b in self.blocks]

    @property
    def principal(self) -> str:
        return self.blocks[0]["p"]["iss"]

    @property
    def holder(self) -> str:
        return self.blocks[-1]["p"]["sub"]

    def encode(self) -> str:
        return TOKEN_PREFIX + b64url_encode(canonical_bytes(list(self.blocks)))

    def delegate(self, holder: KeyPair, sub: str, caveats: list[dict], iat: int | None = None) -> Grant:
        """Append a block handing a narrower grant to ``sub``. ``holder`` must be the current holder."""
        if holder.public != self.holder:
            raise ValueError("only the grant's holder can delegate it")
        payload = {
            "prev": block_id(self.blocks[-1]),
            "sub": sub,
            "caveats": list(caveats),
            "iat": int(time.time()) if iat is None else iat,
        }
        return Grant(self.blocks + ({"p": payload, "s": holder.sign(canonical_bytes(payload))},))

    def __str__(self) -> str:
        return self.encode()


def issue_grant(
    issuer: KeyPair, sub: str, caveats: list[dict], iat: int | None = None, nonce: str | None = None
) -> Grant:
    """Issue a root grant from principal ``issuer`` to holder key ``sub``."""
    payload = {
        "iss": issuer.public,
        "sub": sub,
        "caveats": list(caveats),
        "iat": int(time.time()) if iat is None else iat,
        "nonce": b64url_encode(os.urandom(12)) if nonce is None else nonce,
    }
    return Grant(({"p": payload, "s": issuer.sign(canonical_bytes(payload))},))


def delegate_grant(grant: Grant | str, holder: KeyPair, sub: str, caveats: list[dict], iat: int | None = None) -> Grant:
    g = decode_grant(grant) if isinstance(grant, str) else grant
    return g.delegate(holder, sub, caveats, iat)


def consent_grant(principal: KeyPair, agent_key: str, consent: Mapping[str, Any]) -> Grant:
    """The one-shot grant a principal signs to approve a ``consent_required`` proposal (§6.6)."""
    return issue_grant(principal, agent_key, [{"only": consent["hash"]}, {"exp": consent["expires"]}])


def _is_int(v: Any) -> bool:
    return type(v) is int


def decode_grant(token: str) -> Grant:
    """Decode and structurally validate a token. Does not check signatures. Raises ValueError."""
    if not isinstance(token, str) or not token.startswith(TOKEN_PREFIX):
        raise ValueError("grant tokens start with pg1.")
    try:
        blocks = loads(b64url_decode(token[len(TOKEN_PREFIX):]).decode("utf-8"))
    except (ValueError, UnicodeDecodeError) as e:
        raise ValueError(f"grant token is not valid b64url JSON: {e}") from None
    if not isinstance(blocks, list) or not blocks:
        raise ValueError("a grant is a non-empty list of blocks")
    for i, b in enumerate(blocks):
        if not isinstance(b, dict) or not isinstance(b.get("p"), dict) or not isinstance(b.get("s"), str):
            raise ValueError(f"block {i} must be {{p, s}}")
        p = b["p"]
        need = ("iss", "sub", "nonce") if i == 0 else ("prev", "sub")
        if not all(isinstance(p.get(k), str) for k in need):
            raise ValueError(f"block {i} payload is missing {', '.join(need)}")
        if not isinstance(p.get("caveats"), list) or not _is_int(p.get("iat")):
            raise ValueError(f"block {i} payload needs caveats[] and an integer iat")
    return Grant(tuple(blocks))


@dataclass
class GrantContext:
    """What a request asks for, evaluated against caveats."""

    service: str
    verb: str
    capability: str | None
    now: int
    proposal: Mapping[str, Any] | None = None  # {hash, cost, risk}; COMMIT only
    spent: Mapping[str, int] = field(default_factory=dict)  # block id -> committed spend

    @classmethod
    def from_dict(cls, d: Mapping[str, Any]) -> GrantContext:
        return cls(d["service"], d["verb"], d.get("capability"), d["now"], d.get("proposal"), d.get("spent") or {})


@dataclass
class Verification:
    ok: bool
    code: str | None = None  # unauthorized | forbidden | consent_required
    message: str = ""
    grant: Grant | None = None
    failed: list[dict] = field(default_factory=list)  # caveats that were not satisfied

    @property
    def need(self) -> list[dict] | None:
        """For ``forbidden``: the caveats a grant would need to drop (SPEC §7 ``need``)."""
        return self.failed if self.code == "forbidden" else None

    @property
    def principal(self) -> str | None:
        return self.grant.principal if self.grant else None

    def spend_blocks(self) -> list[tuple[str, dict]]:
        """(block id, spend caveat) for every block carrying a ``spend`` caveat."""
        out = []
        if self.grant:
            for b in self.grant.blocks:
                for c in b["p"]["caveats"]:
                    if isinstance(c, dict) and "spend" in c:
                        out.append((block_id(b), c["spend"]))
        return out


def _matches(pattern: Any, name: str) -> bool:
    if not isinstance(pattern, str):
        return False
    if pattern.endswith("*"):
        return name.startswith(pattern[:-1])
    return pattern == name


def _money_ok(limit: Any, cost: Any, already: int = 0) -> bool:
    if not isinstance(limit, dict) or not _is_int(limit.get("max")) or not isinstance(limit.get("currency"), str):
        return False
    if cost is None:
        return True
    if not isinstance(cost, dict) or not _is_int(cost.get("amount")) or cost.get("currency") != limit["currency"]:
        return False
    return already + cost["amount"] <= limit["max"]


def _safe_int(v: Any) -> bool:
    return _is_int(v) and abs(v) <= 2**53 - 1


def _str_list(v: Any) -> bool:
    return isinstance(v, list) and all(isinstance(x, str) for x in v)


def _limit(v: Any) -> bool:
    return isinstance(v, dict) and _safe_int(v.get("max")) and isinstance(v.get("currency"), str)


_WELL_FORMED = {
    "svc": _str_list, "verbs": _str_list, "can": _str_list,
    "exp": _safe_int, "nbf": _safe_int,
    "per": _limit, "spend": _limit,
    "risk": lambda v: isinstance(v, str) and v in RISK_ORDER,
    "only": lambda v: isinstance(v, str),
}


def well_formed(caveat: Any) -> bool:
    """A known caveat name with a value of the right shape (SPEC §6.3)."""
    if not isinstance(caveat, dict) or len(caveat) != 1:
        return False
    (name, arg), = caveat.items()
    check = _WELL_FORMED.get(name)
    return check is not None and check(arg)


def check_caveat(caveat: Any, bid: str, ctx: GrantContext) -> bool:
    """True iff one caveat is satisfied. Unknown or malformed caveats fail closed."""
    if not well_formed(caveat):
        return False
    (name, arg), = caveat.items()
    if name in COMMIT_ONLY and ctx.verb != "COMMIT":
        return True  # known, and ignored outside COMMIT (§6.3)
    if name == "svc":
        return isinstance(arg, list) and ctx.service in arg
    if name == "verbs":
        return isinstance(arg, list) and ctx.verb in arg
    if name == "can":
        return isinstance(arg, list) and ctx.capability is not None and any(_matches(p, ctx.capability) for p in arg)
    if name == "exp":
        return _is_int(arg) and ctx.now < arg
    if name == "nbf":
        return _is_int(arg) and ctx.now >= arg
    prop = ctx.proposal or {}
    if name == "per":
        return _money_ok(arg, prop.get("cost"))
    if name == "spend":
        return _money_ok(arg, prop.get("cost"), int(ctx.spent.get(bid, 0)))
    if name == "risk":
        return arg in RISK_ORDER and prop.get("risk") in RISK_ORDER and RISK_ORDER[prop["risk"]] <= RISK_ORDER[arg]
    if name == "only":
        return isinstance(arg, str) and prop.get("hash") == arg
    return False


def _trusts(trusted: Trusted, key: str) -> bool:
    return trusted(key) if callable(trusted) else key in set(trusted)


def verify_grant(
    token: str | Grant, trusted: Trusted, proof_key: str, ctx: GrantContext | Mapping[str, Any]
) -> Verification:
    """Verify one grant for one request (SPEC §6.4). Never raises."""
    if not isinstance(ctx, GrantContext):
        ctx = GrantContext.from_dict(ctx)
    try:
        g = token if isinstance(token, Grant) else decode_grant(token)
    except ValueError as e:
        return Verification(False, "unauthorized", str(e))

    for i, b in enumerate(g.blocks):
        p = b["p"]
        signer = p["iss"] if i == 0 else g.blocks[i - 1]["p"]["sub"]
        if i > 0 and p["prev"] != block_id(g.blocks[i - 1]):
            return Verification(False, "unauthorized", f"block {i} does not chain to block {i - 1}", g)
        try:
            parse_public_key(p["sub"])
            msg = canonical_bytes(p)
        except (ValueError, CanonicalError) as e:
            return Verification(False, "unauthorized", f"block {i} is malformed: {e}", g)
        if not verify(signer, msg, b["s"]):
            return Verification(False, "unauthorized", f"block {i} signature does not verify", g)

    if not _trusts(trusted, g.principal):
        return Verification(False, "unauthorized", "the grant's principal is not trusted by this service", g)
    if g.holder != proof_key:
        return Verification(False, "unauthorized", "the proof key is not the grant's holder", g)

    failed = [c for b in g.blocks for c in b["p"]["caveats"] if not check_caveat(c, block_id(b), ctx)]
    if not failed:
        return Verification(True, grant=g)
    hard = [c for c in failed if _caveat_name(c) not in CONSENT_CAVEATS or not well_formed(c)]
    if hard:
        shown = ", ".join(compact(c) for c in hard[:3])
        return Verification(False, "forbidden", f"the grant does not allow this request ({shown})", g, hard)
    shown = ", ".join(compact(c) for c in failed[:3])
    return Verification(False, "consent_required", f"the proposal exceeds the grant's limits ({shown})", g, failed)


def _caveat_name(c: Any) -> str | None:
    return next(iter(c)) if isinstance(c, dict) and len(c) == 1 else None
