<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { withBase } from "vitepress";

const repo = "https://github.com/solomonjames/parley";

// The hero exchange. Every reply line is real Lens, as a model reads it.
type Line = { t: string; kind: "wire" | "lens"; state?: "amber" | "green" | "undo" | "struck" };
const steps: { label: string; lines: Line[] }[] = [
  {
    label: "Intent",
    lines: [{ kind: "wire", t: '→ INTENT calendar.reschedule {event: "1:1 with Ana", to: "2026-09-27T09:30:00Z"}' }],
  },
  {
    label: "Proposal",
    lines: [
      { kind: "lens", state: "amber", t: "1 proposal:" },
      { kind: "lens", state: "amber", t: '[p_B8YnaADk] Move "1:1 with Ana" to 2026-09-27T09:30:00Z' },
      { kind: "lens", state: "amber", t: "  ~ update event/e2.start: 2026-09-25T14:00:00Z → 2026-09-27T09:30:00Z" },
      { kind: "lens", state: "amber", t: "  > send ana.ruiz@acme.co — updated invite" },
      { kind: "lens", state: "amber", t: "  cost: free · risk: low · undo: 1d · expires: 2026-09-24T02:22Z" },
    ],
  },
  {
    label: "Commit",
    lines: [
      { kind: "wire", t: "→ COMMIT p_B8YnaADk + grant signed by the human's key" },
      { kind: "lens", state: "green", t: '✓ Move "1:1 with Ana" to 2026-09-27T09:30:00Z (receipt r_OMx81dAk) · undo until 2026-09-25T02:11Z' },
      { kind: "lens", state: "green", t: "  result:" },
      { kind: "lens", state: "green", t: "    event: e2" },
    ],
  },
  {
    label: "Undo",
    lines: [
      { kind: "wire", t: "→ UNDO r_OMx81dAk" },
      { kind: "lens", state: "undo", t: '↶ undid r_OMx81dAk: Move "1:1 with Ana" to 2026-09-27T09:30:00Z (receipt r_Q2x7bLmn)' },
    ],
  },
];

const shown = ref(steps.length); // SSR and no-JS render the finished exchange
const undone = ref(true);
let timers: ReturnType<typeof setTimeout>[] = [];

function play() {
  timers.forEach(clearTimeout);
  timers = [];
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    shown.value = steps.length;
    undone.value = true;
    return;
  }
  shown.value = 0;
  undone.value = false;
  steps.forEach((_, i) => timers.push(setTimeout(() => (shown.value = i + 1), 400 + i * 1500)));
  timers.push(setTimeout(() => (undone.value = true), 400 + (steps.length - 1) * 1500 + 500));
}
onMounted(play);
onBeforeUnmount(() => timers.forEach(clearTimeout));

const rows = [
  ["Reschedule a meeting (REST: search, free slots, update)", "3 → 1", "3,679", "1,454", "60%"],
  ["Reschedule a meeting (REST: one outcome-level endpoint)", "1 → 1", "1,545", "1,454", "6%"],
  ["Find vegan meals under 700 kcal and order four", "2 → 2", "3,080", "2,567", "17%"],
  ["Read the full 60-item menu", "1 → 1", "3,388", "2,401", "29%"],
  ["Skim the first 30 items (REST limit=30, Parley budget=800)", "1 → 1", "2,403", "1,867", "22%"],
];

const changes: [string, string][] = [
  ["Agents want outcomes, but APIs expose CRUD.", "INTENT carries the goal. The service answers with concrete proposals."],
  ["Agents make mistakes.", "Nothing happens until COMMIT. Every proposal lists its effects, cost, risk and undo window, and its hash binds the commit to exactly what was shown."],
  ["Asking every time is slow; never asking is reckless.", "The human's signed policy decides. Low-risk, undoable changes inside it commit in one round trip. Anything costlier or irreversible stops for review."],
  ["Undo is an afterthought.", "Receipts carry an undo window, and UNDO is a verb."],
  ["Context windows are expensive.", "Every request carries a token budget. Replies fit it and leave EXPAND handles for the rest."],
  ["API keys are coarse.", "Grants are Ed25519 capability chains with spend caps, expiry, scopes and risk ceilings, verified offline and narrowed for sub-agents."],
  ["Errors say what failed.", "Errors say how to fix it, with patches a model can apply. Ambiguity gets CLARIFY, not an error."],
];

