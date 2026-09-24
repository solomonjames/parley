"""Server transports: NDJSON over TCP or stdio, and the HTTP bridge (SPEC §2.3–2.4)."""

from __future__ import annotations

import asyncio
import logging
import sys
from typing import Any
from urllib.parse import parse_qs

from ._json import dumps, loads
from .service import Service

log = logging.getLogger("parley")

MAX_FRAME = 1 << 20  # 1 MiB (SPEC §2.1)
DEFAULT_PORT = 7447


def _parse(line: bytes) -> Any:
    """Parse a request line; anything unparseable becomes None, which ``handle`` rejects as bad_frame."""
    try:
        return loads(line.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return None


async def serve_stream(service: Service, reader: asyncio.StreamReader, writer: Any) -> None:
    """Serve one NDJSON connection. Requests are handled concurrently; replies are
    correlated by ``re``. ``writer`` needs ``write``, ``drain`` and ``close``."""
    tasks: set[asyncio.Task] = set()

    def send(frame: dict) -> None:
        # write() is synchronous and buffers whole lines, so frames never interleave.
        if not writer.is_closing():
            writer.write((dumps(frame) + "\n").encode("utf-8"))

    async def run(line: bytes) -> None:
        send(await service.handle(_parse(line), send))
        try:
            await writer.drain()
        except (ConnectionError, RuntimeError):
            pass  # peer went away mid-reply

    try:
        while True:
            try:
                line = await reader.readline()
            except (ValueError, asyncio.LimitOverrunError):
                send({"parley": 1, "id": "s_overflow", "re": "?", "kind": "ERROR", "code": "bad_frame", "message": "frame exceeds 1 MiB"})
                break
            if not line:
                break
            if line.strip():
                t = asyncio.create_task(run(line))
                tasks.add(t)
                t.add_done_callback(tasks.discard)
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
    except ConnectionError:
        pass
    finally:
        try:
            writer.close()
        except Exception:
            pass


async def serve_tcp(service: Service, host: str = "127.0.0.1", port: int = DEFAULT_PORT) -> asyncio.base_events.Server:
    """Start a TCP server for ``parley://`` and return it (already listening)."""
    return await asyncio.start_server(lambda r, w: serve_stream(service, r, w), host, port, limit=MAX_FRAME + 2)


async def serve_stdio(service: Service) -> None:
    """Serve NDJSON on this process's stdin/stdout (the ``stdio:`` transport)."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_FRAME + 2)
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)
    transport, protocol = await loop.connect_write_pipe(asyncio.streams.FlowControlMixin, sys.stdout)
    writer = asyncio.StreamWriter(transport, protocol, reader, loop)
    await serve_stream(service, reader, writer)


# ------------------------------------------------------------ HTTP bridge

_REASONS = {200: "OK", 404: "Not Found", 413: "Payload Too Large"}


async def _http_conn(service: Service, path: str, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    async def respond(status: int, ctype: str, body: bytes) -> None:
        head = (
            f"HTTP/1.1 {status} {_REASONS[status]}\r\nContent-Type: {ctype}\r\n"
            f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n"
        )
        writer.write(head.encode("latin-1") + body)
        await writer.drain()

    try:
        request_line = (await reader.readline()).decode("latin-1").strip()
        headers: dict[str, str] = {}
        while True:
            line = (await reader.readline()).decode("latin-1")
            if line in ("\r\n", "\n", ""):
                break
            k, _, v = line.partition(":")
            headers[k.strip().lower()] = v.strip()
        method, target, *_ = request_line.split(" ") + ["", ""]
        target, _, query = target.partition("?")

        if method == "GET" and target in (path, "/.well-known/parley"):
            budget = parse_qs(query).get("budget", [""])[0]
            brief = service.brief(int(budget) if budget.isdigit() and int(budget) > 0 else None)
            await respond(200, "application/json", dumps({**brief, "endpoint": path}).encode("utf-8"))
        elif method == "POST" and target == path:
            length = int(headers.get("content-length", "0") or 0)
            if length > MAX_FRAME:
                await respond(413, "text/plain", b"frames must not exceed 1 MiB\n")
                return
            # Chunked so EVENTs reach the client as they happen.
            writer.write(
                b"HTTP/1.1 200 OK\r\nContent-Type: application/x-ndjson\r\n"
                b"Transfer-Encoding: chunked\r\nConnection: close\r\n\r\n"
            )

            def send(frame: dict) -> None:
                data = (dumps(frame) + "\n").encode("utf-8")
                writer.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")

            send(await service.handle(_parse(await reader.readexactly(length)), send))
            writer.write(b"0\r\n\r\n")
            await writer.drain()
        else:
            await respond(404, "text/plain", b"not a parley endpoint\n")
    except (ConnectionError, asyncio.IncompleteReadError, ValueError):
        pass
    finally:
        writer.close()


async def serve_http(
    service: Service, host: str = "127.0.0.1", port: int = 8080, path: str = "/parley"
) -> asyncio.base_events.Server:
    """Start the HTTP bridge: ``POST path`` takes one frame and streams NDJSON back;
    ``GET path`` or ``GET /.well-known/parley`` returns the BRIEF (plus ``endpoint``)."""
    return await asyncio.start_server(lambda r, w: _http_conn(service, path, r, w), host, port, limit=MAX_FRAME + 2)
