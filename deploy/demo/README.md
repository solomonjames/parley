# Hosted demo (Cloudflare Workers)

The example calendar and shop services, hosted, with one private copy per agent key (a Durable
Object per `(service, proof.key)`), so anyone can try Parley from Claude Code without running
anything:

```sh
npx parley-protocol init
npx parley-protocol grant --risk low --per 40USD --spend 100USD --exp 24h
claude mcp add parley-demo -- npx parley-protocol mcp https://parley-demo.<account>.workers.dev/calendar/parley https://parley-demo.<account>.workers.dev/shop/parley
```

The demo trusts **any** principal (its data is fake and per-agent), so bring your own keys.

```sh
npm run build              # at the repo root (the worker imports parley-protocol)
cd deploy/demo
npx wrangler dev           # local
npx wrangler deploy        # needs `wrangler login`
```
