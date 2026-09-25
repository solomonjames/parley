// Serve the example services.
//   calendar → parley://127.0.0.1:7447   and  http://127.0.0.1:8447/parley
//   shop     → parley://127.0.0.1:7449   and  http://127.0.0.1:8449/parley
// Trusted principals come from PARLEY_TRUST (comma-separated "ed25519:…" keys).
import { listen, serveHttp } from 'parley-protocol/node';
import { calendar } from './calendar.ts';
import { shop } from './shop.ts';

const trust = (process.env.PARLEY_TRUST ?? '').split(',').filter(Boolean);
const host = process.env.HOST ?? '127.0.0.1';
const cal = calendar({ trust });
const sh = shop({ trust });

await Promise.all([
  listen(cal, { port: 7447, host }),
  serveHttp(cal, { port: 8447, host }),
  listen(sh, { port: 7449, host }),
  serveHttp(sh, { port: 8449, host }),
]);
console.error(
  `parley examples up · calendar parley://${host}:7447 http://${host}:8447/parley · shop parley://${host}:7449 http://${host}:8449/parley · trusting ${trust.length} principal(s)`,
);
