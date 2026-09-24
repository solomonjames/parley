/** Light validation of params against the compact schema (SPEC §4.1.1), producing teaching errors. */
import { ParleyError, fix } from "./errors.js";
import type { Fix, ParamSchema } from "./types.js";

export function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

export function closest(word: string, options: string[]): string | undefined {
  let best: string | undefined, bestD = Infinity;
  for (const o of options) {
    const dd = distance(word.toLowerCase(), o.toLowerCase());
    if (dd < bestD) (best = o), (bestD = dd);
  }
  return best !== undefined && bestD <= Math.max(2, Math.floor(word.length / 3)) ? best : undefined;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function checkType(type: string, v: unknown): string | null {
  const base = type.split(" — ")[0].trim();
  if (base.endsWith("[]")) {
    if (!Array.isArray(v)) return `an array of ${base.slice(0, -2)}`;
    for (const x of v) if (checkType(base.slice(0, -2), x)) return `an array of ${base.slice(0, -2)}`;
    return null;
  }
  switch (base) {
    case "string": return typeof v === "string" ? null : "a string";
    case "int": return Number.isInteger(v) ? null : "an integer";
    case "number": return typeof v === "number" ? null : "a number";
    case "bool": return typeof v === "boolean" ? null : "true or false";
    case "date": return typeof v === "string" && DATE.test(v) ? null : "a date like 2026-09-24";
    case "datetime": return typeof v === "string" && DATETIME.test(v) ? null : "an ISO datetime like 2026-09-24T15:00:00Z";
    case "any": return null;
    default:
      if (base.includes("|")) {
        const opts = base.split("|");
        return opts.includes(String(v)) ? null : `one of ${opts.join(", ")}`;
      }
      return null;
  }
}

/** Throws a ParleyError(invalid_params) with fixes if params don't match the schema. */
export function validateParams(schema: ParamSchema | undefined, params: Record<string, unknown>, path = ""): void {
  if (!schema) return;
  const problems: string[] = [];
  const fixes: Fix[] = [];
  const names = Object.keys(schema).map((k) => k.replace(/\?$/, ""));
  for (const [raw, type] of Object.entries(schema)) {
    const optional = raw.endsWith("?");
    const name = raw.replace(/\?$/, "");
    const v = params[name];
    if (v === undefined || v === null) {
      if (!optional) problems.push(`missing \`${path}${name}\` (${typeof type === "string" ? type : "object"})`);
      continue;
    }
    if (typeof type === "string") {
      const want = checkType(type, v);
      if (want) problems.push(`\`${path}${name}\` must be ${want} (got ${JSON.stringify(v)})`);
    } else if (Array.isArray(type)) {
      if (!Array.isArray(v)) problems.push(`\`${path}${name}\` must be an array of objects`);
      else v.forEach((item, i) => {
        try {
          if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error(`\`${path}${name}.${i}\` must be an object`);
          validateParams(type[0], item as Record<string, unknown>, `${path}${name}.${i}.`);
        } catch (e) {
          problems.push((e as Error).message);
        }
      });
    } else if (typeof v !== "object" || Array.isArray(v)) {
      problems.push(`\`${path}${name}\` must be an object`);
    } else {
      try {
        validateParams(type, v as Record<string, unknown>, `${path}${name}.`);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
  }
  for (const k of Object.keys(params)) {
    if (names.includes(k)) continue;
    const near = closest(k, names);
    problems.push(`unknown param \`${path}${k}\``);
    if (near && params[near] === undefined) fixes.push(fix(`rename \`${k}\` to \`${near}\``, { [k]: null, [near]: params[k] }));
  }
  if (problems.length) throw new ParleyError("invalid_params", problems.join("; "), fixes.length ? { fix: fixes } : {});
}
