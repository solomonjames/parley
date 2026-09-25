/**
 * Canonical JSON (SPEC §10): sorted keys, no whitespace, integers only.
 * Used for everything that is hashed or signed.
 */
export function canonical(v: unknown): string {
  if (v === null) return 'null';

  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isSafeInteger(v))
        throw new TypeError(
          `canonical JSON allows only safe integers, got ${v}`,
        );

      return String(v);
    case 'string':
      return quote(v);
    case 'object': {
      if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;

      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort(byCodePoint);

      return (
        '{' +
        keys.map((k) => `${quote(k)}:${canonical(obj[k])}`).join(',') +
        '}'
      );
    }
    default:
      throw new TypeError(`cannot canonicalize ${typeof v}`);
  }
}

function byCodePoint(a: string, b: string): number {
  const A = [...a],
    B = [...b];

  for (let i = 0; i < Math.min(A.length, B.length); i++) {
    const d = A[i].codePointAt(0)! - B[i].codePointAt(0)!;

    if (d !== 0) return d;
  }

  return A.length - B.length;
}

const ESC: Record<string, string> = {
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
};

export function quote(s: string): string {
  return (
    '"' +
    s.replace(
      /["\\\u0000-\u001f]/g,
      (c) => ESC[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
    ) +
    '"'
  );
}
