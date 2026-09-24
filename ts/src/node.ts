/** Node transports: TCP (parley://), TLS (parleys://), stdio, and an HTTP bridge server. */
import { spawn } from "node:child_process";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import net from "node:net";
import tls from "node:tls";
import { Client, http, lines, type ClientOptions, type Transport } from "./client.js";
import { fetchHandler } from "./http.js";
import type { Service } from "./service.js";

export const DEFAULT_PORT = 7447;
export const DEFAULT_TLS_PORT = 7448;
const MAX_FRAME = 1 << 20;

/** Serve NDJSON frames on a duplex stream. Requests are handled concurrently. */
export function serveStream(svc: Service, input: NodeJS.ReadableStream, write: (s: string) => void) {
  let buf = "";
  input.setEncoding?.("utf8");
  input.on("data", (chunk: string) => {
    buf += chunk;
    if (buf.length > MAX_FRAME && buf.indexOf("\n") < 0) {
      write(JSON.stringify({ parley: 1, id: "s_overflow", re: "?", kind: "ERROR", code: "bad_frame", message: "frame exceeds 1 MiB" }) + "\n");
      buf = "";
      return;
    }
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let frame: unknown = null;
      try {
        frame = JSON.parse(line);
      } catch {}
      svc.handle(frame, (e) => write(JSON.stringify(e) + "\n")).then((r) => write(JSON.stringify(r) + "\n"));
    }
  });
}

/** Listen for parley:// (TCP) or, with `tls` options, parleys:// connections. */
export function listen(svc: Service, o: { port?: number; host?: string; tls?: tls.TlsOptions } = {}): Promise<net.Server> {
  const onConn = (sock: net.Socket) => {
    sock.on("error", () => {});
    serveStream(svc, sock, (s) => sock.writable && sock.write(s));
  };
  const server = o.tls ? tls.createServer(o.tls, onConn) : net.createServer(onConn);
  return new Promise((resolve) => server.listen(o.port ?? (o.tls ? DEFAULT_TLS_PORT : DEFAULT_PORT), o.host ?? "127.0.0.1", () => resolve(server)));
}

/** Serve over this process's stdin/stdout (for locally spawned services). */
export function serveStdio(svc: Service) {
  serveStream(svc, process.stdin, (s) => process.stdout.write(s));
}

/** Serve the HTTP bridge on Node's http module. */
export function serveHttp(svc: Service, o: { port?: number; host?: string; path?: string } = {}): Promise<HttpServer> {
  const handler = fetchHandler(svc, { path: o.path });
  const server = createHttpServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://${req.headers.host ?? "localhost"}${req.url}`;
    const body = req.method === "POST" ? Buffer.concat(chunks) : undefined;
    const r = await handler(new Request(url, { method: req.method, headers: req.headers as Record<string, string>, body }));
    res.writeHead(r.status, Object.fromEntries(r.headers));
    if (r.body) for await (const c of r.body as any) res.write(c);
    res.end();
  });
  return new Promise((resolve) => server.listen(o.port ?? 8080, o.host ?? "127.0.0.1", () => resolve(server)));
}

function socketTransport(sock: net.Socket): Transport {
  const t = lines((s) => sock.write(s), () => sock.end());
  sock.setEncoding("utf8");
  sock.on("data", (c: string) => t.feed(c));
  sock.on("error", (e) => t.fail(e));
  sock.on("close", () => t.fail(new Error("connection closed")));
  return t;
}

/** Open a transport from a URL: parley://, parleys://, http(s)://, or stdio:<command>. */
export async function transport(url: string, o: { tls?: tls.ConnectionOptions } = {}): Promise<Transport> {
  if (url.startsWith("http://") || url.startsWith("https://")) return http(url);
  if (url.startsWith("stdio:")) {
    const [cmd, ...args] = url.slice(6).trim().split(/\s+/);
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "inherit"] });
    const t = lines((s) => child.stdin.write(s), () => child.kill());
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => t.feed(c));
    child.on("exit", () => t.fail(new Error("service process exited")));
    return t;
  }
  const u = new URL(url);
  const secure = u.protocol === "parleys:";
  if (!secure && u.protocol !== "parley:") throw new Error(`unsupported URL ${url}`);
  const port = Number(u.port) || (secure ? DEFAULT_TLS_PORT : DEFAULT_PORT);
  const sock: net.Socket = await new Promise((resolve, reject) => {
    const s = secure ? tls.connect({ host: u.hostname, port, servername: u.hostname, ...o.tls }, () => resolve(s)) : net.connect({ host: u.hostname, port }, () => resolve(s));
    s.once("error", reject);
  });
  return socketTransport(sock);
}

/** Connect a client to a Parley service by URL. */
export async function connect(url: string, opts: ClientOptions & { tls?: tls.ConnectionOptions } = {}): Promise<Client> {
  return new Client(await transport(url, { tls: opts.tls }), opts);
}
