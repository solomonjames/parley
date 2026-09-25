/**
 * OpenAPI → Parley. Wrap any existing REST API as a Parley service:
 *   GET operations            → ASK capabilities (read-only, budgeted, Lens)
 *   POST/PUT/PATCH/DELETE     → INTENT capabilities whose proposal shows the exact request
 *                               (method, URL, body) as its effect; COMMIT performs it.
 * REST calls can't be undone generically, so wrapped writes are irreversible and are
 * never auto-committed. Grants, spend caps and consent all apply unchanged.
 */
import { ParleyError } from './errors.js';
import { service, type Plan, type Service } from './service.js';
import type { Effect, ParamSchema, Risk } from './types.js';

type Json = Record<string, any>;

export interface OpenApiOptions {
  /** Base URL of the API (default: the spec's first server). */
  baseUrl?: string;
  /** Service id / audience (default: the API's host). */
  id?: string;
  /** Headers sent on every upstream call, e.g. { Authorization: "Bearer …" }. Never shown to the model. */
  headers?: Record<string, string>;
  /** Principals allowed to authorize writes. */
  trust?: string[] | ((principal: string) => boolean);
  /** Capability name prefix (default: a slug of the API title). */
  prefix?: string;
  /** Override the risk assessed for a write operation. Default: DELETE → medium, others low. */
  risk?: (method: string, path: string, op: Json) => Risk;
  /** Only expose operations for which this returns true. */
  include?: (method: string, path: string, op: Json) => boolean;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Keep only these fields of an operation's response (keyed by operationId). Each entry is
   * `path` or `outKey=path`; `a.b` descends, `list[].x` maps over an array (joined with ", ").
   * Big upstream objects become compact Lens tables.
   */
  project?: Record<string, string[]>;
}

function pluck(v: any, path: string): unknown {
  const [head, ...rest] = path.split('.');

  if (head.endsWith('[]')) {
    const arr = v?.[head.slice(0, -2)];

    if (!Array.isArray(arr)) return null;

    const vals = arr
      .map((x) => (rest.length ? pluck(x, rest.join('.')) : x))
      .filter((x) => x !== null && x !== undefined);

    return vals.join(', ');
  }

  const next = v?.[head];

  return rest.length ? pluck(next, rest.join('.')) : (next ?? null);
}

export function projectFields(data: unknown, fields: string[]): unknown {
  const one = (o: any) =>
    Object.fromEntries(
      fields.map((f) => {
        const [k, p] = f.includes('=')
          ? f.split('=')
          : [
              f.includes('[]')
                ? f.split('[]')[0].split('.').pop()!
                : f.split('.').pop()!,
              f,
            ];

        return [k, pluck(o, p)];
      }),
    );

  if (Array.isArray(data)) return data.map(one);

  if (data && typeof data === 'object' && Array.isArray((data as any).items))
    return {
      ...('total_count' in (data as any)
        ? { total: (data as any).total_count }
        : {}),
      items: (data as any).items.map(one),
    };

  return data && typeof data === 'object' ? one(data) : data;
}

const WRITE: Record<string, Effect['op']> = {
  post: 'create',
  put: 'update',
  patch: 'update',
  delete: 'delete',
};
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '') || 'api';

function resolve(spec: Json, v: any, depth = 0): any {
  if (!v || typeof v !== 'object' || depth > 20) return v;

  if (typeof v.$ref === 'string' && v.$ref.startsWith('#/')) {
    const target = v.$ref
      .slice(2)
      .split('/')
      .reduce(
        (o: any, k: string) => o?.[k.replace(/~1/g, '/').replace(/~0/g, '~')],
        spec,
      );

    return resolve(spec, target, depth + 1);
  }

  return v;
}

/** JSON Schema → compact type string (SPEC §4.1.1). Lossy by design. */
function typeOf(spec: Json, schema: any, depth = 0): string {
  const s = resolve(spec, schema) ?? {};

  if (
    Array.isArray(s.enum) &&
    s.enum.length &&
    s.enum.length <= 12 &&
    s.enum.every((x: unknown) => typeof x === 'string' && !x.includes('|'))
  )
    return s.enum.join('|');

  switch (s.type) {
    case 'integer':
      return 'int';
    case 'number':
      return 'number';
    case 'boolean':
      return 'bool';
    case 'string':
      return s.format === 'date'
        ? 'date'
        : s.format === 'date-time'
          ? 'datetime'
          : 'string';
    case 'array':
      return depth < 2 ? `${typeOf(spec, s.items, depth + 1)}[]` : 'any';
    default:
      return 'any';
  }
}

