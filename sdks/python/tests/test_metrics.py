"""Middleware đo lường (§6.6) — cùng các ca của ``metrics.test.ts`` (Node), cho ASGI lẫn WSGI.

Số series đúng công thức (1 tổng + mỗi tracked flag đã đánh giá, không nhân chéo), key thô, route
là MẪU, ghi đúng một lần, và hợp đồng nhãn TRÙNG bản Node — bản Node lại được kiểm với truy vấn
của Service 3 (§7.4), nên hai ngôn ngữ cùng khớp một truy vấn.
"""

from __future__ import annotations

import asyncio
import re
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest
from prometheus_client import CollectorRegistry, Histogram

from udp_openfeature.labels import request_store
from udp_openfeature.metrics import (
    BUCKETS,
    REQUEST_DURATION_LABELS,
    REQUEST_DURATION_METRIC,
    UNMATCHED_ROUTE,
    Message,
    Receive,
    Scope,
    Send,
    UDPMetricsMiddleware,
    UDPMetricsWSGIMiddleware,
)

NODE_METRICS = Path(__file__).resolve().parents[3] / "packages" / "openfeature-provider" / "src" / "metrics.ts"


def series(registry: CollectorRegistry) -> list[dict[str, str]]:
    """Nhãn của mọi series ``_count`` của histogram."""
    out: list[dict[str, str]] = []
    for metric in registry.collect():
        for sample in metric.samples:
            if sample.name == f"{REQUEST_DURATION_METRIC}_count":
                out.append(dict(sample.labels))
    return out


def label_flags() -> None:
    labels = request_store.get()
    assert labels is not None, "middleware phải mở store trước route"
    labels.flags["checkout-v2"] = "on"
    labels.flags["new-price"] = "off"


# ------------------------------------------------------------- ASGI


def asgi_app(route_path: str | None, status: int = 200, fail: BaseException | None = None) -> Any:
    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        if route_path is not None:
            scope["route"] = SimpleNamespace(path=route_path)  # như FastAPI sau khi khớp route
            label_flags()
        if fail is not None and status == 0:
            raise fail
        await send({"type": "http.response.start", "status": status, "headers": []})
        if fail is not None:
            raise fail
        await send({"type": "http.response.body", "body": b"{}"})

    return app


def call_asgi(middleware: UDPMetricsMiddleware, method: str = "GET", root_path: str = "") -> None:
    scope = {"type": "http", "method": method, "path": "/api/items/42", "root_path": root_path}
    sent: list[Message] = []

    async def receive() -> Message:
        return {"type": "http.request", "body": b""}

    async def send(message: Message) -> None:
        sent.append(message)

    asyncio.run(middleware(scope, receive, send))


def test_asgi_mot_series_tong_cong_moi_tracked_flag_route_la_mau() -> None:
    registry = CollectorRegistry()
    mw = UDPMetricsMiddleware(
        asgi_app("/items/{id}"), registry=registry, service_name="checkout", service_version="1.4.0"
    )
    call_asgi(mw, root_path="/api")
    got = sorted(series(registry), key=lambda s: s["ff"])
    base = {
        "service_name": "checkout",
        "service_version": "1.4.0",
        "http_route": "/api/items/{id}",
        "http_request_method": "GET",
        "http_response_status_code": "200",
    }
    assert got == [{**base, "ff": ""}, {**base, "ff": "checkout-v2=on"}, {**base, "ff": "new-price=off"}]


def test_asgi_route_khong_khop_la_unmatched() -> None:
    registry = CollectorRegistry()
    call_asgi(UDPMetricsMiddleware(asgi_app(None, 404), registry=registry, service_name="s", service_version="v"))
    assert [(s["http_route"], s["http_response_status_code"]) for s in series(registry)] == [(UNMATCHED_ROUTE, "404")]


def test_asgi_client_huy_truoc_header_la_499_sau_header_giu_status() -> None:
    registry = CollectorRegistry()
    before = UDPMetricsMiddleware(
        asgi_app(None, 0, asyncio.CancelledError()), registry=registry, service_name="s", service_version="v"
    )
    with pytest.raises(asyncio.CancelledError):
        call_asgi(before)
    after = UDPMetricsMiddleware(
        asgi_app(None, 201, asyncio.CancelledError()), registry=registry, service_name="s", service_version="v"
    )
    with pytest.raises(asyncio.CancelledError):
        call_asgi(after)
    assert sorted(s["http_response_status_code"] for s in series(registry)) == ["201", "499"]


def test_asgi_loi_truoc_header_la_500_va_van_nem_lai() -> None:
    registry = CollectorRegistry()
    mw = UDPMetricsMiddleware(
        asgi_app(None, 0, RuntimeError("hỏng")), registry=registry, service_name="s", service_version="v"
    )
    with pytest.raises(RuntimeError):
        call_asgi(mw)
    assert [s["http_response_status_code"] for s in series(registry)] == ["500"]


