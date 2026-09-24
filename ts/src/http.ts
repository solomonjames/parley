/** HTTP bridge server side (SPEC §2.4) as a standard fetch handler: Workers, Bun, Deno, Node. */
import type { Service } from "./service.js";

export function fetchHandler(svc: Service, o: { path?: string } = {}) {
  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    const endpoint = o.path ?? "/parley";
    if (req.method === "GET" && (url.pathname === "/.well-known/parley" || url.pathname === endpoint)) {
      const budget = Number(url.searchParams.get("budget")) || undefined;
      return Response.json({ ...svc.brief(budget), endpoint });
    }
    if (req.method !== "POST" || url.pathname !== endpoint) return new Response("not a parley endpoint", { status: 404 });
    let frame: unknown;
    try {
      frame = await req.json();
    } catch {
      frame = null;
    }
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      async start(ctrl) {
        const final = await svc.handle(frame, (e) => ctrl.enqueue(enc.encode(JSON.stringify(e) + "\n")));
        ctrl.enqueue(enc.encode(JSON.stringify(final) + "\n"));
        ctrl.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "cache-control": "no-store" } });
  };
}
