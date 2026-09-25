/** HTTP bridge server side (SPEC §2.4) as a standard fetch handler: Workers, Bun, Deno, Node. */
import type { Service } from './service.js';

const MAX_FRAME = 1 << 20;

export function fetchHandler(svc: Service, o: { path?: string } = {}) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const endpoint = o.path ?? '/parley';

    if (
      req.method === 'GET' &&
      (url.pathname === '/.well-known/parley' || url.pathname === endpoint)
    ) {
      const budget = Number(url.searchParams.get('budget')) || undefined;

      return Response.json({ ...svc.brief(budget), endpoint });
    }

    if (req.method !== 'POST' || url.pathname !== endpoint)
      return new Response('not a parley endpoint', { status: 404 });

    if (Number(req.headers.get('content-length') ?? 0) > MAX_FRAME)
      return new Response('frame exceeds 1 MiB', { status: 413 });

    let frame: unknown = null;

    try {
      const text = await req.text();

      if (new TextEncoder().encode(text).length > MAX_FRAME)
        return new Response('frame exceeds 1 MiB', { status: 413 });

      frame = JSON.parse(text);
    } catch {}

    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        const re =
          typeof (frame as any)?.id === 'string' ? (frame as any).id : '?';

        try {
          const final = await svc.handle(frame, (e) =>
            ctrl.enqueue(enc.encode(`${JSON.stringify(e)}\n`)),
          );

          ctrl.enqueue(enc.encode(`${JSON.stringify(final)}\n`));
        } catch {
          ctrl.enqueue(
            enc.encode(
              `${JSON.stringify({
                parley: 1,
                id: 's_err',
                re,
                kind: 'ERROR',
                code: 'internal',
                message: 'reply could not be serialized',
              })}\n`,
            ),
          );
        }

        ctrl.close();
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'application/x-ndjson',
        'cache-control': 'no-store',
      },
    });
  };
}
