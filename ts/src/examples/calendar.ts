// A calendar that speaks Parley. Agents say what they want ("move my 1:1 with Ana to
// Thursday"); the calendar answers with proposals whose effects, risk and undo window
// are explicit. Nothing changes until COMMIT, and every change can be undone for a day.
import { ParleyError, clarify, create, fix, remove, send, service, update, type Plan } from "../index.js";

interface Ev { id: string; title: string; start: string; end: string; with: string[] }

const HOUR = 3600_000;
const iso = (ms: number) => new Date(ms).toISOString().replace(".000Z", "Z");

export function calendar(opts: { trust: string[] | ((principal: string) => boolean); id?: string }) {
  // Computed per call, not at module load: some runtimes (Workers) freeze the clock during startup.
  const now = new Date();
  const day0 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + 86400_000;
  const at = (d: number, h: number, m = 0) => iso(day0 + d * 86400_000 + h * HOUR + m * 60_000);
  let seq = 100;
  const events: Ev[] = [
    { id: "e1", title: "Standup", start: at(0, 9), end: at(0, 9, 15), with: ["team@acme.co"] },
    { id: "e2", title: "1:1 with Ana", start: at(0, 14), end: at(0, 14, 30), with: ["ana.ruiz@acme.co"] },
    { id: "e3", title: "Design review", start: at(0, 16), end: at(0, 17), with: ["ana.ruiz@acme.co", "lee@acme.co"] },
    { id: "e4", title: "Standup", start: at(1, 9), end: at(1, 9, 15), with: ["team@acme.co"] },
    { id: "e5", title: "Pipeline sync with Ana", start: at(1, 11), end: at(1, 11, 30), with: ["ana.li@acme.co"] },
    { id: "e6", title: "Lunch with Sam", start: at(1, 12, 30), end: at(1, 13, 30), with: ["sam@example.com"] },
    { id: "e7", title: "Standup", start: at(2, 9), end: at(2, 9, 15), with: ["team@acme.co"] },
    { id: "e8", title: "Quarterly planning", start: at(2, 13), end: at(2, 15), with: ["leads@acme.co"] },
  ];

  const find = (q: string) => {
    const byId = events.find((e) => e.id === q);
    if (byId) return [byId];
    const words = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
    return events.filter((e) => words.every((w) => (e.title + " " + e.with.join(" ")).toLowerCase().includes(w)));
  };
  const overlaps = (s: number, e: number, skip?: string) => events.find((x) => x.id !== skip && Date.parse(x.start) < e && Date.parse(x.end) > s);
  const freeSlots = (day: string, minutes: number, skip?: string) => {
    const out: string[] = [];
    const base = Date.parse(day + "T00:00:00Z");
    for (let t = base + 9 * HOUR; t + minutes * 60_000 <= base + 18 * HOUR; t += 30 * 60_000) if (!overlaps(t, t + minutes * 60_000, skip)) out.push(iso(t));
    return out;
  };
  const one = (q: string): Ev => {
    const m = find(q);
    if (m.length === 1) return m[0];
    if (!m.length) throw new ParleyError("not_found", `no event matches ${JSON.stringify(q)}`, { fix: [fix("ASK calendar.agenda to see events, then use an event id")] });
    throw m; // ambiguous: handled by caller as CLARIFY
  };
  const pick = <T>(q: string, then: (e: Ev) => T) => {
    try {
      return then(one(q));
    } catch (m) {
      if (!Array.isArray(m)) throw m;
      return clarify(`${m.length} events match "${q}". Which one?`, m.map((e: Ev) => ({ label: `${e.title} · ${e.start} · ${e.with.join(", ")}`, params: { event: e.id } })));
    }
  };

  const movePlan = (e: Ev, startMs: number): Plan => {
    const dur = Date.parse(e.end) - Date.parse(e.start);
    const before = { start: e.start, end: e.end };
    const to = { start: iso(startMs), end: iso(startMs + dur) };
    return {
      summary: `Move "${e.title}" to ${to.start}`,
      effects: [update(`event/${e.id}`, "start", e.start, to.start), ...e.with.map((w) => send(w, "updated invite"))],
      undoWindow: 86400,
      apply: () => { Object.assign(e, to); return { event: e.id, start: e.start }; },
      revert: () => { Object.assign(e, before); },
    };
  };

  return service({
    id: opts.id ?? "calendar.example",
    name: "Example Calendar",
    summary: "Your work calendar. Read your agenda, find free time, and book, move or cancel meetings. Invitees are notified automatically.",
    trust: opts.trust,
  })
    .ask("calendar.agenda", {
      summary: "Events, optionally for one day and/or matching a query",
      params: { "day?": "date", "query?": "string — words in title or attendee" },
      run: ({ params }) =>
        (params.query ? find(params.query) : events)
          .filter((e) => !params.day || e.start.startsWith(params.day))
          .map((e) => ({ id: e.id, title: e.title, start: e.start, end: e.end, with: e.with.join(" ") })),
    })
    .ask("calendar.free", {
      summary: "Free slots on a day (09:00–18:00 UTC)",
      params: { day: "date", "minutes?": "int" },
      run: ({ params }) => ({ day: params.day, slots: freeSlots(params.day, params.minutes ?? 30) }),
    })
    .intent("calendar.reschedule", {
      summary: "Move a meeting to a new time; with only `day`, proposes free slots",
      params: { event: "string — id or words from the title", "to?": "datetime", "day?": "date" },
      risk: "low",
      plan: ({ params }) =>
        pick(params.event, (e) => {
          const dur = Date.parse(e.end) - Date.parse(e.start);
          if (params.to) {
            const s = Date.parse(params.to);
            if (s < Date.now()) throw new ParleyError("invalid_params", `\`to\` is in the past (${params.to})`, { fix: [fix("use a future time", { to: iso(s + 365 * 86400_000) })] });
            const clash = overlaps(s, s + dur, e.id);
            if (clash) {
              const alts = freeSlots(params.to.slice(0, 10), dur / 60_000, e.id).slice(0, 3);
              throw new ParleyError("conflict", `${params.to} overlaps "${clash.title}"`, { fix: alts.map((t) => fix(`use free slot ${t}`, { to: t })) });
            }
            return movePlan(e, s);
          }
          const day = params.day ?? e.start.slice(0, 10);
          const slots = freeSlots(day, dur / 60_000, e.id).slice(0, 3);
          if (!slots.length) throw new ParleyError("not_found", `no free slot on ${day}`, { fix: [fix("try another day", { day: iso(Date.parse(day) + 86400_000).slice(0, 10) })] });
          return slots.map((t) => movePlan(e, Date.parse(t)));
        }),
    })
    .intent("calendar.cancel", {
      summary: "Cancel a meeting and notify attendees",
      params: { event: "string — id or words from the title", "note?": "string" },
      risk: "medium",
      plan: ({ params }) =>
        pick(params.event, (e) => ({
          summary: `Cancel "${e.title}" (${e.start})`,
          effects: [remove(`event/${e.id}`), ...e.with.map((w) => send(w, params.note ? `cancellation: ${params.note}` : "cancellation"))],
          risk: e.with.length > 1 ? "medium" : "low",
          undoWindow: 86400,
          apply: () => { events.splice(events.indexOf(e), 1); return { cancelled: e.id }; },
          revert: () => { events.push(e); },
        })),
    })
    .intent("calendar.book", {
      summary: "Book a new meeting; proposes the first free slots",
      params: { title: "string", with: "string[] — emails", day: "date", "minutes?": "int" },
      plan: ({ params }) => {
        const minutes = params.minutes ?? 30;
        return freeSlots(params.day, minutes).slice(0, 3).map((t): Plan => {
          const ev: Ev = { id: `e${++seq}`, title: params.title, start: t, end: iso(Date.parse(t) + minutes * 60_000), with: params.with };
          return {
            summary: `Book "${ev.title}" at ${t} (${minutes}m)`,
            effects: [create(`event/${ev.id}`, `${t} · ${minutes}m`), ...ev.with.map((w: string) => send(w, "invite"))],
            undoWindow: 86400,
            apply: () => { events.push(ev); return { event: ev.id }; },
            revert: () => { events.splice(events.indexOf(ev), 1); },
          };
        });
      },
    });
}
