"""Token budgets (SPEC §8). Replies are fitted to the agent's budget by eliding the largest
arrays/strings; elided parts are parked behind EXPAND handles. Mirrors ts/src/budget.ts."""

from __future__ import annotations

import copy
import os
import time
from typing import Any, Protocol

from ._json import b64url_encode, compact
from .lens import est, lean, lens

MIN_STRING = 200
PLACEHOLDER = "h_XXXXXXXXXXXX"
Path = tuple


class HandleStore(Protocol):
    def put(self, handle: str, value: list | str) -> None: ...
    def get(self, handle: str) -> list | str | None: ...


class MemoryHandleStore:
    """Parked remainders, kept for ``ttl`` seconds (SPEC §4.6 asks for at least 10 minutes)."""

    def __init__(self, ttl: float = 30 * 60):
        self.ttl = ttl
        self._m: dict[str, tuple[list | str, float]] = {}

    def put(self, handle: str, value: list | str) -> None:
        self._m[handle] = (value, time.monotonic() + self.ttl)
        if len(self._m) > 10_000:
            now = time.monotonic()
            self._m = {k: v for k, v in self._m.items() if v[1] > now}

    def get(self, handle: str) -> list | str | None:
        e = self._m.get(handle)
        return e[0] if e and e[1] > time.monotonic() else None


def _get(root: Any, path: Path) -> Any:
    for k in path:
        try:
            root = root[k]
        except (KeyError, IndexError, TypeError):
            return None
    return root


def _set(root: Any, path: Path, value: Any) -> None:
    _get(root, path[:-1])[path[-1]] = value


def _collect(v: Any, path: Path, deep: bool, out: list) -> None:
    if isinstance(v, str):
        if len(v) > MIN_STRING:
            out.append((path, len(v)))
    elif isinstance(v, list):
        if v:
            out.append((path, len(compact(v))))
        if deep:
            for i, x in enumerate(v):
                _collect(x, path + (i,), deep, out)
    elif isinstance(v, dict) and deep:
        for k, x in v.items():
            _collect(x, path + (k,), deep, out)


def _roots(r: dict) -> list[tuple[Path, bool]]:
    """Where elision may happen, and whether it may go inside. Effects, summaries and
    hashes are never elided: the list of proposals may shrink, but a proposal never changes."""
    kind = r.get("kind")
    if kind == "ANSWER":
        return [(("data",), True)]
    if kind == "BRIEF":
        return [(("capabilities",), False)]
    if kind == "PROPOSALS":
        return [(("proposals",), False)] + [(("proposals", i, "data"), True) for i in range(len(r.get("proposals") or []))]
    if kind == "RECEIPT":
        return [(("receipt", "result"), True)]
    return []


def fit(reply: dict, budget: int, store: HandleStore) -> dict:
    """Fit ``reply`` within ``budget`` estimated tokens of Lens. Returns a new reply."""
    if est(lens(reply)) <= budget:
        return reply
    original = copy.deepcopy(reply)
    r = copy.deepcopy(reply)
    cut: dict[Path, int] = {}  # path -> kept length, in elision order
    base_more = list(r.get("more") or [])

    def more_for(real: bool) -> list[dict]:
        out = []
        for path, kept in cut.items():
            if _get(r, path) is None:
                continue  # an ancestor was elided; its remainder carries this
            rest = _get(original, path)[kept:]
            handle = "h_" + b64url_encode(os.urandom(9)) if real else PLACEHOLDER
            if real:
                store.put(handle, rest)
            out.append({
                "handle": handle, "path": ".".join(map(str, path)), "remaining": len(rest),
                "est": est(rest) if isinstance(rest, str) else est(lean(rest)),
            })
        return out

    for _ in range(200):
        more = base_more + more_for(False)
        view = {**r, "more": more} if more else r
        if est(lens(view)) <= budget:
            break
        cands: list = []
        for root, deep in _roots(r):
            v = _get(r, root)
            if v is not None:
                _collect(v, root, deep, cands)
        if not cands:
            break
        path = max(cands, key=lambda c: c[1])[0]  # first of the largest, like the TS reduce
        cur = _get(r, path)
        if isinstance(cur, str):
            already = path in cut
            body = cur[:-1] if already else cur  # strip our "…"
            kept = max(MIN_STRING, len(body) // 2)
            if kept >= len(body):
                break
            cut[path] = min(cut[path], kept) if already else kept
            _set(r, path, body[:kept] + "…")
        else:
            cut[path] = len(cur) // 2 if path not in cut else min(cut[path], len(cur) // 2)
            _set(r, path, cur[: len(cur) // 2])
    more = base_more + more_for(True)
    if more:
        r["more"] = more
    return r
