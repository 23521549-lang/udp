"""Histogram HTTP có nhãn ``ff`` (§6.6, C1) — bản Python của ``metrics.ts``.

Module riêng: chỉ ứng dụng dùng nó mới nạp ``prometheus_client``, và histogram đăng ký vào
registry CỦA ỨNG DỤNG (mặc định ``REGISTRY``) — registry khác với ``/metrics`` là series biến mất
im lặng. Mỗi request ghi MỘT series tổng ``ff=""`` CỘNG mỗi tracked flag đã đánh giá một series
``ff="<flagKey>=<variant>"`` — cộng thêm, không nhân chéo (§7.4 lọc ``ff=""``).

Hai middleware, cùng hợp đồng nhãn: ``UDPMetricsMiddleware`` (ASGI — FastAPI, Starlette) và
``UDPMetricsWSGIMiddleware`` (WSGI — Flask, Django). Đo lường không bao giờ làm sập ứng dụng
khách (I33); histogram trùng tên mà khác bộ nhãn thì NÉM rõ lúc dựng.
"""

from __future__ import annotations

import asyncio
import os
import time
from collections.abc import Awaitable, Callable, Iterable, Iterator, MutableMapping
from typing import Any
from urllib.parse import unquote

from prometheus_client import REGISTRY, CollectorRegistry, Histogram

from .labels import RequestLabels, request_store

REQUEST_DURATION_METRIC = "http_server_request_duration_seconds"

# Hợp đồng với truy vấn của `@udp/metrics-provider` (§7.4) — cùng bộ với bản Node
REQUEST_DURATION_LABELS = (
    "service_name",
    "service_version",
    "http_route",
    "http_request_method",
    "http_response_status_code",
    "ff",
)

BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5)

# Route không khớp — KHÔNG BAO GIỜ URL thô (mỗi id một series: cardinality nổ)
UNMATCHED_ROUTE = "UNMATCHED"

# Request bị client huỷ trước khi có header — quy ước của nginx
CLIENT_CLOSED = "499"

Scope = MutableMapping[str, Any]
Message = MutableMapping[str, Any]
Receive = Callable[[], Awaitable[Message]]
Send = Callable[[Message], Awaitable[None]]
AsgiApp = Callable[[Scope, Receive, Send], Awaitable[None]]
WsgiApp = Callable[[dict[str, Any], Callable[..., Any]], Iterable[bytes]]


def _resource_attribute(name: str) -> str | None:
    """``service.version`` trong ``OTEL_RESOURCE_ATTRIBUTES`` (``k=v,k=v``, giá trị percent-encoded)."""
    for pair in os.environ.get("OTEL_RESOURCE_ATTRIBUTES", "").split(","):
        key, sep, value = pair.partition("=")
        if sep and key.strip() == name:
            return unquote(value.strip())
    return None


def _histogram_of(registry: CollectorRegistry) -> Histogram:
    """Lấy lại histogram đã đăng ký — dựng middleware hai lần không được ném lúc khởi động.

    Nhưng tên này là tên CHUẨN của OTel semconv: ứng dụng có thể đã tự đăng ký nó với bộ nhãn
    khác. Dùng lại một histogram thiếu nhãn ``ff`` thì mọi lần ghi đều hỏng rồi bị nuốt — mọi
    rollout FLAG_LEVEL hết hạn mà không một dòng log. Nên kiểm và NÉM rõ lúc dựng.
    ``prometheus_client`` không có API công khai để tra collector theo tên — dùng bảng nội bộ.
    """
    existing = getattr(registry, "_names_to_collectors", {}).get(REQUEST_DURATION_METRIC)
    if existing is not None:
        labels = set(getattr(existing, "_labelnames", ()))
        missing = [label for label in REQUEST_DURATION_LABELS if label not in labels]
        if not isinstance(existing, Histogram) or missing:
            detail = f" (thiếu {', '.join(missing)})" if missing else ""
            raise ValueError(
                f"{REQUEST_DURATION_METRIC} đã được đăng ký với kiểu hoặc bộ nhãn khác{detail}"
                " — truyền `registry` riêng cho middleware hoặc bỏ metric trùng tên"
            )
        return existing
    return Histogram(
        REQUEST_DURATION_METRIC,
        "Thời gian xử lý request HTTP (giây), gắn nhãn nhánh flag ff (§6.6)",
        labelnames=REQUEST_DURATION_LABELS,
        buckets=BUCKETS,
        registry=registry,
    )


class _Recorder:
    """Phần chung của hai middleware: nhãn cố định của tiến trình và phép ghi."""

    def __init__(
        self,
        registry: CollectorRegistry | None,
        service_name: str | None,
        service_version: str | None,
    ) -> None:
        self.histogram = _histogram_of(registry if registry is not None else REGISTRY)
        self.service_name = service_name or os.environ.get("OTEL_SERVICE_NAME") or "unknown"
        self.service_version = service_version or _resource_attribute("service.version") or "unknown"

    def record(self, labels: RequestLabels, route: str | None, method: str, status: str, seconds: float) -> None:
        try:
            base = {
                "service_name": self.service_name,
                "service_version": self.service_version,
                "http_route": route or UNMATCHED_ROUTE,
                "http_request_method": method,
                "http_response_status_code": status,
            }
            self.histogram.labels(**base, ff="").observe(seconds)
            for flag_key, variant in list(labels.flags.items()):
                self.histogram.labels(**base, ff=f"{flag_key}={variant}").observe(seconds)
        except Exception:  # noqa: BLE001 — đo lường không bao giờ được làm sập ứng dụng khách (I33)
            pass


