/** Local identity store (~/.parley): the principal key, the agent key, grants and consents. */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { keyPair, type KeyPair } from './crypto.js';

export const home = () => process.env.PARLEY_HOME ?? join(homedir(), '.parley');

const p = (...s: string[]) => join(home(), ...s);

function ensure() {
  for (const d of ['', 'grants', 'consents'])
    mkdirSync(p(d), { recursive: true, mode: 0o700 });
}

/** The principal key may live elsewhere (another OS user, a mounted device): PARLEY_PRINCIPAL_HOME. */
const keyFile = (name: 'principal' | 'agent') =>
  name === 'principal' && process.env.PARLEY_PRINCIPAL_HOME
    ? join(process.env.PARLEY_PRINCIPAL_HOME, 'principal.key')
    : p(`${name}.key`);

async function loadKey(
  name: 'principal' | 'agent',
  create: boolean,
): Promise<KeyPair | null> {
  const f = keyFile(name);

  if (existsSync(f)) return keyPair(readFileSync(f, 'utf8').trim());

  if (!create) return null;

  ensure();
  mkdirSync(join(f, '..'), { recursive: true, mode: 0o700 });

  const kp = await keyPair();

  writeFileSync(f, `${kp.seed}\n`, { mode: 0o600 });

  return kp;
}

export const principalKey = (create = false) => loadKey('principal', create);
export const agentKey = (create = false) => loadKey('agent', create);

export function saveGrant(
  token: string,
  kind: 'grants' | 'consents',
  name: string,
) {
  ensure();
  writeFileSync(
    p(kind, `${name.replace(/[^A-Za-z0-9_-]/g, '_')}.pg`),
    `${token}\n`,
    { mode: 0o600 },
  );
}

export function loadGrants(kind: 'grants' | 'consents' = 'grants'): string[] {
  const d = p(kind);

  if (!existsSync(d)) return [];

  return readdirSync(d)
    .filter((f) => f.endsWith('.pg'))
    .map((f) => readFileSync(join(d, f), 'utf8').trim());
}