/** First sentence of a description, cut at a word boundary: a hint for the model, not docs. */
const describe = (t: string, d?: string) => {
  let text = (d ?? '')
    .replace(/\s+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim()
    .split(/(?<=\.)\s/)[0]
    .replace(/\.$/, '');

  if (text.length > 48) text = `${text.slice(0, 48).replace(/\s+\S*$/, '')}…`;

  return text ? `${t} — ${text}` : t;
};

interface Op {
  id?: string;
  raw: Json;
  method: string;
  path: string;
  name: string;
  summary: string;
  pathParams: string[];
  queryParams: string[];
  bodyKeys: string[] | 'whole' | null;
  params: ParamSchema;
}

function operations(spec: Json, o: OpenApiOptions, prefix: string): Op[] {
  const out: Op[] = [];
  const used = new Set<string>();

  for (const [path, item] of Object.entries<Json>(spec.paths ?? {})) {
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
      const op = item?.[method];

      if (!op || (o.include && !o.include(method, path, op))) continue;

      const base =
        typeof op.operationId === 'string' &&
        /^[A-Za-z][A-Za-z0-9_]*$/.test(op.operationId)
          ? op.operationId
          : slug(op.operationId ?? `${method}_${path}`);
      let name = `${prefix}.${base}`;

      for (let i = 2; used.has(name); i++) name = `${prefix}.${base}${i}`;

      used.add(name);

      const params: ParamSchema = {};
      const pathParams: string[] = [],
        queryParams: string[] = [];

      for (const raw of [
        ...(item.parameters ?? []),
        ...(op.parameters ?? []),
      ]) {
        const p = resolve(spec, raw);

        if (!p?.name || (p.in !== 'path' && p.in !== 'query')) continue;

        (p.in === 'path' ? pathParams : queryParams).push(p.name);
        params[p.name + (p.required || p.in === 'path' ? '' : '?')] = describe(
          typeOf(spec, p.schema),
          p.description,
        );
      }

      let bodyKeys: Op['bodyKeys'] = null;
      const body = resolve(spec, op.requestBody);
      const schema = resolve(spec, body?.content?.['application/json']?.schema);

      if (schema) {
        if (schema.type === 'object' || schema.properties) {
          const req = new Set<string>(schema.required ?? []);

          bodyKeys = [];

          for (const [k, v] of Object.entries<Json>(schema.properties ?? {})) {
            if (resolve(spec, v)?.readOnly) continue;

            if (pathParams.includes(k) || queryParams.includes(k)) continue; // the URL parameter already carries it

            bodyKeys.push(k);
            params[k + (req.has(k) ? '' : '?')] = describe(
              typeOf(spec, v),
              resolve(spec, v)?.description,
            );
          }
        } else {
          bodyKeys = 'whole';
          params[body.required ? 'body' : 'body?'] = describe(
            typeOf(spec, schema),
            'request body',
          );
        }
      }

      const summary = (
        op.summary ??
        op.description ??
        `${method.toUpperCase()} ${path}`
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 90);

      out.push({
        id: op.operationId,
        raw: op,
        method,
        path,
        name,
        summary,
        pathParams,
        queryParams,
        bodyKeys,
        params,
      });
    }
  }

  return out;
}

