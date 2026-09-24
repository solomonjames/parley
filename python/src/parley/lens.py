"""Lens: the canonical compact text rendering of values and replies (SPEC §9)."""

from __future__ import annotations

import math
import re
from datetime import datetime, timezone
from typing import Any

from ._json import compact, js_number, quote

_BARE = re.compile(r"[A-Za-z0-9_@./+\-:() '!?&%$#*=<>~^]+")
_JSON_NUMBER = re.compile(r"-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?")
_RESERVED = frozenset({"-", "true", "false", "null"})
_ZERO_DECIMAL = frozenset({"JPY", "KRW", "VND", "CLP", "ISK", "UGX", "XAF", "XOF"})
_EFFECT_SYM = {"create": "+", "update": "~", "delete": "-", "send": ">", "charge": "$", "other": "*"}
_DURATION_UNITS = ((86400, "d"), (3600, "h"), (60, "m"))


def est(text: str) -> int:
    """Shared token estimate: ``ceil(utf8ByteLength / 4)`` (SPEC §8)."""
    return -(-len(text.encode("utf-8")) // 4)


# ---------------------------------------------------------------- lean notation (§9.1)


def _is_scalar(v: Any) -> bool:
    return v is None or isinstance(v, (bool, int, float, str))


def _is_bare(s: str) -> bool:
    return (
        _BARE.fullmatch(s) is not None
        and not s.startswith(" ")
        and not s.endswith(" ")
        and s not in _RESERVED
        and _JSON_NUMBER.fullmatch(s) is None
    )


def scalar(v: Any) -> str:
    if v is None:
        return "-"
    if v is True:
        return "true"
    if v is False:
        return "false"
    if isinstance(v, (int, float)):
        return "-" if isinstance(v, float) and not math.isfinite(v) else js_number(v)
    if isinstance(v, str):
        return v if _is_bare(v) else quote(v)
    return compact(v)


def _ind(n: int) -> str:
    return "  " * n


def _object_lines(obj: dict, n: int) -> list[str]:
    lines: list[str] = []
    for k, v in obj.items():
        lines.extend(_entry_lines(str(k), v, n))
    return lines


def _entry_lines(key: str, v: Any, n: int) -> list[str]:
    key = scalar(key)
    if isinstance(v, dict):
        if not v:
            return [f"{_ind(n)}{key}: {{}}"]
        return [f"{_ind(n)}{key}:"] + _object_lines(v, n + 1)
    if isinstance(v, (list, tuple)):
        return _array_lines(key, list(v), n)
    return [f"{_ind(n)}{key}: {scalar(v)}"]


# _array_lines and _item_lines take an already-rendered key.


def _scalar_list(items: list) -> str:
    return "[" + ", ".join(scalar(x) for x in items) + "]"


def _is_table(items: list) -> bool:
    first = items[0]
    if not isinstance(first, dict) or not first:
        return False
    keys = list(first)
    return all(
        isinstance(x, dict) and list(x) == keys and all(_is_scalar(val) for val in x.values()) for x in items
    )


def _array_lines(key: str, items: list, n: int) -> list[str]:
    if not items:
        return [f"{_ind(n)}{key}: []"]
    if all(_is_scalar(x) for x in items):
        return [f"{_ind(n)}{key}: {_scalar_list(items)}"]
    if _is_table(items):
        keys = list(items[0])
        head = f"{_ind(n)}{key}[{len(items)}]{{{','.join(scalar(k) for k in keys)}}}:"
        rows = [_ind(n + 1) + ",".join(scalar(x[k]) for k in keys) for x in items]
        return [head] + rows
    lines = [f"{_ind(n)}{key}[{len(items)}]:"]
    for el in items:
        lines.extend(_item_lines(el, n + 1))
    return lines


def _item_lines(el: Any, n: int) -> list[str]:
    dash = _ind(n) + "- "
    if isinstance(el, dict):
        if not el:
            return [dash + "{}"]
        sub = _object_lines(el, n + 1)
        sub[0] = dash + sub[0][len(_ind(n + 1)):]
        return sub
    if isinstance(el, (list, tuple)):
        el = list(el)
        return [dash + (_scalar_list(el) if all(_is_scalar(x) for x in el) else compact(el))]
    return [dash + scalar(el)]


def lean(v: Any) -> str:
    """Lean rendering of an arbitrary JSON value."""
    if isinstance(v, dict):
        return "\n".join(_object_lines(v, 0)) or "{}"
    if isinstance(v, (list, tuple)):
        return "\n".join(_array_lines("items", list(v), 0))
    return scalar(v)


# ---------------------------------------------------------------- reply renderings (§9.2)


def fmt_time(t: Any) -> str:
    if type(t) is not int and not (isinstance(t, float) and t.is_integer()):
        return scalar(t)
    d = datetime.fromtimestamp(int(t), tz=timezone.utc)
    s = d.strftime("%Y-%m-%dT%H:%M")
    return s + (f":{d.second:02d}" if d.second else "") + "Z"


def fmt_duration(secs: Any) -> str:
    if type(secs) is not int:
        return scalar(secs)
    for size, unit in _DURATION_UNITS:
        if secs != 0 and secs % size == 0:
            return f"{secs // size}{unit}"
    return f"{secs}s"


def fmt_money(cost: Any) -> str:
    if cost is None:
        return "free"
    amount, currency = cost.get("amount"), cost.get("currency")
    if currency in _ZERO_DECIMAL:
        return f"{amount} {currency}"
    sign = "-" if amount < 0 else ""
    a = abs(amount)
    return f"{sign}{a // 100}.{a % 100:02d} {currency}"


def effect_line(e: dict) -> str:
    op = e.get("op", "other")
    line = f"{_EFFECT_SYM.get(op, '*')} {op} {e.get('target', '')}"
    if e.get("field"):
        line += f".{e['field']}"
    if "from" in e or "to" in e:
        line += f": {scalar(e.get('from'))} → {scalar(e.get('to'))}"
    if e.get("detail"):
        line += f" — {e['detail']}"
    return line


def param_list(params: Any) -> str:
    """``(name: type, …)``; nested schemas render as ``{k: t}``, arrays of them as ``[{…}]``."""
    if not params:
        return "()"

    def ty(t: Any) -> str:
        if isinstance(t, str):
            return t
        if isinstance(t, list):
            return f"[{ty(t[0])}]"
        return "{" + param_list(t)[1:-1] + "}"

    return "(" + ", ".join(f"{k}: {ty(t)}" for k, t in params.items()) + ")"


def _brief(r: dict) -> list[str]:
    svc = r.get("service") or {}
    lines = [f"# {svc.get('name', '')} ({svc.get('id', '')})"]
    if svc.get("summary"):
        lines.append(svc["summary"])
    for c in r.get("capabilities") or []:
        line = f"{c.get('kind', '')} {c.get('name', '')}{param_list(c.get('params'))}"
        if c.get("summary"):
            line += f" — {c['summary']}"
        if c.get("risk"):
            line += f" [risk:{c['risk']}]"
        lines.append(line)
    return lines


def _proposals(r: dict) -> list[str]:
    ps = r.get("proposals") or []
    lines = [f"{len(ps)} proposal{'' if len(ps) == 1 else 's'}:"]
    for p in ps:
        lines.append(f"[{p.get('id', '')}] {p.get('summary', '')}")
        lines.extend("  " + effect_line(e) for e in p.get("effects") or [])
        undo = p.get("undo")
        undo_s = fmt_duration(undo["window"]) if isinstance(undo, dict) and "window" in undo else "never"
        lines.append(
            f"  cost: {fmt_money(p.get('cost'))} · risk: {p.get('risk', '-')} · undo: {undo_s}"
            f" · expires: {fmt_time(p.get('expires'))}"
        )
        if "data" in p:
            lines.extend(_entry_lines("data", p["data"], 1))
    return lines


def _clarify(r: dict) -> list[str]:
    lines = [f"? {r.get('question', '')}"]
    lines.extend(f"  {i}. {o.get('label', '')}" for i, o in enumerate(r.get("options") or [], 1))
    return lines


def _receipt(r: dict) -> list[str]:
    rc = r.get("receipt") or {}
    tail = f"(receipt {rc.get('id', '')})"
    if r.get("replay"):
        tail += " (replay)"
    if rc.get("undoes"):
        lines = [f"↶ undid {rc['undoes']}: {rc.get('summary', '')} {tail}"]
    else:
        lines = [f"✓ {rc.get('summary', '')} {tail}"]
    lines.extend("  " + effect_line(e) for e in rc.get("effects") or [])
    undo = rc.get("undo")
    lines.append(f"  undo: until {fmt_time(undo['until'])}" if isinstance(undo, dict) and "until" in undo else "  undo: never")
    if "result" in rc:
        lines.extend(_entry_lines("result", rc["result"], 1))
    return lines


def _error(r: dict) -> list[str]:
    lines = [f"✗ {r.get('code', '')}: {r.get('message', '')}"]
    for f in r.get("fix") or []:
        line = f"  fix: {f.get('say', '')}"
        if f.get("params") is not None:
            line += f" → params {compact(f['params'])}"
        lines.append(line)
    if r.get("need"):
        lines.append(f"  need: {compact(r['need'])}")
    consent = r.get("consent")
    if consent:
        lines.append(f"  consent: principal must approve {consent.get('hash', '')} ({consent.get('summary', '')})")
    if isinstance(r.get("retry"), (int, float)) and not isinstance(r.get("retry"), bool):
        lines.append(f"  retry in: {fmt_duration(r['retry'])}")
    return lines


def _event(r: dict) -> list[str]:
    line = f"… {r.get('message', '')}"
    if r.get("progress") is not None:
        line += f" ({math.floor(r['progress'] * 100 + 0.5)}%)"  # JS Math.round semantics
    return [line]


def more_line(m: dict) -> str:
    return f"… {m.get('remaining')} more at {m.get('path')} — EXPAND {m.get('handle')} (~{m.get('est')} tokens)"


_RENDERERS = {
    "BRIEF": _brief,
    "PROPOSALS": _proposals,
    "CLARIFY": _clarify,
    "RECEIPT": _receipt,
    "ERROR": _error,
    "EVENT": _event,
    "ANSWER": lambda r: [lean(r.get("data"))],
}


def lens(reply: dict) -> str:
    """Render a reply frame. Ignores any service-supplied ``lens`` field."""
    render = _RENDERERS.get(reply.get("kind", ""))
    lines = render(reply) if render else [lean({k: v for k, v in reply.items() if k not in ("parley", "id", "re")})]
    lines.extend(more_line(m) for m in reply.get("more") or [])
    return "\n".join(lines)

