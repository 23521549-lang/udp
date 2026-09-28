"""Ứng dụng FastAPI theo Golden Path (§11.1).

``/healthz`` và ``/metrics`` nằm NGOÀI middleware đo: chúng không phải lưu lượng người dùng, đếm chúng
làm bẩn tỉ lệ lỗi mà UDP phân tích khi rollout. Mọi route nghiệp vụ nằm trong ứng dụng con được bọc
bởi ``UDPMetricsMiddleware``.

Middleware ghi histogram ``http_server_request_duration_seconds`` với nhãn ``ff`` — một series tổng
``ff=""`` cộng một series cho mỗi flag đang rollout đã được đánh giá trong request. ``service_name`` lấy
từ ``OTEL_SERVICE_NAME`` (PHẢI bằng tên workload), ``service_version`` từ ``service.version`` trong
``OTEL_RESOURCE_ATTRIBUTES`` — manifest ``k8s/deployment.yaml`` đặt cả hai.
"""

from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator, Callable
from contextlib import AbstractAsyncContextManager, asynccontextmanager

from fastapi import FastAPI, Response
from openfeature import api
from openfeature.client import OpenFeatureClient
from openfeature.evaluation_context import EvaluationContext
from prometheus_client import CONTENT_TYPE_LATEST, REGISTRY, CollectorRegistry, generate_latest
from udp_openfeature.metrics import UDPMetricsMiddleware

from .telemetry import start_feature_flags, stop_feature_flags

# Flag mẫu — tạo trên Portal (kiểu BOOLEAN) rồi rollout nó để thấy nhãn `ff` trên /metrics
HELLO_FLAG = "hello-v2"

Lifespan = Callable[[FastAPI], AbstractAsyncContextManager[None]]


def create_app(flags: OpenFeatureClient, registry: CollectorRegistry, lifespan: Lifespan | None = None) -> FastAPI:
    business = FastAPI()

    @business.get("/api/hello")
    def hello(user: str = "anonymous") -> dict[str, object]:
        # `targeting_key` là khoá dính của phân phối phần trăm — cùng người dùng, cùng nhánh
        v2 = flags.get_boolean_value(HELLO_FLAG, False, EvaluationContext(targeting_key=user))
        return {"message": f"Xin chào {user} 👋" if v2 else f"Chào {user}", "v2": v2}

    app = FastAPI(lifespan=lifespan)

    @app.get("/healthz")
    def healthz() -> dict[str, bool]:
        return {"ok": True}

    @app.get("/metrics")
    def metrics() -> Response:
        return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)

    app.mount("/", UDPMetricsMiddleware(business, registry=registry))
    return app


@asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    # `set_provider_and_wait` chặn tới khi có cấu hình (tối đa 10 giây) — chạy ngoài vòng sự kiện
    await asyncio.to_thread(start_feature_flags)
    yield
    await asyncio.to_thread(stop_feature_flags)


app = create_app(api.get_client(), REGISTRY, _lifespan)
