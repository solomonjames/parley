---
editLink: false
---

# Wrap any REST API

<!--@include: ../../README.md#openapi-->

## How operations map

| OpenAPI operation | Parley capability | What the model sees |
|---|---|---|
| `GET` | `ASK` | The response as Lens, fitted to the budget, with `EXPAND` handles for the rest |
| `POST` | `INTENT`, effect `create` | A proposal showing the exact request: method, URL and body |
| `PUT`, `PATCH` | `INTENT`, effect `update` | The same, as an update |
| `DELETE` | `INTENT`, effect `delete`, risk `medium` | The same, as a delete |

Nothing is sent upstream until `COMMIT`. Wrapped writes are irreversible (`undo: never`), so they are never auto-committed, and grants, spend caps and consent apply unchanged. Upstream errors become Parley errors.

## Options

```sh
parley openapi <spec.json|url> [--base <url>] [--header "K: V"] [--id <service id>] [--prefix <name>] [--port 7447] [--http 8080]
```

| Flag | Meaning |
|---|---|
| `--base` | The API's base URL. Defaults to the spec's first server |
| `--header` | A header sent on every upstream call, such as credentials. Repeatable. Never shown to the model |
| `--id` | The service id, which proofs are bound to. Defaults to the API's host |
| `--prefix` | The capability name prefix. Defaults to a slug of the API's title |
| `--port` | The `parley://` port (7447) |
| `--http` | Also serve the HTTP bridge on this port, at `/parley` |

Writes are authorized for the principals in `PARLEY_TRUST`, or your own principal key if that's unset.

## From code

```ts
import { fromOpenAPI, loadOpenAPI } from "parley-protocol/openapi";
import { listen } from "parley-protocol/node";

const spec = await loadOpenAPI("https://petstore3.swagger.io/api/v3/openapi.json");
const svc = fromOpenAPI(spec, {
  baseUrl: "https://petstore3.swagger.io/api/v3",
  headers: { Authorization: `Bearer ${process.env.API_TOKEN}` },
  trust: [PRINCIPAL_KEY],
  risk: (method) => (method === "delete" ? "high" : "low"),
  include: (method, path) => !path.startsWith("/admin"),
});
await listen(svc);
```
