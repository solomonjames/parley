import { afterAll, describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { connect, listen, serveHttp } from '../src/node.js';
import { calendar } from '../../examples/calendar.ts';

const closers: (() => void)[] = [];

afterAll(() => closers.forEach((c) => c()));

describe('transports', async () => {
  const principal = await P.keyPair();
  const agent = await P.keyPair();
  const grant = await P.issueGrant({ principal, to: agent.public });

  it('TCP (parley://) with multiplexed requests', async () => {
    const server = await listen(calendar({ trust: [principal.public] }), {
      port: 0,
    });

    closers.push(() => server.close());

    const port = (server.address() as any).port;
    const c = await connect(`parley://127.0.0.1:${port}`, {
      key: agent.seed,
      grants: [grant],
    });

    closers.push(() => c.close());

    const [a, b, h] = await Promise.all([
      c.ask('calendar.agenda'),
      c.ask('calendar.free', { day: '2030-01-01' }),
      c.hello(),
    ]);

    expect([a.kind, b.kind, h.kind]).toEqual(['ANSWER', 'ANSWER', 'BRIEF']);

    const p = await c.intent('calendar.cancel', { event: 'e1' });

    if (p.kind !== 'PROPOSALS') throw new Error(p.lens);

    expect((await c.commit(p.proposals[0])).kind).toBe('RECEIPT');
  });

  it('HTTP bridge with discovery', async () => {
    const server = await serveHttp(calendar({ trust: [principal.public] }), {
      port: 0,
    });

    closers.push(() => server.close());

    const port = (server.address() as any).port;
    const disc = await (
      await fetch(`http://127.0.0.1:${port}/.well-known/parley`)
    ).json();

    expect(disc.kind).toBe('BRIEF');
    expect(disc.endpoint).toBe('/parley');

    const c = await connect(`http://127.0.0.1:${port}/parley`, {
      key: agent.seed,
      grants: [grant],
    });
    const p = await c.intent('calendar.cancel', { event: 'e1' });

    if (p.kind !== 'PROPOSALS') throw new Error(p.lens);

    expect((await c.commit(p.proposals[0])).kind).toBe('RECEIPT');
  });

  it('bad frames get bad_frame errors', async () => {
    const svc = calendar({ trust: [] });

    expect((await svc.handle({ nope: 1 })).kind).toBe('ERROR');
    expect(
      (
        (await svc.handle({
          parley: 1,
          id: 'x',
          verb: 'PATCH',
        })) as P.ErrorReply
      ).code,
    ).toBe('bad_frame');
  });
});
