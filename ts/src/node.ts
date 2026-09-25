/** Node transports: TCP (parley://), TLS (parleys://), stdio, and an HTTP bridge server. */
import { spawn } from 'node:child_process';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
} from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import {
  Client,
  http,
  lines,
  type ClientOptions,
  type Transport,
} from './client.js';
import { fetchHandler } from './http.js';
import type { Service } from './service.js';

export const DEFAULT_PORT = 7447;
export const DEFAULT_TLS_PORT = 7448;

const MAX_FRAME = 1 << 20;

const MAX_INFLIGHT = 64;
const errFrame = (message: string, code = 'bad_frame') =>
  `${JSON.stringify({
    parley: 1,
    id: 's_err',
    re: '?',
    kind: 'ERROR',
    code,
    message,
  })}\n`;

/** Serve NDJSON frames on a duplex stream. Requests are handled concurrently, up to MAX_INFLIGHT. */
export function serveStream(
  svc: Service,
  input: NodeJS.ReadableStream,
  write: (s: string) => void,
) {
  let buf = '';
  let discarding = false; // after an oversized frame, drop input until the next newline
  let inflight = 0;
  const send = (s: string) => {
    try {
      write(s);
    } catch {}
  };

  input.setEncoding?.('utf8');
  input.on('error', () => {});
  input.on('data', (chunk: string) => {
    buf += chunk;

    for (;;) {
      const nl = buf.indexOf('\n');

      if (nl < 0) {
        if (Buffer.byteLength(buf) > MAX_FRAME) {
          if (!discarding) send(errFrame('frame exceeds 1 MiB'));

          discarding = true;
          buf = '';
        }

        return;
      }

      const line = buf.slice(0, nl).trim();

      buf = buf.slice(nl + 1);

      if (discarding) {
        discarding = false;

        continue;
      }

      if (!line) continue;

      if (Buffer.byteLength(line) > MAX_FRAME) {
        send(errFrame('frame exceeds 1 MiB'));

        continue;
      }

      let frame: any = null;

      try {
        frame = JSON.parse(line);
      } catch {}

      if (inflight >= MAX_INFLIGHT) {
        send(
          `${JSON.stringify({
            parley: 1,
            id: 's_busy',
            re: typeof frame?.id === 'string' ? frame.id : '?',
            kind: 'ERROR',
            code: 'limit',
            message: `more than ${MAX_INFLIGHT} requests in flight on this connection`,
            retry: 1,
          })}\n`,
        );

        continue;
      }

      inflight++;
      svc
        .handle(frame, (e) => send(`${JSON.stringify(e)}\n`))
        .then((r) => send(`${JSON.stringify(r)}\n`))
        .catch(() =>
          send(
            `${JSON.stringify({
              parley: 1,
              id: 's_err',
              re: typeof frame?.id === 'string' ? frame.id : '?',
              kind: 'ERROR',
              code: 'internal',
              message: 'reply could not be serialized',
            })}\n`,
          ),
        )
        .finally(() => inflight--);
    }
  });
}

/** Listen for parley:// (TCP) or, with `tls` options, parleys:// connections. */
export function listen(
  svc: Service,
  o: { port?: number; host?: string; tls?: tls.TlsOptions } = {},
): Promise<net.Server> {
  const onConn = (sock: net.Socket) => {
    sock.on('error', () => {});
    serveStream(svc, sock, (s) => sock.writable && sock.write(s));
  };
  const server = o.tls
    ? tls.createServer(o.tls, onConn)
    : net.createServer(onConn);

  return new Promise((resolve) =>
    server.listen(
      o.port ?? (o.tls ? DEFAULT_TLS_PORT : DEFAULT_PORT),
      o.host ?? '127.0.0.1',
      () => resolve(server),
    ),
  );
}

/** Serve over this process's stdin/stdout (for locally spawned services). */
export function serveStdio(svc: Service) {
  serveStream(svc, process.stdin, (s) => process.stdout.write(s));
}

/** Serve the HTTP bridge on Node's http module. */
export function serveHttp(
  svc: Service,
  o: { port?: number; host?: string; path?: string } = {},
): Promise<HttpServer> {
  const handler = fetchHandler(svc, { path: o.path });
  const server = createHttpServer(async (req, res) => {
    req.on('error', () => {});

    try {
      const chunks: Buffer[] = [];
      let size = 0;

      for await (const c of req) {
        size += (c as Buffer).length;

        if (size > MAX_FRAME) {
          res.writeHead(413).end('frame exceeds 1 MiB');
          req.destroy();

          return;
        }

        chunks.push(c as Buffer);
      }

      const url = new URL(req.url ?? '/', 'http://localhost'); // never trust the Host header for parsing
      const body = req.method === 'POST' ? Buffer.concat(chunks) : undefined;
      const r = await handler(new Request(url, { method: req.method, body }));

      res.writeHead(r.status, Object.fromEntries(r.headers));

      if (r.body) for await (const c of r.body as any) res.write(c);

      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(400);

      res.end();
    }
  });

  return new Promise((resolve) =>
    server.listen(o.port ?? 8080, o.host ?? '127.0.0.1', () => resolve(server)),
  );
}

function socketTransport(sock: net.Socket): Transport {
  const t = lines(
    (s) => sock.write(s),
    () => sock.end(),
  );

  sock.setEncoding('utf8');
  sock.on('data', (c: string) => t.feed(c));
  sock.on('error', (e) => t.fail(e));
  sock.on('close', () => t.fail(new Error('connection closed')));

  return t;
}

/** Open a transport from a URL: parley://, parleys://, http(s)://, or stdio:<command>. */
export async function transport(
  url: string,
  o: { tls?: tls.ConnectionOptions } = {},
): Promise<Transport> {
  if (url.startsWith('http://') || url.startsWith('https://')) return http(url);

  if (url.startsWith('stdio:')) {
    const [cmd, ...args] = url.slice(6).trim().split(/\s+/);
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'inherit'] });
    const t = lines(
      (s) => child.stdin.write(s),
      () => child.kill(),
    );

    child.on('error', (e) => t.fail(e));
    child.stdin.on('error', () => {});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (c: string) => t.feed(c));
    child.on('exit', () => t.fail(new Error('service process exited')));

    return t;
  }

  const u = new URL(url);
  const secure = u.protocol === 'parleys:';

  if (!secure && u.protocol !== 'parley:')
    throw new Error(`unsupported URL ${url}`);

  const port = Number(u.port) || (secure ? DEFAULT_TLS_PORT : DEFAULT_PORT);
  const sock: net.Socket = await new Promise((resolve, reject) => {
    const s = secure
      ? tls.connect(
          { host: u.hostname, port, servername: u.hostname, ...o.tls },
          () => resolve(s),
        )
      : net.connect({ host: u.hostname, port }, () => resolve(s));

    s.once('error', reject);
  });

  return socketTransport(sock);
}

/** Connect a client to a Parley service by URL. */
export async function connect(
  url: string,
  opts: ClientOptions & { tls?: tls.ConnectionOptions } = {},
): Promise<Client> {
  return new Client(await transport(url, { tls: opts.tls }), opts);
}