def test_asgi_lifespan_di_thang_khong_ghi() -> None:
    registry = CollectorRegistry()
    seen: list[str] = []

    async def app(scope: Scope, receive: Receive, send: Send) -> None:
        seen.append(scope["type"])

    mw = UDPMetricsMiddleware(app, registry=registry, service_name="s", service_version="v")
    asyncio.run(mw({"type": "lifespan"}, None, None))  # type: ignore[arg-type]
    assert seen == ["lifespan"]
    assert series(registry) == []


# ------------------------------------------------------------- WSGI


def wsgi_app(rule: str | None, status: str = "200 OK", fail: BaseException | None = None) -> Any:
    def app(environ: dict[str, Any], start_response: Any) -> Any:
        if rule is not None:
            environ["werkzeug.request"] = SimpleNamespace(url_rule=SimpleNamespace(rule=rule))  # như Flask
            label_flags()
        if fail is not None:
            raise fail
        start_response(status, [("Content-Type", "application/json")])
        return [b"{}"]

    return app


def call_wsgi(middleware: UDPMetricsWSGIMiddleware, method: str = "POST") -> list[bytes]:
    body = middleware({"REQUEST_METHOD": method, "PATH_INFO": "/items/7"}, lambda *_a: None)
    try:
        return list(body)
    finally:
        body.close()  # type: ignore[attr-defined]


def test_wsgi_mot_series_tong_cong_moi_tracked_flag() -> None:
    registry = CollectorRegistry()
    mw = UDPMetricsWSGIMiddleware(
        wsgi_app("/items/<int:id>", "201 Created"), registry=registry, service_name="s", service_version="v"
    )
    assert call_wsgi(mw) == [b"{}"]
    got = sorted(
        (s["ff"], s["http_route"], s["http_request_method"], s["http_response_status_code"]) for s in series(registry)
    )
    assert got == [
        ("", "/items/<int:id>", "POST", "201"),
        ("checkout-v2=on", "/items/<int:id>", "POST", "201"),
        ("new-price=off", "/items/<int:id>", "POST", "201"),
    ]
    assert request_store.get() is None  # store không rò sang request sau trên cùng luồng


def test_wsgi_ghi_dung_mot_lan_khi_close_goi_hai_lan() -> None:
    registry = CollectorRegistry()
    mw = UDPMetricsWSGIMiddleware(wsgi_app(None), registry=registry, service_name="s", service_version="v")
    body = mw({"REQUEST_METHOD": "GET"}, lambda *_a: None)
    body.close()  # type: ignore[attr-defined]
    body.close()  # type: ignore[attr-defined]
    assert [(s["http_route"], s["http_response_status_code"]) for s in series(registry)] == [(UNMATCHED_ROUTE, "200")]


def test_wsgi_loi_trong_ung_dung_la_500_va_van_nem_lai() -> None:
    registry = CollectorRegistry()
    mw = UDPMetricsWSGIMiddleware(
        wsgi_app(None, fail=RuntimeError("hỏng")), registry=registry, service_name="s", service_version="v"
    )
    with pytest.raises(RuntimeError):
        mw({"REQUEST_METHOD": "GET"}, lambda *_a: None)
    assert [s["http_response_status_code"] for s in series(registry)] == ["500"]


# ------------------------------------------------------------- dựng và hợp đồng


def test_dung_hai_lan_tren_cung_registry_khong_nem() -> None:
    registry = CollectorRegistry()
    UDPMetricsMiddleware(asgi_app(None), registry=registry)
    UDPMetricsWSGIMiddleware(wsgi_app(None), registry=registry)


def test_histogram_trung_ten_thieu_nhan_ff_thi_nem_ro() -> None:
    registry = CollectorRegistry()
    Histogram(
        REQUEST_DURATION_METRIC, "của ứng dụng", labelnames=("http_route", "http_request_method"), registry=registry
    )
    with pytest.raises(ValueError, match=r"thiếu .*ff"):
        UDPMetricsMiddleware(asgi_app(None), registry=registry)


def test_nhan_mac_dinh_tu_bien_moi_truong_otel(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OTEL_SERVICE_NAME", "checkout")
    monkeypatch.setenv("OTEL_RESOURCE_ATTRIBUTES", "deployment.environment=dev, service.version=1.4.0%2Bb7")
    registry = CollectorRegistry()
    call_asgi(UDPMetricsMiddleware(asgi_app(None), registry=registry))
    assert {(s["service_name"], s["service_version"]) for s in series(registry)} == {("checkout", "1.4.0+b7")}


def test_hop_dong_nhan_ten_va_bucket_trung_ban_node() -> None:
    source = NODE_METRICS.read_text(encoding="utf-8")
    name = re.search(r'REQUEST_DURATION_METRIC = "([^"]+)"', source)
    labels = re.search(r"REQUEST_DURATION_LABELS = \[(.*?)\] as const", source, re.S)
    buckets = re.search(r"const BUCKETS = \[(.*?)\];", source, re.S)
    assert name and labels and buckets, "bản Node đổi hình — cập nhật phép đọc ở đây"
    assert name.group(1) == REQUEST_DURATION_METRIC
    assert tuple(re.findall(r'"([a-z_]+)"', labels.group(1))) == REQUEST_DURATION_LABELS
    assert tuple(float(b) for b in buckets.group(1).split(",")) == tuple(float(b) for b in BUCKETS)
