"""Đường mạng tới Service 2 (§6.3) — bản Python của ``transport.ts``.

Tách khỏi vòng đồng bộ để test đơn vị tiêm transport giả và kiểm tất định I15a/I18/I33/I34
không cần mạng. Mọi phản hồi được PHÂN LOẠI ở đây; không gì ném ra ngoài (lỗi mạng cũng là một
loại kết quả). Chỉ dùng thư viện chuẩn: mỗi request một kết nối, đóng ngay khi xong — request
hiếm (bootstrap, polling 30 giây, stats 60 giây) nên pool không đáng một phụ thuộc.

Huỷ: ``Cancel`` của nơi gọi đóng socket đang chặn — cùng vai ``AbortSignal`` của ``fetch``.
"""

from __future__ import annotations

import codecs
import http.client
import json
import re
import socket
import time
from collections.abc import Callable, Iterator
from contextlib import suppress
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from typing import Any, Literal, Protocol
from urllib.parse import urlsplit

from .cancel import Cancel
from .constants import CONNECT_TIMEOUT_S
from .evaluator.jsvalue import json_parse
from .sse import SseItem, SseParser

_READ_CHUNK = 64 * 1024
_SECONDS = re.compile(r"[0-9]+")


@dataclass(frozen=True)
class ConfigResult:
    kind: Literal["ok", "not-modified", "unauthorized", "unavailable"]
    body: Any = None
    etag: str | None = None
    retry_after_ms: float | None = None


@dataclass(frozen=True)
class StreamOpen:
    """``bad-cursor`` (400): con trỏ sai dạng — RESYNC không con trỏ đúng một lần."""

    kind: Literal["open", "unauthorized", "bad-cursor", "unavailable"]
    items: Iterator[SseItem] | None = None
    retry_after_ms: float | None = None


@dataclass(frozen=True)
class StatsPostResult:
    """Kết cục của MỘT lần ``POST /sdk/stats`` theo V7.

    ``retry`` (429/503, hỏng khi CHƯA gửi byte nào) là kết cục DUY NHẤT được gộp lô lại;
    ``ambiguous`` (quá hạn, huỷ, 5xx) bỏ lô — thà mất một báo cáo còn hơn đếm đôi.
    """

    kind: Literal["accepted", "retry", "rejected", "stop", "ambiguous"]
    retry_after_ms: float | None = None


class Transport(Protocol):
    def get_config(self, if_none_match: str | None, cancel: Cancel) -> ConfigResult: ...

    def open_stream(self, since: int | None, cancel: Cancel) -> StreamOpen:
        """``since`` vắng = không con trỏ (server gửi snapshot trước)."""
        ...

    def post_stats(self, report: dict[str, Any], cancel: Cancel) -> StatsPostResult: ...


ConnectionFactory = Callable[[str, str, float], http.client.HTTPConnection]
"""``(scheme, netloc, connect_timeout_s)`` ⇒ kết nối — thay proxy/TLS như ``fetch`` của bản Node."""


def default_connection(scheme: str, netloc: str, timeout: float) -> http.client.HTTPConnection:
    if scheme == "https":
        return http.client.HTTPSConnection(netloc, timeout=timeout)
    return http.client.HTTPConnection(netloc, timeout=timeout)


def retry_after_ms(header: str | None, now_s: float) -> float | None:
    """``Retry-After``: số giây HOẶC HTTP-date (RFC 9110 §10.2.3)."""
    if header is None:
        return None
    value = header.strip()
    if _SECONDS.fullmatch(value):
        return int(value) * 1000.0
    try:
        at = parsedate_to_datetime(value).timestamp()
    except (TypeError, ValueError, IndexError, OverflowError):
        return None
    return max(0.0, (at - now_s) * 1000.0)


def _abort(conn: http.client.HTTPConnection) -> None:
    """Cắt kết nối từ luồng khác — ``recv`` đang chặn trả về ngay."""
    sock = conn.sock
    if sock is not None:
        with suppress(OSError):
            sock.shutdown(socket.SHUT_RDWR)
    conn.close()


