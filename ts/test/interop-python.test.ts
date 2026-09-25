// TS client ↔ Python service (python/examples/serve.py). Skipped when uv or python/ is absent.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { connect } from '../src/node.js';

const pyDir = fileURLToPath(new URL('../../python', import.meta.url));
const hasUv = spawnSync('uv', ['--version']).status === 0;
const ready =
  hasUv &&
  existsSync(`${pyDir}/examples/serve.py`) &&
  !process.env.SKIP_INTEROP;
const TCP = 17457,
  HTTP = 18457;

describe.skipIf(!ready)('interop: TS client → Python service', async () => {
  const principal = await P.keyPair(),
    agent = await P.keyPair();
  let proc: ChildProcess;

  beforeAll(async () => {
    proc = spawn('uv', ['run', 'python', 'examples/serve.py'], {
      cwd: pyDir,
      env: {
        ...process.env,
        PARLEY_TRUST: principal.public,
        PARLEY_PORT: String(TCP),
        PARLEY_HTTP_PORT: String(HTTP),
      },
      stdio: 'ignore',
    });

    for (let i = 0; i < 100; i++) {
      try {
        await (
          await fetch(`http://127.0.0.1:${HTTP}/.well-known/parley`)
        ).json();

        return;
      } catch {
        await new Promise((r) => setTimeout(r, 150));
      }
    }

    throw new Error('python service did not start');
  }, 30_000);
  afterAll(() => proc?.kill());

  for (const url of [
    `parley://127.0.0.1:${TCP}`,
    `http://127.0.0.1:${HTTP}/parley`,
  ]) {
    it(`full flow over ${url.split(':')[0]}`, async () => {
      const grant = await P.issueGrant({
        principal,
        to: agent.public,
        caveats: [{ svc: ['calendar.example'] }],
      });
      const c = await connect(url, { key: agent.seed, grants: [grant] });
      const b = await c.hello();

      expect(b.kind).toBe('BRIEF');
      expect(b.lens).toContain('intent calendar.reschedule(');

      const q = await c.intent('calendar.reschedule', { event: 'Ana' });

      if (q.kind !== 'CLARIFY') throw new Error(q.lens);

      const p = await c.intent('calendar.reschedule', {
        event: 'Ana',
        ...q.options[0].params,
        day: '2031-03-04',
      });

      if (p.kind !== 'PROPOSALS') throw new Error(p.lens);

      expect(p.proposals[0].hash).toBe(await P.proposalHash(p.proposals[0]));

      const r = await c.commit(p.proposals[0]);

      if (r.kind !== 'RECEIPT') throw new Error(r.lens);

      const again = await c.commit(p.proposals[0]);

      expect(again.kind === 'RECEIPT' && again.replay).toBe(true);
      expect((await c.undo(r.receipt.id)).kind).toBe('RECEIPT');

      const auto = await c.intent(
        'calendar.reschedule',
        { event: 'e2', day: '2031-03-05' },
        { auto: true },
      );

      expect(auto.kind).toBe('RECEIPT');

      const bad = await c.ask('calendar.agnda');

      expect(bad.kind === 'ERROR' && bad.code).toBe('unknown_capability');
      c.close();
    });
  }
});
