/**
 * MCP bridge: expose YEA services as an MCP server over stdio, so any MCP client
 * (Claude Code, Claude Desktop, Cursor, …) can speak YEA today. Tool results are Lens.
 * Consent requests are routed to the human via MCP elicitation when the client supports
 * it; the model itself can never approve.
 */

import type { Client } from './client.js';
import { createToolHost, TOOLS, type ToolHost } from './tools.js';

export { INSTRUCTIONS, TOOLS } from './tools.js';

const VERSION = '0.1.0';

type Json = Record<string, unknown>;

/** A JSON-RPC message in either direction: a request, a notification or a reply. */
interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: InitializeParams & Partial<ToolCallParams>;
  result?: Json;
}

interface InitializeParams {
  capabilities?: Json;
  protocolVersion?: string;
}

interface ToolCallParams {
  name: string;
  arguments?: Json;
}

interface ElicitResult {
  action?: string;
  content?: { approve?: unknown };
}

type Write = (m: Json) => void;

/** What a request handler needs from the running bridge. */
interface Session {
  host: ToolHost;
  write: Write;
  clientCaps: Json;
}

export async function runMcpBridge(
  clients: Client[],
  io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream } = {
    input: process.stdin,
    output: process.stdout,
  },
) {
  const write: Write = (m) => {
    io.output.write(`${JSON.stringify(m)}\n`);
  };
  const outgoing = outgoingRequests(write);
  // Consent goes to the human through MCP elicitation, when the client supports it.
  const host = await createToolHost(
    clients,
    async ({ service, shown, reason }) => {
      if (!session.clientCaps.elicitation) {
        return false;
      }

      const res = await outgoing.request(
        'elicitation/create',
        elicitation(
          `Approve this action at ${service}?\n\n${shown}\n\nWhy you're asked: ${reason}`,
        ),
      );
      const result = res.result as ElicitResult | undefined;

      return result?.action === 'accept' && result?.content?.approve === true;
    },
  );
  const session: Session = { host, write, clientCaps: {} };

  await new Promise<void>((resolve) => {
    let inflight = 0;
    let ended = false;
    const maybeExit = () => {
      if (ended && inflight === 0) {
        host.close();
        resolve();
      }
    };

    io.input.on('end', () => {
      ended = true;
      maybeExit();
    });
    onLines(io.input, (line) => {
      const m = parseMessage(line);

      if (m === undefined || outgoing.settle(m)) {
        return;
      }

      inflight++;
      void handle(m, session).finally(() => {
        inflight--;
        maybeExit();
      });
    });
  });
}

/** Call `onLine` for each non-empty, newline-delimited line read from `input`. */
function onLines(input: NodeJS.ReadableStream, onLine: (line: string) => void) {
  let buf = '';

  input.setEncoding?.('utf8');
  input.on('data', (chunk: string) => {
    buf += chunk;

    for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
      const line = buf.slice(0, nl).trim();

      buf = buf.slice(nl + 1);

      if (line) {
        onLine(line);
      }
    }
  });
}

/** Parse one line; undefined when it isn't JSON (such lines are ignored). */
function parseMessage(line: string): RpcMessage | undefined {
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

/** Prefix of the ids on our own requests to the client, so their replies can be told apart. */
const OUR_ID = 'yea-';

/** Our own requests to the client (ids `yea-N`) and the matching of their replies. */
function outgoingRequests(write: Write) {
  let nextId = 1;
  const waiting = new Map<number, (r: RpcMessage) => void>();

  const request = (method: string, params: Json, timeoutMs = 10 * 60_000) =>
    new Promise<RpcMessage>((resolve) => {
      const id = nextId++;
      // no answer = no approval
      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve({});
      }, timeoutMs);

      waiting.set(id, (r) => {
        clearTimeout(timer);
        waiting.delete(id);
        resolve(r);
      });
      write({ jsonrpc: '2.0', id: `${OUR_ID}${id}`, method, params });
    });

  /** If `m` is a reply to one of our requests, deliver it and return true. */
  const settle = (m: RpcMessage) => {
    if (typeof m.id !== 'string' || !m.id.startsWith(OUR_ID) || m.method) {
      return false;
    }

    waiting.get(Number(m.id.slice(OUR_ID.length)))?.(m);

    return true;
  };

  return { request, settle };
}

function elicitation(message: string): Json {
  return {
    message,
    requestedSchema: {
      type: 'object',
      properties: {
        approve: {
          type: 'boolean',
          title: 'Approve',
          description: 'Sign a one-time consent for exactly this proposal',
        },
      },
      required: ['approve'],
    },
  };
}

async function handle(m: RpcMessage, s: Session) {
  const reply = (result: Json) => s.write({ jsonrpc: '2.0', id: m.id, result });

  switch (m.method) {
    case 'initialize':
      s.clientCaps = m.params?.capabilities ?? {};

      return reply({
        protocolVersion: m.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'yea-bridge', version: VERSION },
        instructions: s.host.instructions,
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS });
    case 'tools/call':
      return reply(await callTool(s.host, m.params as ToolCallParams));
    default:
      if (m.id !== undefined) {
        s.write({
          jsonrpc: '2.0',
          id: m.id,
          error: { code: -32601, message: `method not found: ${m.method}` },
        });
      }
  }
}

/** Run a tools/call; any failure (even malformed params) becomes a tool error, not a crash. */
async function callTool(host: ToolHost, params: ToolCallParams): Promise<Json> {
  try {
    const r = await host.call(params.name, params.arguments ?? {});

    return {
      content: [{ type: 'text', text: r.text }],
      ...(r.isError ? { isError: true } : {}),
    };
  } catch (e) {
    return {
      content: [{ type: 'text', text: `✗ transport: ${(e as Error).message}` }],
      isError: true,
    };
  }
}
