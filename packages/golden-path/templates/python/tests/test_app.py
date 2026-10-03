"""Test của ứng dụng — chạy trong pipeline (``pytest``). Provider trong bộ nhớ thay UDP: không mạng.

Hook nhãn ``ff`` gắn tay ở đây; với ``UDPFeatureFlagProvider`` thật, provider tự gắn nó.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient
from openfeature import api
from openfeature.client import OpenFeatureClient
from openfeature.evaluation_context import EvaluationContext
from openfeature.flag_evaluation import FlagResolutionDetails
from openfeature.provider.in_memory_provider import InMemoryFlag, InMemoryProvider
from prometheus_client import CollectorRegistry
from udp_openfeature import UDPRequestLabelHook

from app.main import HELLO_FLAG, create_app

DOMAIN = "golden-path-test"


def _vip_only(flag: InMemoryFlag[bool], ctx: EvaluationContext) -> FlagResolutionDetails[bool]:
    variant = "on" if ctx.targeting_key == "vip" else "off"
    return FlagResolutionDetails(value=flag.variants[variant], variant=variant)


@pytest.fixture()
def flags() -> Iterator[OpenFeatureClient]:
    provider = InMemoryProvider(
        {HELLO_FLAG: InMemoryFlag("off", {"on": True, "off": False}, context_evaluator=_vip_only)}
    )
    api.set_provider_and_wait(provider, DOMAIN)
    client = api.get_client(DOMAIN)
    client.add_hooks([UDPRequestLabelHook(lambda: {HELLO_FLAG})])
    yield client
    api.shutdown()


def test_healthz(flags: OpenFeatureClient) -> None:
    client = TestClient(create_app(flags, CollectorRegistry()))
    assert client.get("/healthz").json() == {"ok": True}


def test_route_danh_gia_flag_va_metrics_co_nhan_ff(flags: OpenFeatureClient) -> None:
    client = TestClient(create_app(flags, CollectorRegistry()))
    assert client.get("/api/hello", params={"user": "vip"}).json()["v2"] is True
    assert client.get("/api/hello", params={"user": "an"}).json()["v2"] is False
    text = client.get("/metrics").text
    assert "http_server_request_duration_seconds" in text
    assert f'ff="{HELLO_FLAG}=on"' in text
    assert f'ff="{HELLO_FLAG}=off"' in text
    assert 'http_route="/api/hello"' in text