const compare = [
  ["Unit of interaction", "resource (CRUD)", "tool call, usually wrapping an endpoint", "intent → proposal → commit"],
  ["Preview before side effects", "rare, per API (dry-run flags)", "annotations such as destructiveHint, as hints; no effect preview", "effects, cost, risk and undo on every proposal, bound by hash"],
  ["Undo", "per API, if at all", "not in the protocol", "a verb, with declared windows"],
  ["Delegation", "API keys, OAuth scopes", "OAuth at the transport", "attenuable capability chains with spend caps and risk ceilings, verified offline"],
  ["Human approval", "app-specific", "elicitation, not bound to an action", "a consent grant signed over the exact proposal hash"],
  ["Context budget", "pagination, field selection", "list pagination", "every reply fits the budget, with EXPAND for the rest"],
  ["Model-facing format", "JSON", "text or structured content, per server", "Lens: canonical and byte-identical across implementations"],
  ["Errors", "status codes, RFC 9457", "JSON-RPC codes, isError and free text", "machine-applicable fixes, plus CLARIFY"],
];
</script>

<template>
  <div class="landing">
    <section class="hero">
      <div class="hero-copy">
        <h1>HTTP was built for browsers. Parley is built for agents.</h1>
        <p class="lede">
          An open protocol for AI agents acting on behalf of people. The agent states what it wants. The service
          replies with proposals whose effects are listed up front. The human's policy decides what can go ahead
          without asking, and commits come with an undo window.
        </p>
        <div class="ctas">
          <a class="btn primary" :href="withBase('/playground')">Open the playground</a>
          <a class="btn" :href="withBase('/guide/quickstart')">Quickstart</a>
          <a class="btn ghost" :href="repo">GitHub</a>
        </div>
        <p class="note">Runs in your browser: the real protocol core, no server, no signup.</p>
      </div>

      <figure class="exchange" aria-label="An agent moves a meeting, commits it, then undoes it">
        <ol class="stepper">
          <li v-for="(s, i) in steps" :key="s.label" :class="{ on: shown > i, now: shown === i + 1 }">
            <span class="n">{{ i + 1 }}</span>{{ s.label }}
          </li>
        </ol>
        <div class="screen" role="log">
          <template v-for="(s, i) in steps" :key="s.label">
            <div v-if="shown > i" class="step">
              <div
                v-for="(l, j) in s.lines"
                :key="j"
                :class="['ln', l.kind, l.state, { struck: undone && s.label === 'Commit' && l.kind === 'lens' }]"
              >{{ l.t }}</div>
            </div>
          </template>
        </div>
        <figcaption>
          <span class="key amber">proposed</span>
          <span class="key green">committed</span>
          <button class="replay" type="button" @click="play">Replay</button>
        </figcaption>
      </figure>
    </section>

    <section class="band">
      <h2>What changes</h2>
      <dl class="changes">
        <template v-for="[p, a] in changes" :key="p">
          <dt>{{ p }}</dt>
          <dd>{{ a }}</dd>
        </template>
      </dl>
    </section>

    <section class="band">
      <h2>Fewer tokens, and the agent sees more</h2>
      <p class="sub">
        The same tasks over the same data: a REST-style MCP server with one tool per endpoint, against Parley through
        its MCP bridge. Totals are what you pay for, with every turn re-reading tool definitions and the conversation.
        Real BPE counts (o200k), seeded ids, compared against minified JSON, REST's best case.
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Task</th><th>Calls</th><th class="num">REST, minified</th><th class="num">Parley</th><th class="num">Saved</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r[0]">
              <td>{{ r[0] }}</td><td>{{ r[1] }}</td><td class="num">{{ r[2] }}</td><td class="num">{{ r[3] }}</td><td class="num strong">{{ r[4] }}</td>
            </tr>
            <tr class="total"><td>All tasks, CRUD reschedule</td><td></td><td class="num">12,550</td><td class="num">8,289</td><td class="num strong">34%</td></tr>
          </tbody>
        </table>
      </div>
      <p class="caveat">
        Where the win comes from matters. When REST offers the same outcome-level endpoint, rescheduling saves only 6%:
        most of that row's gain is API shape, which Parley encourages but doesn't monopolize. Against pretty-printed JSON
        the total saving is 44%. The rest comes from Lens, budgets and fewer round trips, and the Parley agent also saw
        every effect before it happened.
        <a :href="withBase('/reference/benchmark')">Method and raw output</a>
      </p>
    </section>

    <section class="band quote">
      <blockquote>
        <p>
          I didn't try to get around the limit. Splitting it into two orders would have dodged the check. Even the
          cheapest four meals come to $53.95, so no single order fits under $40.
        </p>
      </blockquote>
      <p class="attrib">
        Claude Sonnet 5 in headless Claude Code, given the Parley MCP bridge and no Parley documentation, after its order
        hit <code>consent_required</code>. It then handed the human the approval command.
        <a :href="withBase('/reference/claude-session')">Read the unedited session</a>
      </p>
    </section>

    <section class="band split">
      <div>
        <h2>Use it from Claude Code today</h2>
        <p>
          The bridge exposes Parley services as an MCP server, so Claude Code, Claude Desktop, Cursor and other MCP
          clients can use them now. Tool results are Lens. When a commit needs consent, the bridge never approves on the
          model's behalf.
        </p>
        <a :href="withBase('/guide/claude-code')">Set it up</a>
      </div>
      <div>
        <pre class="cmd"><code>parley init
