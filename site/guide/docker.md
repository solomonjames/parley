# Docker

The `parley` CLI is published as a container image, so you can run services without installing Node:

```sh
docker run --rm ghcr.io/yea-protocol/yea demo
```

The image's entrypoint is `parley`, so every [CLI command](/reference/cli) works. It runs as a non-root user, exposes ports 7447 and 8080, and is built for `linux/amd64` and `linux/arm64`.

::: tip Bind to 0.0.0.0 inside containers
Parley listens on `127.0.0.1` by default. Inside a container, pass `--host 0.0.0.0` so the published port reaches it.
:::

## Wrap an API

```sh
docker run --rm -p 7447:7447 -e GITHUB_TOKEN \
  ghcr.io/yea-protocol/yea openapi --preset github --host 0.0.0.0

docker run --rm -p 7447:7447 ghcr.io/yea-protocol/yea \
  openapi https://petstore3.swagger.io/api/v3/openapi.json --base https://petstore3.swagger.io/api/v3 --host 0.0.0.0
```

Add `--http 8080 -p 8080:8080` to also serve the HTTP bridge. Upstream credentials go in with `-e`, and the model never sees them.

## Which principal it trusts

A wrapped API only accepts writes authorized by principals it trusts. Pass yours in:

```sh
docker run --rm -p 7447:7447 -e PARLEY_TRUST="$(parley whoami | awk '/principal/{print $2}')" \
  ghcr.io/yea-protocol/yea openapi --preset github --host 0.0.0.0
```

Then point your AI tool at it: `parley add yea://127.0.0.1:7447`.

## The example services

```sh
docker run --rm -p 7447:7447 -p 7449:7449 -p 7451:7451 -e PARLEY_TRUST=… ghcr.io/yea-protocol/yea examples --host 0.0.0.0
```

## Verify the image

Images are published from tagged releases with build provenance. See [Verified releases](/reference/verified-releases).