/** Build a Parley service from an OpenAPI 3 document (JSON object). */
export function fromOpenAPI(spec: Json, o: OpenApiOptions = {}): Service {
  const baseUrl = (o.baseUrl ?? spec.servers?.[0]?.url ?? '').replace(
    /\/$/,
    '',
  );

  if (!/^https?:\/\//.test(baseUrl))
    throw new Error(
      'OpenAPI adapter needs an absolute baseUrl (spec has no absolute servers[0].url)',
    );

  const host = new URL(baseUrl).host;
  const title = spec.info?.title ?? host;
  const prefix = o.prefix ?? slug(title).split('_').slice(0, 2).join('_');
  const doFetch = o.fetch ?? fetch;
  const svc = service({
    id: o.id ?? host,
    name: title,
    summary: (spec.info?.description ?? `${title} (via OpenAPI)`)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 200),
    trust: o.trust ?? [],
  });

  const build = (op: Op, params: Json) => {
    let path = op.path;

    for (const k of op.pathParams) {
      if (params[k] === undefined)
        throw new ParleyError(
          'invalid_params',
          `missing path parameter \`${k}\``,
        );

      path = path.replace(`{${k}}`, encodeURIComponent(String(params[k])));
    }

    const url = new URL(baseUrl + path);

    for (const k of op.queryParams)
      if (params[k] !== undefined)
        url.searchParams.set(
          k,
          Array.isArray(params[k]) ? params[k].join(',') : String(params[k]),
        );

    let body: unknown;

    if (op.bodyKeys === 'whole') body = params.body;
    else if (op.bodyKeys)
      body = Object.fromEntries(
        op.bodyKeys
          .filter((k) => params[k] !== undefined)
          .map((k) => [k, params[k]]),
      );

    return { url, body };
  };

  const call = async (method: string, url: URL, body: unknown) => {
    let res: Response;

    try {
      res = await doFetch(url, {
        method: method.toUpperCase(),
        headers: {
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...o.headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(o.timeoutMs ?? 30_000),
      });
    } catch (e) {
      throw new ParleyError(
        'unavailable',
        `upstream request failed: ${(e as Error).message}`,
        { retry: 5 },
      );
    }

    const text = await res.text();
    let data: unknown = text;

    try {
      data = text ? JSON.parse(text) : null;
    } catch {}

    if (!res.ok) {
      const code =
        res.status === 404
          ? 'not_found'
          : res.status === 401 || res.status === 403
            ? 'forbidden'
            : res.status === 409
              ? 'conflict'
              : res.status === 429
                ? 'limit'
                : res.status < 500
                  ? 'invalid_params'
                  : 'unavailable';

      throw new ParleyError(
        code,
        `upstream ${res.status}: ${typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data).slice(0, 200)}`,
      );
    }

    return data;
  };

  const shape = (op: Op, data: unknown) =>
    op.id && o.project?.[op.id] ? projectFields(data, o.project[op.id]) : data;

  for (const op of operations(spec, o, prefix)) {
    const params = Object.keys(op.params).length ? op.params : undefined;

    if (op.method === 'get') {
      svc.ask(op.name, {
        summary: op.summary,
        params,
        run: async ({ params: p }) => {
          const { url } = build(op, p);

          return shape(op, await call('get', url, undefined));
        },
      });
    } else {
      const risk =
        o.risk?.(op.method, op.path, op.raw) ??
        (op.method === 'delete' ? 'medium' : 'low');

      svc.intent(op.name, {
        summary: op.summary,
        params,
        risk,
        plan: ({ params: p }): Plan => {
          const { url, body } = build(op, p);
          const shown = url.pathname + url.search;

          return {
            summary: `${op.method.toUpperCase()} ${shown}`,
            effects: [
              {
                op: WRITE[op.method] ?? 'other',
                target: `${url.host}${url.pathname}`,
                detail:
                  body !== undefined
                    ? `body ${JSON.stringify(body).slice(0, 160)}`
                    : `${op.method.toUpperCase()} request`,
              },
            ],
            risk,
            apply: async () => shape(op, await call(op.method, url, body)),
          };
        },
      });
    }
  }

  return svc;
}

/** Load a spec from a URL or file path (JSON; YAML only if you pass a parsed object). */
export async function loadOpenAPI(source: string): Promise<Json> {
  let text: string;

  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source, { signal: AbortSignal.timeout(30_000) });

    if (!r.ok) throw new Error(`fetching ${source}: HTTP ${r.status}`);

    text = await r.text();
  } else {
    const { readFile } = await import('node:fs/promises');

    text = await readFile(source, 'utf8');
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      'the OpenAPI document must be JSON (convert YAML first, e.g. with `npx js-yaml spec.yaml > spec.json`)',
    );
  }
}