parley grant --svc cal.example.com --risk low \
  --per 25USD --spend 100USD --exp 24h
claude mcp add parley -- npx parley-protocol mcp \
  parley://127.0.0.1:7447</code></pre>
        <p class="warn">
          Keep the principal key where the agent can't reach it. An agent with shell access that can read it can sign
          its own consent.
          <a :href="withBase('/guide/security')">Security model</a>
        </p>
      </div>
    </section>

    <section class="band">
      <h2>How it compares</h2>
      <div class="table-wrap">
        <table class="compare">
          <thead><tr><th></th><th>REST / HTTP APIs</th><th>MCP</th><th>Parley</th></tr></thead>
          <tbody>
            <tr v-for="c in compare" :key="c[0]"><th scope="row">{{ c[0] }}</th><td>{{ c[1] }}</td><td>{{ c[2] }}</td><td class="us">{{ c[3] }}</td></tr>
          </tbody>
        </table>
      </div>
      <p class="caveat">
        Parley doesn't replace MCP as an integration layer; the bridge runs on MCP. It replaces what MCP servers usually
        wrap: an API designed for code rather than for delegated agents.
      </p>
    </section>

    <section class="band end">
      <h2>Try it without installing anything</h2>
      <p>Play the agent against a calendar and a shop, set the human's policy, and watch what the model would read.</p>
      <div class="ctas">
        <a class="btn primary" :href="withBase('/playground')">Open the playground</a>
        <a class="btn" :href="withBase('/reference/spec')">Read the spec</a>
        <a class="btn ghost" :href="repo">Star on GitHub</a>
      </div>
    </section>
  </div>
</template>

<style scoped>
.landing { --w: 1152px; padding: 0 24px 96px; }
section { max-width: var(--w); margin: 0 auto; }
h1, h2 { font-family: var(--font-head); color: var(--vp-c-text-1); letter-spacing: -0.02em; }
a { color: var(--vp-c-brand-1); }

/* hero */
.hero { display: grid; grid-template-columns: minmax(0, 5fr) minmax(0, 7fr); gap: 56px; align-items: center; padding: 88px 0 96px; }
h1 { font-size: clamp(2.3rem, 4.4vw, 3.6rem); line-height: 1.02; font-weight: 600; margin: 0 0 24px; }
.lede { font-size: 1.12rem; line-height: 1.6; color: var(--vp-c-text-2); max-width: 46ch; margin: 0 0 32px; }
.ctas { display: flex; flex-wrap: wrap; gap: 12px; }
.btn { display: inline-flex; align-items: center; height: 44px; padding: 0 20px; border-radius: 8px; font-weight: 600; font-size: 0.95rem; text-decoration: none; border: 1px solid var(--vp-c-border); color: var(--vp-c-text-1); transition: background 0.15s, border-color 0.15s; }
.btn:hover { border-color: var(--vp-c-text-3); }
.btn.primary { background: var(--vp-button-brand-bg); color: var(--vp-button-brand-text); border-color: transparent; }
.btn.primary:hover { background: var(--vp-button-brand-hover-bg); }
.btn.ghost { border-color: transparent; }
.note { margin-top: 18px; font-size: 0.88rem; color: var(--vp-c-text-3); }

.exchange { margin: 0; background: var(--vp-code-block-bg); border: 1px solid var(--vp-c-divider); border-radius: 14px; overflow: hidden; }
.stepper { display: flex; margin: 0; padding: 0; list-style: none; border-bottom: 1px solid var(--vp-c-divider); }
.stepper li { flex: 1; padding: 12px 14px; font-size: 0.82rem; font-weight: 600; color: var(--vp-c-text-3); display: flex; align-items: center; gap: 8px; transition: color 0.3s; }
.stepper li + li { border-left: 1px solid var(--vp-c-divider); }
.stepper .n { display: inline-grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1px solid currentColor; font-size: 0.72rem; font-family: var(--vp-font-family-mono); }
.stepper li.on { color: var(--vp-c-text-1); }
.stepper li.now { color: var(--vp-c-brand-1); }
.screen { padding: 18px 20px 20px; min-height: 324px; font-family: var(--vp-font-family-mono); font-size: 12.5px; line-height: 1.75; overflow-x: auto; }
.step + .step { margin-top: 14px; }
.step { animation: in 0.45s ease-out both; }
@keyframes in { from { opacity: 0; transform: translateY(4px); } }
.ln { white-space: pre-wrap; overflow-wrap: anywhere; padding-left: 2ch; text-indent: -2ch; color: var(--vp-c-text-2); }
.ln.wire { color: var(--vp-c-text-3); }
.ln.amber { color: var(--state-amber); }
.ln.green { color: var(--state-green); }
.ln.undo { color: var(--vp-c-text-1); }
.ln.struck { text-decoration: line-through; text-decoration-color: var(--vp-c-text-3); opacity: 0.7; transition: opacity 0.4s; }
figcaption { display: flex; align-items: center; gap: 18px; padding: 10px 20px; border-top: 1px solid var(--vp-c-divider); font-size: 0.8rem; color: var(--vp-c-text-3); }
.key::before { content: ""; display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 7px; vertical-align: 1px; }
.key.amber::before { background: var(--state-amber); }
.key.green::before { background: var(--state-green); }
.replay { margin-left: auto; font: inherit; font-weight: 600; color: var(--vp-c-text-2); background: none; border: 0; cursor: pointer; padding: 4px 0; }
.replay:hover { color: var(--vp-c-brand-1); }

