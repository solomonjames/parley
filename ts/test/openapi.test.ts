import { createServer } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import * as P from '../src/index.js';
import { fromOpenAPI } from '../src/openapi.js';

const spec = {
  openapi: '3.0.0',
  info: { title: 'Todo API', description: 'Tasks.' },
  servers: [{ url: 'http://placeholder' }],
  paths: {
    '/todos': {
      get: {
        operationId: 'listTodos',
        summary: 'List todos',
        parameters: [
          { name: 'done', in: 'query', schema: { type: 'boolean' } },
        ],
      },
      post: {
        operationId: 'createTodo',
        summary: 'Create a todo',
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/NewTodo' },
            },
          },
        },
      },
    },
    '/todos/{id}': {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
      ],
      delete: { operationId: 'deleteTodo', summary: 'Delete a todo' },
    },
  },
  components: {
    schemas: {
      NewTodo: {
        type: 'object',
        required: ['title'],
        properties: {
          id: { type: 'integer', readOnly: true },
          title: { type: 'string' },
          due: { type: 'string', format: 'date' },
        },
      },
    },
  },
};

const calls: string[] = [];
let todos = Array.from({ length: 300 }, (_, i) => ({
  id: i + 1,
  title: `task ${i + 1}`,
  done: i % 3 === 0,
}));
const server = createServer(async (req, res) => {
  let body = '';

  for await (const c of req) body += c;

  calls.push(
    `${req.method} ${req.url} ${body} ${req.headers.authorization ?? ''}`,
  );

  const url = new URL(req.url!, 'http://x');

  res.setHeader('content-type', 'application/json');

  if (req.method === 'GET')
    return res.end(
      JSON.stringify(
        todos.filter(
          (t) =>
            !url.searchParams.has('done') ||
            String(t.done) === url.searchParams.get('done'),
        ),
      ),
    );

  if (req.method === 'POST') {
    const t = { id: todos.length + 1, done: false, ...JSON.parse(body) };

    todos.push(t);

    return res.end(JSON.stringify(t));
  }

  if (req.method === 'DELETE') {
    const id = Number(url.pathname.split('/').pop());

    if (!todos.some((t) => t.id === id))
      return (res.statusCode = 404), res.end('{"error":"no such todo"}');

    todos = todos.filter((t) => t.id !== id);

    return res.end('{}');
  }
});

await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
afterAll(() => server.close());

const base = `http://127.0.0.1:${(server.address() as any).port}`;

describe('OpenAPI adapter', async () => {
  const principal = await P.keyPair(),
    agent = await P.keyPair();
  const svc = fromOpenAPI(spec, {
    baseUrl: base,
    trust: [principal.public],
    headers: { Authorization: 'Bearer secret' },
  });
  const c = new P.Client(P.local(svc), {
    key: agent.seed,
    grants: [await P.issueGrant({ principal, to: agent.public })],
  });

  it('maps GETs to asks and writes to intents, with compact params', async () => {
    const b = await c.hello();

    expect(b.lens).toContain(
      'ask todo_api.listTodos(done?: bool) — List todos',
    );
    expect(b.lens).toContain(
      'intent todo_api.createTodo(title: string, due?: date) — Create a todo [risk:low]',
    );
    expect(b.lens).toContain(
      'intent todo_api.deleteTodo(id: int) — Delete a todo [risk:medium]',
    );
  });

  it('budgets huge upstream responses', async () => {
    const r = await c.ask('todo_api.listTodos', {}, { budget: 200 });

    expect(r.kind).toBe('ANSWER');
    expect(P.est(r.lens)).toBeLessThanOrEqual(200);
    expect(r.lens).toMatch(/more at data/);
  });

  it('writes are previewed, then performed on COMMIT only, with upstream auth hidden from the model', async () => {
    const before = calls.length;
    const p = await c.intent('todo_api.createTodo', {
      title: 'ship parley',
      due: '2030-01-01',
    });

    if (p.kind !== 'PROPOSALS') throw new Error(p.lens);

    expect(calls.length).toBe(before); // INTENT made no upstream call
    expect(p.lens).toContain('+ create');
    expect(p.lens).toContain('"title":"ship parley"');
    expect(p.lens).toContain('undo: never');
    expect(p.lens).not.toContain('secret');

    const r = await c.commit(p.proposals[0]);

    expect(r.kind).toBe('RECEIPT');
    expect(calls.at(-1)).toContain(
      'POST /todos {"title":"ship parley","due":"2030-01-01"} Bearer secret',
    );
  });

  it('maps upstream errors to Parley errors', async () => {
    const p = await c.intent('todo_api.deleteTodo', { id: 99999 });

    if (p.kind !== 'PROPOSALS') throw new Error(p.lens);

    const r = await c.commit(p.proposals[0]);

    expect(r.kind === 'ERROR' && r.code).toBe('not_found');
  });

  it("never auto-commits wrapped writes (they can't be undone)", async () => {
    const r = await c.intent(
      'todo_api.createTodo',
      { title: 'x' },
      { auto: true },
    );

    expect(r.kind).toBe('PROPOSALS');
  });
});

describe('OpenAPI presets and projections', async () => {
  const { projectFields } = await import('../src/openapi.js');
  const { PRESETS, presetOptions } = await import('../src/presets.js');

  it('projects big upstream objects down to table rows', () => {
    const rows = projectFields(
      [
        {
          number: 1,
          title: 't',
          user: { login: 'ana', id: 9 },
          labels: [{ name: 'bug' }, { name: 'ui' }],
          junk: 'x',
        },
      ],
      ['number', 'title', 'author=user.login', 'labels[].name'],
    );

    expect(rows).toEqual([
      { number: 1, title: 't', author: 'ana', labels: 'bug, ui' },
    ]);
    expect(
      projectFields({ total_count: 2, items: [{ a: 1, b: 2 }] }, ['a']),
    ).toEqual({ total: 2, items: [{ a: 1 }] });
  });

  it('the github preset exposes only curated operations with overridden risk', () => {
    const o = presetOptions(PRESETS.github, {} as NodeJS.ProcessEnv);

    expect(o.include!('put', '/x', { operationId: 'pulls/merge' })).toBe(true);
    expect(o.include!('delete', '/x', { operationId: 'repos/delete' })).toBe(
      false,
    );
    expect(o.risk!('put', '/x', { operationId: 'pulls/merge' })).toBe('high');
    expect(o.headers!.authorization).toBeUndefined();
    expect(
      presetOptions(PRESETS.github, { GITHUB_TOKEN: 't' } as any).headers!
        .authorization,
    ).toBe('Bearer t');
  });

  it('risk overrides reach proposals', async () => {
    const principal = await P.keyPair();
    const svc = fromOpenAPI(spec, {
      baseUrl: base,
      trust: [principal.public],
      risk: (_m, _p, op) => (op.operationId === 'createTodo' ? 'high' : 'low'),
    });
    const r = await new P.Client(P.local(svc)).intent('todo_api.createTodo', {
      title: 'x',
    });

    expect(r.kind === 'PROPOSALS' && r.proposals[0].risk).toBe('high');
  });
});