class HttpTransport:
    def __init__(self, host: str, sdk_key: str, connection_factory: ConnectionFactory | None = None) -> None:
        parts = urlsplit(host)
        if parts.scheme not in ("http", "https") or parts.netloc == "":
            raise ValueError("host phải là URL http(s) tuyệt đối, vd https://flags.udp.example")
        self._scheme = parts.scheme
        self._netloc = parts.netloc
        self._prefix = parts.path.rstrip("/")
        self._sdk_key = sdk_key
        self._factory = connection_factory or default_connection

    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._sdk_key}", **(extra or {})}

    def _connect(self, cancel: Cancel) -> tuple[http.client.HTTPConnection, Callable[[], None]]:
        """Kết nối đã mở và hàm gỡ đăng ký huỷ. Ném ``OSError`` khi không kết nối được."""
        conn = self._factory(self._scheme, self._netloc, CONNECT_TIMEOUT_S)
        detach = cancel.on_cancel(lambda: _abort(conn))
        try:
            conn.connect()
            if cancel.cancelled:
                raise OSError("đã huỷ")
            # Sau khi kết nối, chỉ `Cancel` (hạn tổng, watchdog, đóng provider) kết thúc việc chờ
            if conn.sock is not None:
                conn.sock.settimeout(None)
        except BaseException:
            detach()
            _abort(conn)
            raise
        return conn, detach

    def get_config(self, if_none_match: str | None, cancel: Cancel) -> ConfigResult:
        headers = self._headers({} if if_none_match is None else {"If-None-Match": if_none_match})
        try:
            conn, detach = self._connect(cancel)
        except Exception:  # noqa: BLE001 — mọi lỗi kết nối là MỘT loại kết quả, không ném
            return ConfigResult("unavailable")
        try:
            conn.request("GET", f"{self._prefix}/sdk/config", headers=headers)
            res = conn.getresponse()
            if res.status == 304:
                return ConfigResult("not-modified")
            if res.status in (401, 403):
                return ConfigResult("unauthorized")
            if not 200 <= res.status < 300:
                return ConfigResult(
                    "unavailable", retry_after_ms=retry_after_ms(res.getheader("Retry-After"), time.time())
                )
            body = json_parse(res.read())
            return ConfigResult("ok", body=body, etag=res.getheader("ETag"))
        except Exception:  # noqa: BLE001 — mạng hỏng, body không phải JSON: cùng một kết quả
            return ConfigResult("unavailable")
        finally:
            detach()
            _abort(conn)

    def open_stream(self, since: int | None, cancel: Cancel) -> StreamOpen:
        path = f"{self._prefix}/sdk/stream" + ("" if since is None else f"?since={since}")
        try:
            conn, detach = self._connect(cancel)
        except Exception:  # noqa: BLE001 — mọi lỗi kết nối là MỘT loại kết quả, không ném
            return StreamOpen("unavailable")
        try:
            conn.request("GET", path, headers=self._headers({"Accept": "text/event-stream"}))
            res = conn.getresponse()
        except Exception:  # noqa: BLE001
            detach()
            _abort(conn)
            return StreamOpen("unavailable")
        if res.status in (401, 403):
            detach()
            _abort(conn)
            return StreamOpen("unauthorized")
        if res.status == 400:
            detach()
            _abort(conn)
            return StreamOpen("bad-cursor")
        content_type = res.getheader("Content-Type") or ""
        if not 200 <= res.status < 300 or not content_type.startswith("text/event-stream"):
            retry = retry_after_ms(res.getheader("Retry-After"), time.time())
            detach()
            _abort(conn)
            return StreamOpen("unavailable", retry_after_ms=retry)
        return StreamOpen("open", items=_items_of(res, conn, detach))

    def post_stats(self, report: dict[str, Any], cancel: Cancel) -> StatsPostResult:
        body = json.dumps(report, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        try:
            conn, detach = self._connect(cancel)
        except Exception:  # noqa: BLE001 — mọi lỗi kết nối là MỘT loại kết quả, không ném
            # Kết nối hỏng NGAY (DNS, từ chối, TLS): chưa một byte nào ra khỏi máy khách
            return StatsPostResult("retry")
        try:
            conn.request(
                "POST",
                f"{self._prefix}/sdk/stats",
                body=body,
                headers=self._headers({"Content-Type": "application/json"}),
            )
            res = conn.getresponse()
            status = res.status
            retry = retry_after_ms(res.getheader("Retry-After"), time.time())
        except Exception:  # noqa: BLE001 — byte đã có thể tới server — gửi lại là đếm đôi (V7)
            return StatsPostResult("ambiguous")
        finally:
            detach()
            _abort(conn)
        if 200 <= status < 300:
            return StatsPostResult("accepted")
        if status in (429, 503):
            return StatsPostResult("retry", retry_after_ms=retry)
        if status in (400, 413):
            return StatsPostResult("rejected")
        if status in (401, 403, 404, 405):
            return StatsPostResult("stop")
        # 500/502/504…: proxy có thể đã chuyển request đi rồi mới hỏng ⇒ bỏ lô
        return StatsPostResult("ambiguous")


def _items_of(
    res: http.client.HTTPResponse, conn: http.client.HTTPConnection, detach: Callable[[], None]
) -> Iterator[SseItem]:
    """Sự kiện của stream; đóng kết nối khi nơi gọi thôi đọc (``close()`` của generator)."""
    parser = SseParser()
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    try:
        while True:
            chunk = res.read1(_READ_CHUNK)
            if not chunk:
                break
            yield from parser.feed(decoder.decode(chunk))
    finally:
        detach()
        _abort(conn)