/* bands */
.band { padding: 72px 0; border-top: 1px solid var(--vp-c-divider); }
.band h2 { font-size: clamp(1.6rem, 2.6vw, 2.1rem); font-weight: 600; margin: 0 0 20px; line-height: 1.15; }
.sub, .caveat, .band > p { color: var(--vp-c-text-2); max-width: 72ch; line-height: 1.65; }
.caveat { font-size: 0.92rem; margin-top: 20px; }

.changes { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); margin: 32px 0 0; }
.changes dt, .changes dd { padding: 16px 0; border-bottom: 1px solid var(--vp-c-divider); margin: 0; }
.changes dt { color: var(--vp-c-text-3); padding-right: 32px; }
.changes dd { color: var(--vp-c-text-1); line-height: 1.55; }

.table-wrap { overflow-x: auto; margin-top: 28px; border: 1px solid var(--vp-c-divider); border-radius: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 0.93rem; }
th, td { text-align: left; padding: 12px 16px; border-bottom: 1px solid var(--vp-c-divider); vertical-align: top; }
tbody tr:last-child > * { border-bottom: 0; }
thead th { font-weight: 600; color: var(--vp-c-text-3); font-size: 0.84rem; background: var(--vp-c-bg-alt); }
.num { text-align: right; font-family: var(--vp-font-family-mono); font-size: 0.88rem; white-space: nowrap; }
.strong { color: var(--state-green); font-weight: 700; }
tr.total td { font-weight: 600; background: var(--vp-c-bg-alt); }
.compare th[scope="row"] { color: var(--vp-c-text-2); font-weight: 600; white-space: nowrap; }
.compare td { color: var(--vp-c-text-2); }
.compare td.us { color: var(--vp-c-text-1); }

.quote blockquote { margin: 0; padding: 0; border: 0; }
.quote blockquote p { font-family: var(--font-head); font-size: clamp(1.5rem, 2.6vw, 2.2rem); line-height: 1.3; font-weight: 500; color: var(--vp-c-text-1); max-width: 34ch; margin: 0; }
.quote blockquote p::before { content: "“"; color: var(--vp-c-brand-1); margin-left: -0.5em; }
.quote blockquote p::after { content: "”"; color: var(--vp-c-brand-1); }
.attrib { margin-top: 24px; font-size: 0.95rem; color: var(--vp-c-text-3); max-width: 64ch; }

.split { display: grid; grid-template-columns: 1fr 1fr; gap: 56px; align-items: start; }
.split p { color: var(--vp-c-text-2); line-height: 1.65; }
.cmd { margin: 0; padding: 18px 20px; background: var(--vp-code-block-bg); border: 1px solid var(--vp-c-divider); border-radius: 12px; font-family: var(--vp-font-family-mono); font-size: 0.84rem; line-height: 1.7; overflow-x: auto; color: var(--vp-c-text-1); }
.warn { margin-top: 16px; padding: 12px 16px; border-left: 3px solid var(--state-amber); background: var(--vp-c-brand-soft); border-radius: 0 8px 8px 0; font-size: 0.92rem; }

.end { text-align: left; }
.end p { margin-bottom: 28px; }

@media (max-width: 960px) {
  .hero { grid-template-columns: 1fr; gap: 40px; padding-top: 40px; }
  .split { grid-template-columns: 1fr; gap: 24px; }
  .changes { grid-template-columns: 1fr; }
  .changes dt { padding-bottom: 4px; border-bottom: 0; }
}
@media (max-width: 640px) {
  .landing { padding: 0 16px 64px; }
  .stepper li { padding: 10px 8px; font-size: 0.74rem; gap: 5px; }
  .screen { font-size: 11.5px; min-height: 280px; }
}
</style>
