"""``HttpTransport`` trên mạng THẬT (server cục bộ) — cùng các ca của ``transport.test.ts`` (Node).

Thứ transport giả không phủ: cắt một ``recv`` đang chặn khi watchdog bắn, trả socket thật, hạn
của ``GET /sdk/config`` khi server nhận kết nối rồi im, và mã hoá chunked của stream.
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from datetime import UTC, datetime
from typing import Any

import pytest
from http_fake import FakeServer, Handler, Request
from support import wait_until

from udp_openfeature.cancel import Cancel
from udp_openfeature.sse import SseEvent, SseRetry
from udp_openfeature.store import ConfigStore
from udp_openfeature.sync import Synchronizer, SyncListener, SyncOptions
from udp_openfeature.transport import HttpTransport, StatsPostResult, retry_after_ms

_servers: list[FakeServer] = []
_syncs: list[Synchronizer] = []


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    for sync in _syncs:
        sync.close()
        sync.join(2)
    for server in _servers:
        server.close()
    _syncs.clear()
    _servers.clear()


def serve(handler: Handler) -> FakeServer:
    server = FakeServer(handler)
    _servers.append(server)
    return server


def synchronizer(base: str, heartbeat_timeout_ms: float = 10_000, request_timeout_ms: float = 10_000) -> Synchronizer:
    noop = lambda *_a: None  # noqa: E731
    sync = Synchronizer(
        HttpTransport(base, "udp_sk_test"),
        ConfigStore(),
        SyncOptions(
            polling_interval_ms=10_000,
            sse_failures_before_fallback=3,
            stale_after_ms=60_000,
            heartbeat_timeout_ms=heartbeat_timeout_ms,
            backoff_min_ms=10,
            request_timeout_ms=request_timeout_ms,
            stale_check_ms=1_000,
            random=lambda: 0.5,
        ),
        SyncListener(noop, noop, noop, noop, noop, noop, noop),
    )
    _syncs.append(sync)
    return sync


def with_timeout(seconds: float) -> Cancel:
    return Cancel().child(seconds)


def test_stream_gui_header_roi_im_thi_watchdog_cat_socket_dong_noi_lai() -> None:
    streams = [0]

    def handle(req: Request) -> None:
        if req.path.startswith("/sdk/config"):
            req.send(503)
            return
        streams[0] += 1
        req.start_stream()
        req.hold()

    server = serve(handle)
    synchronizer(server.base, heartbeat_timeout_ms=100).start()
    wait_until(lambda: streams[0] >= 3, 5)
    # Mỗi lần watchdog cắt là một socket thật được trả lại, không rò kết nối
    wait_until(lambda: server.closed >= 3, 5)


def test_config_nhan_ket_noi_roi_im_thi_qua_han_rieng_stream_van_duoc_thu() -> None:
    opened = [False]

    def handle(req: Request) -> None:
        if req.path.startswith("/sdk/config"):
            req.hold()
            return
        opened[0] = True
        req.start_stream()
        req.chunk(": nhịp tim\n\n")
        req.hold()

    server = serve(handle)
    synchronizer(server.base, request_timeout_ms=100).start()
    wait_until(lambda: opened[0], 3)


def test_stream_chunked_utf8_cat_giua_ky_tu_van_ra_dung_su_kien() -> None:
    def handle_bytes(req: Request) -> None:
        req.start_stream()
        payload = 'retry: 1500\nevent: snapshot\ndata: {"x":"Nguyễn 😀"}\n\n'.encode()
        for i in range(len(payload)):  # từng BYTE — chữ nhiều byte bị cắt giữa chừng
            req.chunk_bytes(payload[i : i + 1])
        req.hold()

    server = serve(handle_bytes)
    cancel = Cancel()
    opened = HttpTransport(server.base, "udp_sk_test").open_stream(None, cancel)
    assert opened.kind == "open" and opened.items is not None
    got: list[Any] = []
    for item in opened.items:
        if isinstance(item, (SseEvent, SseRetry)):
            got.append(item)
        if any(isinstance(g, SseEvent) for g in got):
            break
    cancel.cancel()
    assert got == [SseRetry(1500), SseEvent("snapshot", '{"x":"Nguyễn 😀"}', None)]
    assert server.requests[0].headers["Authorization"] == "Bearer udp_sk_test"
    assert server.requests[0].headers["Accept"] == "text/event-stream"
    assert server.requests[0].path == "/sdk/stream"


def test_open_stream_phan_loai_ma() -> None:
    status = [401]

    def handle(req: Request) -> None:
        if status[0] == 200:
            req.send(200, {"Content-Type": "application/json"}, b"{}")
        else:
            req.send(status[0], {"Retry-After": "2"})

    server = serve(handle)
    t = HttpTransport(server.base + "/", "udp_sk_test")
    kinds = []
    for code in (401, 403, 400, 503, 200):
        status[0] = code
        opened = t.open_stream(7, Cancel())
        kinds.append((opened.kind, opened.retry_after_ms))
    assert kinds == [
        ("unauthorized", None),
        ("unauthorized", None),
        ("bad-cursor", None),
        ("unavailable", 2_000),
        ("unavailable", None),  # 200 mà không phải text/event-stream
    ]
    assert all(r.path == "/sdk/stream?since=7" for r in server.requests)


def test_get_config_etag_304_401_body_hong() -> None:
    replies: list[tuple[int, dict[str, str], bytes]] = [
        (200, {"ETag": '"3"', "Content-Type": "application/json"}, b'{"configVersion":3}'),
        (304, {}, b""),
        (401, {}, b""),
        (200, {}, b"NaN"),
        (429, {"Retry-After": "4"}, b""),
    ]

    def handle(req: Request) -> None:
        req.send(*replies.pop(0))

    server = serve(handle)
    t = HttpTransport(server.base, "udp_sk_test")
    first = t.get_config(None, with_timeout(5))
    assert (first.kind, first.body, first.etag) == ("ok", {"configVersion": 3}, '"3"')
    assert t.get_config('"3"', with_timeout(5)).kind == "not-modified"
    assert server.requests[1].headers["If-None-Match"] == '"3"'
    assert t.get_config(None, with_timeout(5)).kind == "unauthorized"
    assert t.get_config(None, with_timeout(5)).kind == "unavailable"  # NaN không phải JSON
    limited = t.get_config(None, with_timeout(5))
    assert (limited.kind, limited.retry_after_ms) == ("unavailable", 4_000)


# ------------------------------------------------------------- post_stats

REPORT = {"counts": [{"flagKey": "f", "variant": "on", "count": 3}]}


def test_post_stats_bearer_json_dung_hop_dong_202_la_accepted() -> None:
    server = serve(lambda req: req.send(202))
    out = HttpTransport(server.base, "udp_sk_test").post_stats(REPORT, with_timeout(5))
    assert out == StatsPostResult("accepted")
    req = server.requests[0]
    assert (req.method, req.path) == ("POST", "/sdk/stats")
    assert req.headers["Authorization"] == "Bearer udp_sk_test"
    assert req.headers["Content-Type"] == "application/json"
    assert json.loads(req.body) == REPORT


def test_post_stats_anh_xa_ma() -> None:
    status = [429]
    server = serve(lambda req: req.send(status[0], {"Retry-After": "3"} if status[0] == 429 else {}))
    t = HttpTransport(server.base, "udp_sk_test")
    got = []
    for code in (429, 503, 400, 413, 401, 403, 404, 405, 500, 502):
        status[0] = code
        got.append(t.post_stats(REPORT, with_timeout(5)))
    assert got == [
        StatsPostResult("retry", 3_000),
        StatsPostResult("retry"),
        StatsPostResult("rejected"),
        StatsPostResult("rejected"),
        StatsPostResult("stop"),
        StatsPostResult("stop"),
        StatsPostResult("stop"),
        StatsPostResult("stop"),
        StatsPostResult("ambiguous"),
        StatsPostResult("ambiguous"),
    ]


def test_post_stats_server_im_thi_qua_han_la_mo_ho() -> None:
    server = serve(lambda req: req.hold())
    started = time.monotonic()
    out = HttpTransport(server.base, "udp_sk_test").post_stats(REPORT, with_timeout(0.15))
    assert out == StatsPostResult("ambiguous")
    assert time.monotonic() - started < 2


def test_post_stats_khong_ket_noi_duoc_thi_retry() -> None:
    out = HttpTransport("http://127.0.0.1:9", "udp_sk_test").post_stats(REPORT, with_timeout(5))
    assert out == StatsPostResult("retry")


def test_retry_after_so_giay_http_date_rac() -> None:
    now = datetime(2026, 9, 22, tzinfo=UTC).timestamp()
    assert retry_after_ms("5", now) == 5_000
    assert retry_after_ms("Tue, 22 Sep 2026 00:00:07 GMT", now) == 7_000
    assert retry_after_ms("Mon, 21 Sep 2026 00:00:00 GMT", now) == 0
    assert retry_after_ms("soon", now) is None
    assert retry_after_ms(None, now) is None


def test_host_co_tien_to_duong_dan() -> None:
    server = serve(lambda req: req.send(304))
    HttpTransport(server.base + "/flags/", "k").get_config('"1"', with_timeout(5))
    assert server.requests[0].path == "/flags/sdk/config"
