// Hosted Parley demo: the example calendar and shop, one private copy per agent key.
//   https://<worker>/calendar/parley   https://<worker>/shop/parley   (+ /.well-known/parley)
// Each agent key (from the request's proof) gets its own Durable Object, so demo users never
// see each other's data. The demo trusts any principal, so bring your own keys (`parley init`).
import { DurableObject } from 'cloudflare:workers';
import { fetchHandler, type Service } from 'parley-protocol';
import { calendar, shop } from 'parley-protocol/examples';

interface Env {
  DEMO: DurableObjectNamespace<ParleyDemo>;
}

const SERVICES = {
  calendar: () => calendar({ trust: () => true }),
  shop: () => shop({ trust: () => true }),
};

type Name = keyof typeof SERVICES;

const MAX_FRAME = 1 << 20;

export class ParleyDemo extends DurableObject<Env> {
  private handlers = new Map<Name, (r: Request) => Promise<Response>>();
  async fetch(req: Request): Promise<Response> {
    const name = new URL(req.url).pathname.split('/')[1] as Name;
    let h = this.handlers.get(name);

    if (!h) {
      const svc: Service = SERVICES[name]();

      h = fetchHandler(svc, { path: `/${name}/parley` });
      this.handlers.set(name, h);
    }

    return h(req);
  }
}

const HOME = `Parley demo services
  calendar  /calendar/parley
  shop      /shop/parley
Use from Claude Code:
  npx parley-protocol init && npx parley-protocol grant --risk low --per 40USD --spend 100USD --exp 24h
  claude mcp add parley-demo -- npx parley-protocol mcp <this-origin>/calendar/parley <this-origin>/shop/parley
https://github.com/solomonjames/parley
`;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const name = url.pathname.split('/')[1];

    if (!(name in SERVICES))
      return new Response(HOME.replaceAll('<this-origin>', url.origin), {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });

    let key = 'public';
    let body: string | undefined;

    if (req.method === 'POST') {
      body = await req.text();

      if (body.length > MAX_FRAME)
        return new Response('frame exceeds 1 MiB', { status: 413 });

      try {
        const k = JSON.parse(body)?.proof?.key;

        if (typeof k === 'string' && k.length < 100) key = k;
      } catch {}
    }

    const stub = env.DEMO.get(env.DEMO.idFromName(`${name}:${key}`));

    return stub.fetch(
      new Request(req.url, { method: req.method, headers: req.headers, body }),
    );
  },
};
