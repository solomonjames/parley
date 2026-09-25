// A narrated, end-to-end Parley session over real TCP.  Run:  npm run demo
// A human (the principal) delegates to an agent with a policy; the agent does real work
// against two services; one purchase exceeds the policy and needs the human's consent.
import {
  consentGrant,
  delegateGrant,
  est,
  issueGrant,
  keyPair,
  type Answer,
  type Proposal,
} from '../index.js';
import { connect, listen } from '../node.js';
import { calendar } from './calendar.js';
import { shop } from './shop.js';

/** Run the narrated end-to-end demo over real TCP sockets (`parley demo`). */
export async function runDemo(): Promise<void> {
  const c = {
    dim: '\x1b[2m',
    b: '\x1b[1m',
    cyan: '\x1b[36m',
    mag: '\x1b[35m',
    yel: '\x1b[33m',
    grn: '\x1b[32m',
    red: '\x1b[31m',
    x: '\x1b[0m',
  };
  const color =
    (process.stdout.isTTY || !!process.env.FORCE_COLOR) &&
    !process.env.NO_COLOR;
  const k = (s: string, code: string) => (color ? code + s + c.x : s);
  let step = 0;
  const say = (who: string, text: string) =>
    console.log(`\n${k(`${++step}.`, c.dim)} ${k(who, c.b)} ${text}`);
  const wire = (verb: string, detail: string) =>
    console.log(k(`   → ${verb}`, c.cyan) + k(` ${detail}`, c.dim));
  const show = (text: string) => {
    console.log(
      text
        .split('\n')
        .map((l) => `   ${k('│ ', c.dim)}${l}`)
        .join('\n'),
    );
    console.log(k(`   └ ${est(text)} tokens`, c.dim));
  };
  const human = k('👤 human', c.yel),
    agentName = k('🤖 agent', c.mag),
    subName = k('🤖 sub-agent', c.mag);

  // ── setup: two services on real sockets ──────────────────────────────────────
  const james = await keyPair(),
    agent = await keyPair(),
    helper = await keyPair();
  const calSrv = await listen(calendar({ trust: [james.public] }), { port: 0 });
  const shopSrv = await listen(shop({ trust: [james.public] }), { port: 0 });
  const calUrl = `parley://127.0.0.1:${(calSrv.address() as any).port}`;
  const shopUrl = `parley://127.0.0.1:${(shopSrv.address() as any).port}`;
  const day = (n: number) =>
    new Date(Date.now() + n * 86400e3).toISOString().slice(0, 10);

  console.log(
    k(
      '\nParley demo — agents propose, humans set policy, everything is undoable\n',
      c.b,
    ),
  );

  say(human, 'delegates to the agent with a policy, not a password:');

  const policy = await issueGrant({
    principal: james,
    to: agent.public,
    caveats: [
      { svc: ['calendar.example', 'shop.example'] },
      { risk: 'low' },
      { per: { max: 4000, currency: 'USD' } },
      { spend: { max: 10000, currency: 'USD' } },
      { exp: Math.floor(Date.now() / 1000) + 8 * 3600 },
    ],
  });

  show(
    `grant ${policy.slice(0, 28)}… (${policy.length} bytes, signed Ed25519)\n  services: calendar.example, shop.example\n  risk ≤ low · ≤ 40.00 USD per action · ≤ 100.00 USD total · expires in 8h`,
  );

  const cal = await connect(calUrl, {
    key: agent.seed,
    grants: [policy],
    name: 'demo-agent',
  });
  const sh = await connect(shopUrl, {
    key: agent.seed,
    grants: [policy],
    name: 'demo-agent',
  });

  say(agentName, 'discovers what the calendar can do:');
  wire('HELLO', calUrl);
  show((await cal.hello()).lens);

  say(
    agentName,
    `"move my 1:1 with Ana to ${day(3)}", said with intent instead of CRUD calls:`,
  );
  wire('INTENT', `calendar.reschedule {event:"Ana", day:"${day(3)}"} auto`);

  const q = await cal.intent(
    'calendar.reschedule',
    { event: 'Ana', day: day(3) },
    { auto: true },
  );

  show(q.lens);

  if (q.kind === 'CLARIFY') {
    say(
      agentName,
      "picks option 1. The service knows it's low-risk and undoable, and the policy allows that, so it commits in the same round trip:",
    );
    wire(
      'INTENT',
      `calendar.reschedule ${JSON.stringify({ ...q.options[0].params, day: day(3) })} auto`,
    );

    const r = await cal.intent(
      'calendar.reschedule',
      { event: 'Ana', day: day(3), ...q.options[0].params },
      { auto: true },
    );

    show(r.lens);

    if (r.kind === 'RECEIPT') {
      say(human, `(simulated) "wait, not that day." The agent undoes it:`);
      wire('UNDO', r.receipt.id);
      show((await cal.undo(r.receipt.id)).lens);
    }
  }

  say(
    agentName,
    'searches the 60-item menu for vegan meals with a 250-token budget; the rest waits behind a handle:',
  );
  wire('ASK', `shop.search {tag:"vegan"} budget=250`);

  const menu = (await sh.ask(
    'shop.search',
    { tag: 'vegan' },
    { budget: 250 },
  )) as Answer & { lens: string };

  show(menu.lens);

  if (menu.more?.[0]) {
    wire('EXPAND', `${menu.more[0].handle} budget=200`);
    show((await sh.expand(menu.more[0].handle, { budget: 200 })).lens);
  }

  say(
    agentName,
    `orders 4 meals. It's over the 40.00 USD per-action limit, so no auto-commit, just proposals:`,
  );
  wire(
    'INTENT',
    `shop.order {items:[m005×2, m007×2], deliver:"${day(2)}"} auto`,
  );

  const order = await sh.intent(
    'shop.order',
    {
      items: [
        { sku: 'm005', qty: 2 },
        { sku: 'm007', qty: 2 },
      ],
      deliver: day(2),
    },
    { auto: true },
  );

  show(order.lens);

  if (order.kind === 'PROPOSALS') {
    const pick: Proposal = order.proposals[0];

    say(agentName, `commits [${pick.id}]:`);
    wire('COMMIT', `${pick.id} #${pick.hash.slice(0, 10)}…`);

    const denied = await sh.commit(pick);

    show(denied.lens);

    if (denied.kind === 'ERROR' && denied.consent) {
      say(
        human,
        `(simulated) gets a push notification, reads the exact effects and taps Approve. That signs a one-time consent for this proposal only (hash ${pick.hash.slice(0, 10)}…):`,
      );

      const consent = await consentGrant({
        principal: james,
        agent: agent.public,
        consent: denied.consent,
      });

      wire('COMMIT', `${pick.id} + consent grant`);

      const events: string[] = [];
      const ok = await sh.commit(pick, {
        grants: [consent],
        onEvent: (e) => events.push(e.lens),
      });

      show([...events, ok.lens].join('\n'));
    }
  }

  say(
    agentName,
    'hands a sub-agent a narrower, read-only slice of its authority, offline and without asking the service:',
  );

  const narrowed = await delegateGrant(policy, {
    holder: agent,
    to: helper.public,
    caveats: [
      { verbs: ['HELLO', 'ASK', 'INTENT'] },
      { can: ['shop.search', 'shop.order'] },
    ],
  });
  const sub = await connect(shopUrl, {
    key: helper.seed,
    grants: [narrowed],
    name: 'sub-agent',
  });

  say(subName, 'tries to place an order anyway:');

  const sp = await sub.intent('shop.order', {
    items: [{ sku: 'm001', qty: 1 }],
    deliver: day(2),
  });

  if (sp.kind === 'PROPOSALS') {
    wire('COMMIT', sp.proposals[0].id);
    show((await sub.commit(sp.proposals[0])).lens);
  }

  console.log(
    k(
      `\n✔ done. Every reply above is exactly what a model would read.\n`,
      c.grn,
    ),
  );

  for (const x of [cal, sh, sub]) x.close();

  calSrv.close();
  shopSrv.close();
}
