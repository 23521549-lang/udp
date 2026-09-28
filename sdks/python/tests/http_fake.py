"""Server HTTP cục bộ cho test transport trên mạng THẬT — mỗi request một hàm xử lý do test đưa.

Đếm socket mở/đóng ở phía server: hàm xử lý kiểu "hố đen" chặn tới khi CLIENT đóng kết nối, nên
``closed`` tăng đúng khi provider thật sự trả socket — thứ transport giả không phủ được.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

Handler = Callable[["Request"], None]


class Request:
    def __init__(self, h: BaseHTTPRequestHandler, body: bytes) -> None:
        self._h = h
        self.method = h.command
        self.path = h.path
        self.headers = h.headers
        self.body = body

    def send(self, status: int, headers: dict[str, str] | None = None, body: bytes = b"") -> None:
        self._h.send_response(status)
        for key, value in (headers or {}).items():
            self._h.send_header(key, value)
        self._h.send_header("Content-Length", str(len(body)))
        self._h.end_headers()
        self._h.wfile.write(body)

    def start_stream(self, headers: dict[str, str] | None = None) -> None:
        """Header của một stream chunked (như Express của Service 2), chưa byte body nào."""
        self._h.send_response(200)
        for key, value in {"Content-Type": "text/event-stream", **(headers or {})}.items():
            self._h.send_header(key, value)
        self._h.send_header("Transfer-Encoding", "chunked")
        self._h.end_headers()
        self._h.wfile.flush()

    def chunk(self, text: str) -> bool:
        """Một mảnh chunked; ``False`` khi client đã đóng."""
        return self.chunk_bytes(text.encode("utf-8"))

    def chunk_bytes(self, data: bytes) -> bool:
        try:
            self._h.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
            self._h.wfile.flush()
            return True
        except OSError:
            return False

    def hold(self) -> None:
        """Giữ kết nối, không gửi gì, tới khi CLIENT đóng (hố đen)."""
        try:
            while self._h.rfile.read(1):
                pass
        except OSError:
            pass


class FakeServer:
    def __init__(self, handler: Handler) -> None:
        self.opened = 0
        self.closed = 0
        self.requests: list[Request] = []
        owner = self

        class _H(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def setup(self) -> None:
                super().setup()
                owner.opened += 1

            def finish(self) -> None:
                try:
                    super().finish()
                finally:
                    owner.closed += 1

            def _serve(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                req = Request(self, self.rfile.read(length) if length else b"")
                owner.requests.append(req)
                handler(req)
                self.close_connection = True

            do_GET = _serve
            do_POST = _serve

            def log_message(self, *_args: Any) -> None:
                pass

        self._server = ThreadingHTTPServer(("127.0.0.1", 0), _H)
        self._server.daemon_threads = True
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self._server.server_address[1]}"

    def close(self) -> None:
        self._server.shutdown()
        self._server.server_close()