def default_asgi_route(scope: Scope) -> str | None:
    """Mẫu route mà router đã khớp (FastAPI đặt ``scope["route"]``), kèm tiền tố mount."""
    path = getattr(scope.get("route"), "path", None)
    return f"{scope.get('root_path', '')}{path}" if isinstance(path, str) else None


class UDPMetricsMiddleware:
    """Middleware ASGI: ``app.add_middleware(UDPMetricsMiddleware)`` hoặc bọc ứng dụng trực tiếp."""

    def __init__(
        self,
        app: AsgiApp,
        *,
        registry: CollectorRegistry | None = None,
        service_name: str | None = None,
        service_version: str | None = None,
        route_of: Callable[[Scope], str | None] = default_asgi_route,
    ) -> None:
        self._app = app
        self._recorder = _Recorder(registry, service_name, service_version)
        self._route_of = route_of

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope.get("type") != "http":
            await self._app(scope, receive, send)
            return
        labels = RequestLabels()
        started = time.perf_counter()
        status: list[str] = []

        async def send_and_watch(message: Message) -> None:
            if message.get("type") == "http.response.start" and not status:
                status.append(str(message.get("status")))
            await send(message)

        token = request_store.set(labels)
        final = "500"
        try:
            await self._app(scope, receive, send_and_watch)
            final = status[0] if status else "500"
        except asyncio.CancelledError:
            # Client huỷ: header đã gửi ⇒ giữ status đã gửi (thứ client đã nhận), chưa ⇒ 499
            final = status[0] if status else CLIENT_CLOSED
            raise
        except BaseException:
            final = status[0] if status else "500"
            raise
        finally:
            request_store.reset(token)
            self._recorder.record(
                labels, self._safe_route(scope), str(scope.get("method", "")), final, time.perf_counter() - started
            )

    def _safe_route(self, scope: Scope) -> str | None:
        try:
            return self._route_of(scope)
        except Exception:  # noqa: BLE001
            return None


def default_wsgi_route(environ: dict[str, Any]) -> str | None:
    """Mẫu route của Flask (``url_rule.rule`` trên request của werkzeug)."""
    request = environ.get("werkzeug.request")
    rule = getattr(getattr(request, "url_rule", None), "rule", None)
    return rule if isinstance(rule, str) else None


class UDPMetricsWSGIMiddleware:
    """Middleware WSGI: ``app.wsgi_app = UDPMetricsWSGIMiddleware(app.wsgi_app)``.

    Thời gian tính tới khi body gửi xong (``close()`` của iterable — như ``finish`` của Node).
    Flag đánh giá trong LÚC sinh body dạng stream không được gắn nhãn — cùng giới hạn với flag
    đánh giá sau khi response đã gửi (§6.6).
    """

    def __init__(
        self,
        app: WsgiApp,
        *,
        registry: CollectorRegistry | None = None,
        service_name: str | None = None,
        service_version: str | None = None,
        route_of: Callable[[dict[str, Any]], str | None] = default_wsgi_route,
    ) -> None:
        self._app = app
        self._recorder = _Recorder(registry, service_name, service_version)
        self._route_of = route_of

    def __call__(self, environ: dict[str, Any], start_response: Callable[..., Any]) -> Iterable[bytes]:
        labels = RequestLabels()
        started = time.perf_counter()
        status: list[str] = []

        def start_and_watch(status_line: str, headers: list[tuple[str, str]], exc_info: Any = None) -> Any:
            status[:] = [status_line.split(" ", 1)[0]]
            return start_response(status_line, headers, exc_info)

        def record(final: str) -> None:
            try:
                route = self._route_of(environ)
            except Exception:  # noqa: BLE001
                route = None
            self._recorder.record(
                labels, route, str(environ.get("REQUEST_METHOD", "")), final, time.perf_counter() - started
            )

        token = request_store.set(labels)
        try:
            body = self._app(environ, start_and_watch)
        except BaseException:
            record(status[0] if status else "500")
            raise
        finally:
            request_store.reset(token)
        return _ClosingBody(body, lambda: record(status[0] if status else CLIENT_CLOSED))


class _ClosingBody:
    """Iterable của response, ghi metric ĐÚNG MỘT lần khi server đóng nó (gửi xong hay client cắt)."""

    def __init__(self, body: Iterable[bytes], on_close: Callable[[], None]) -> None:
        self._body = body
        self._on_close = on_close
        self._closed = False

    def __iter__(self) -> Iterator[bytes]:
        return iter(self._body)

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            close = getattr(self._body, "close", None)
            if callable(close):
                close()
        finally:
            self._on_close()
