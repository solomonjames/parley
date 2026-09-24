"""A calendar that speaks Parley: a line-for-line port of ../../examples/calendar.ts.

Agents say what they want ("move my 1:1 with Ana to Thursday"); the calendar answers with
proposals whose effects, risk and undo window are explicit. Nothing changes until COMMIT,
and every change can be undone for a day.
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta, timezone

from parley import ParleyError, Plan, Service, clarify, compact, create, fix, remove, send, update

HOUR = 3600_000
DAY = 86400_000


def iso(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


_ISO = re.compile(r"(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?)?")


def parse(s: str) -> int:
    """Date.parse for the ISO forms the schema accepts; returns epoch milliseconds."""
    m = _ISO.fullmatch(s)
    if not m:
        raise ParleyError("invalid_params", f"cannot parse time {compact(s)}")
    y, mo, d, h, mi, sec, frac, tz = m.groups()
    dt = datetime(int(y), int(mo), int(d), int(h or 0), int(mi or 0), int(sec or 0), tzinfo=timezone.utc)
    if tz and tz != "Z":
        sign = 1 if tz[0] == "+" else -1
        dt -= sign * timedelta(hours=int(tz[1:3]), minutes=int(tz[4:6]))
    return int(dt.timestamp() * 1000) + int(((frac or "0") + "00")[:3])


def calendar(trust: list[str], id: str = "calendar.example") -> Service:
    now = datetime.now(timezone.utc)
    day0 = int(datetime(now.year, now.month, now.day, tzinfo=timezone.utc).timestamp() * 1000) + DAY

    def at(d: int, h: int, m: int = 0) -> str:
        return iso(day0 + d * DAY + h * HOUR + m * 60_000)

    seq = [100]
    events = [
        {"id": "e1", "title": "Standup", "start": at(0, 9), "end": at(0, 9, 15), "with": ["team@acme.co"]},
        {"id": "e2", "title": "1:1 with Ana", "start": at(0, 14), "end": at(0, 14, 30), "with": ["ana.ruiz@acme.co"]},
        {"id": "e3", "title": "Design review", "start": at(0, 16), "end": at(0, 17), "with": ["ana.ruiz@acme.co", "lee@acme.co"]},
        {"id": "e4", "title": "Standup", "start": at(1, 9), "end": at(1, 9, 15), "with": ["team@acme.co"]},
        {"id": "e5", "title": "Pipeline sync with Ana", "start": at(1, 11), "end": at(1, 11, 30), "with": ["ana.li@acme.co"]},
        {"id": "e6", "title": "Lunch with Sam", "start": at(1, 12, 30), "end": at(1, 13, 30), "with": ["sam@example.com"]},
        {"id": "e7", "title": "Standup", "start": at(2, 9), "end": at(2, 9, 15), "with": ["team@acme.co"]},
        {"id": "e8", "title": "Quarterly planning", "start": at(2, 13), "end": at(2, 15), "with": ["leads@acme.co"]},
    ]

    def find(q: str) -> list[dict]:
        by_id = [e for e in events if e["id"] == q]
        if by_id:
            return by_id[:1]
        words = [w for w in q.lower().split() if len(w) > 1]
        return [e for e in events if all(w in (e["title"] + " " + " ".join(e["with"])).lower() for w in words)]

    def overlaps(s: int, e: int, skip: str | None = None) -> dict | None:
        return next((x for x in events if x["id"] != skip and parse(x["start"]) < e and parse(x["end"]) > s), None)

    def free_slots(day: str, minutes: int, skip: str | None = None) -> list[str]:
        base = parse(day + "T00:00:00Z")
        out, t = [], base + 9 * HOUR
        while t + minutes * 60_000 <= base + 18 * HOUR:
            if not overlaps(t, t + minutes * 60_000, skip):
                out.append(iso(t))
            t += 30 * 60_000
        return out

    def pick(q: str, then):
        m = find(q)
        if len(m) == 1:
            return then(m[0])
        if not m:
            raise ParleyError("not_found", f"no event matches {compact(q)}", fix=[fix("ASK calendar.agenda to see events, then use an event id")])
        return clarify(
            f'{len(m)} events match "{q}". Which one?',
            [{"label": f"{e['title']} · {e['start']} · {', '.join(e['with'])}", "params": {"event": e["id"]}} for e in m],
        )

    def move_plan(e: dict, start_ms: int) -> Plan:
        dur = parse(e["end"]) - parse(e["start"])
        before = {"start": e["start"], "end": e["end"]}
        to = {"start": iso(start_ms), "end": iso(start_ms + dur)}

        def apply(_ctx):
            e.update(to)
            return {"event": e["id"], "start": e["start"]}

        return Plan(
            summary=f'Move "{e["title"]}" to {to["start"]}',
            effects=[update(f"event/{e['id']}", "start", e["start"], to["start"]), *(send(w, "updated invite") for w in e["with"])],
            undo_window=86400,
            apply=apply,
            revert=lambda _ctx: e.update(before),
        )

    svc = Service(
        id,
        "Example Calendar",
        "Your work calendar. Read your agenda, find free time, and book, move or cancel meetings. Invitees are notified automatically.",
        trust=trust,
    )

    @svc.ask("calendar.agenda", "Events, optionally for one day and/or matching a query",
             {"day?": "date", "query?": "string — words in title or attendee"})
    def agenda(ctx):
        p = ctx.params
        return [
            {"id": e["id"], "title": e["title"], "start": e["start"], "end": e["end"], "with": " ".join(e["with"])}
            for e in (find(p["query"]) if p.get("query") else events)
            if not p.get("day") or e["start"].startswith(p["day"])
        ]

    @svc.ask("calendar.free", "Free slots on a day (09:00–18:00 UTC)", {"day": "date", "minutes?": "int"})
    def free(ctx):
        return {"day": ctx.params["day"], "slots": free_slots(ctx.params["day"], int(ctx.params.get("minutes") or 30))}

    @svc.intent("calendar.reschedule", "Move a meeting to a new time; with only `day`, proposes free slots",
                {"event": "string — id or words from the title", "to?": "datetime", "day?": "date"}, risk="low")
    def reschedule(ctx):
        p = ctx.params

        def then(e):
            dur = parse(e["end"]) - parse(e["start"])
            if p.get("to"):
                s = parse(p["to"])
                if s < time.time() * 1000:
                    raise ParleyError("invalid_params", f"`to` is in the past ({p['to']})", fix=[fix("use a future time", {"to": iso(s + 365 * DAY)})])
                clash = overlaps(s, s + dur, e["id"])
                if clash:
                    alts = free_slots(p["to"][:10], dur // 60_000, e["id"])[:3]
                    raise ParleyError("conflict", f'{p["to"]} overlaps "{clash["title"]}"', fix=[fix(f"use free slot {t}", {"to": t}) for t in alts])
                return move_plan(e, s)
            day = p.get("day") or e["start"][:10]
            slots = free_slots(day, dur // 60_000, e["id"])[:3]
            if not slots:
                raise ParleyError("not_found", f"no free slot on {day}", fix=[fix("try another day", {"day": iso(parse(day) + DAY)[:10]})])
            return [move_plan(e, parse(t)) for t in slots]

        return pick(p["event"], then)

    @svc.intent("calendar.cancel", "Cancel a meeting and notify attendees",
                {"event": "string — id or words from the title", "note?": "string"}, risk="medium")
    def cancel(ctx):
        p = ctx.params

        def then(e):
            def apply(_ctx):
                events.remove(e)
                return {"cancelled": e["id"]}

            return Plan(
                summary=f'Cancel "{e["title"]}" ({e["start"]})',
                effects=[remove(f"event/{e['id']}"),
                         *(send(w, f"cancellation: {p['note']}" if p.get("note") else "cancellation") for w in e["with"])],
                risk="medium" if len(e["with"]) > 1 else "low",
                undo_window=86400,
                apply=apply,
                revert=lambda _ctx: events.append(e),
            )

        return pick(p["event"], then)

    @svc.intent("calendar.book", "Book a new meeting; proposes the first free slots",
                {"title": "string", "with": "string[] — emails", "day": "date", "minutes?": "int"})
    def book(ctx):
        p = ctx.params
        minutes = int(p.get("minutes") or 30)
        plans = []
        for t in free_slots(p["day"], minutes)[:3]:
            seq[0] += 1
            ev = {"id": f"e{seq[0]}", "title": p["title"], "start": t, "end": iso(parse(t) + minutes * 60_000), "with": p["with"]}
            plans.append(Plan(
                summary=f'Book "{ev["title"]}" at {t} ({minutes}m)',
                effects=[create(f"event/{ev['id']}", f"{t} · {minutes}m"), *(send(w, "invite") for w in ev["with"])],
                undo_window=86400,
                apply=lambda _ctx, ev=ev: (events.append(ev), {"event": ev["id"]})[1],
                revert=lambda _ctx, ev=ev: events.remove(ev),
            ))
        return plans

    return svc
