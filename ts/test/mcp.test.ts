import { PassThrough } from 'node:stream';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { runMcpBridge } from '../src/mcp.js';
import { shop } from '../../examples/shop.ts';

async function bridge(elicit: boolean) {
  process.env.PARLEY_HOME = mkdtempSync(join(tmpdir(), 'parley-'));

  const principal = await P.keyPair(),
    agent = await P.keyPair();

  writeFileSync(join(process.env.PARLEY_HOME, 'principal.key'), principal.seed);

  const grant = await P.issueGrant({
    principal,
    to: agent.public,
    caveats: [{ per: { max: 1000, currency: 'USD' } }],
  });
  const client = new P.Client(P.local(shop({ trust: [principal.public] })), {
    key: agent.seed,
    grants: [grant],
  });
  const input = new PassThrough(),
    output = new PassThrough();
  const done = runMcpBridge([client], { input, output });
  const pending = new Map<number, (m: any) => void>();
  let buf = '';

  output.setEncoding('utf8');
  output.on('data', (c: string) => {
    buf += c;

    let nl;

    while ((nl = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, nl));

      buf = buf.slice(nl + 1);

      if (m.method === 'elicitation/create')
        input.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            result: { action: 'accept', content: { approve: true } },
          })}\n`,
        );
      else pending.get(m.id)?.(m);
    }
  });

  let id = 0;
  const rpc = (method: string, params?: any) =>
    new Promise<any>((res) => {
      pending.set(++id, res);
      input.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });

  await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: elicit ? { elicitation: {} } : {},
  });

  const tool = async (name: string, args: any) =>
    (await rpc('tools/call', { name, arguments: args })).result;

  return { rpc, tool, end: () => (input.end(), done) };
}

describe('MCP bridge', () => {
  it('lists tools and returns Lens; consent via elicitation', async () => {
    const b = await bridge(true);
    const tools = (await b.rpc('tools/list')).result.tools.map(
      (t: any) => t.name,
    );

    expect(tools).toContain('parley_commit');

    const found = await b.tool('parley_ask', {
      service: 'shop.example',
      capability: 'shop.search',
      params: { tag: 'vegan' },
      budget: 200,
    });

    expect(found.content[0].text).toMatch(/^items\[/);

    const props = await b.tool('parley_intent', {
      service: 'shop.example',
      capability: 'shop.order',
      params: { items: [{ sku: 'm001', qty: 2 }], deliver: '2030-01-01' },
    });
    const id = /\[(p_[^\]]+)\]/.exec(props.content[0].text)![1];
    const r = await b.tool('parley_commit', {
      service: 'shop.example',
      proposal: id,
    });

    expect(r.isError).toBeFalsy();
    expect(r.content[0].text).toContain('✓');
    await b.end();
  });

  it('without elicitation, tells the model to have the human approve', async () => {
    const b = await bridge(false);
    const props = await b.tool('parley_intent', {
      service: 'shop.example',
      capability: 'shop.order',
      params: { items: [{ sku: 'm001', qty: 2 }], deliver: '2030-01-01' },
    });
    const id = /\[(p_[^\]]+)\]/.exec(props.content[0].text)![1];
    const r = await b.tool('parley_commit', {
      service: 'shop.example',
      proposal: id,
    });

    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('parley approve');
    await b.end();
  });
});
