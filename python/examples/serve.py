"""Serve the Python example calendar (the same service as ../../examples/calendar.ts).

    PARLEY_TRUST=ed25519:... uv run python examples/serve.py
    calendar → parley://127.0.0.1:7457  and  http://127.0.0.1:8457/parley

PARLEY_TRUST is a comma-separated list of trusted principal keys. --stdio serves NDJSON on
stdin/stdout instead (for ``stdio:`` URLs).
"""

from __future__ import annotations

import asyncio
import os
import sys

from calendar_example import calendar

from parley import serve_http, serve_stdio, serve_tcp


async def main() -> None:
    trust = [k for k in os.environ.get("PARLEY_TRUST", "").split(",") if k]
    host = os.environ.get("HOST", "127.0.0.1")
    tcp_port = int(os.environ.get("PARLEY_PORT", "7457"))
    http_port = int(os.environ.get("PARLEY_HTTP_PORT", "8457"))
    cal = calendar(trust)
    if "--stdio" in sys.argv:
        await serve_stdio(cal)
        return
    servers = [await serve_tcp(cal, host, tcp_port), await serve_http(cal, host, http_port)]
    print(
        f"parley python example up · calendar parley://{host}:{tcp_port} http://{host}:{http_port}/parley"
        f" · trusting {len(trust)} principal(s)",
        file=sys.stderr, flush=True,
    )
    await asyncio.gather(*(s.serve_forever() for s in servers))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
