"""Provider THẬT qua HTTP THẬT tới một Service 2 giả lập đúng dây §9 — mọi tầng cùng lúc.

Bootstrap ``/sdk/config`` (ETag), stream chunked từ ĐÚNG version đã áp, delta đổi nội dung ⇒
CONFIGURATION_CHANGED, I15c (cache dựng bằng delta trùng ``/sdk/config`` cùng version — cả hash),
nhãn ``ff`` cho flag tracked, và lần gửi stats cuối lúc ``shutdown``.
"""

from __future__ import annotations

import json
import queue
from collections.abc import Iterator
from typing import Any

import pytest
from http_fake import FakeServer, Request
from openfeature import api
from openfeature.evaluation_context import EvaluationContext
from openfeature.event import ProviderEvent
from support import config_body, delta_body, flag, wait_until

from udp_openfeature import RequestLabels, request_store
from udp_openfeature._internals import ProviderInternals, with_internals
from udp_openfeature.evaluator import config_hash_of
from udp_openfeature.provider import UDPFeatureFlagProvider
from udp_openfeature.store import ConfigStore

SPLIT_RULE = {
    "id": "r-split",
    "type": "ALL",
    "condition": {},
    "serve": {
        "kind": "distribution",
        "weights": [{"variantKey": "on", "weight": 30_000}, {"variantKey": "off", "weight": 70_000}],
    },
    "bucketSalt": "salt-split",
    "priority": 1,
}


class FakeService2:
    def __init__(self) -> None:
        self.v1 = config_body(1, [flag("checkout-v2", defaultVariantKey="off", rules=[SPLIT_RULE]), flag("banner")])
        self.events: queue.Queue[str] = queue.Queue()
        self.stats: list[dict[str, Any]] = []
        self.stream_paths: list[str] = []
        self.server = FakeServer(self._handle)

    def _handle(self, req: Request) -> None:
        assert req.headers["Authorization"] == "Bearer udp_sk_e2e"
        if req.path.startswith("/sdk/config"):
            if req.headers.get("If-None-Match") == '"1"':
                req.send(304)
                return
            req.send(200, {"Content-Type": "application/json", "ETag": '"1"'}, json.dumps(self.v1).encode())
            return
        if req.path.startswith("/sdk/stats"):
            self.stats.append(json.loads(req.body))
            req.send(202)
            return
        self.stream_paths.append(req.path)
        req.start_stream()
        if not req.chunk("retry: 2000\n: mở\n\n"):
            return
        while True:
            try:
                frame = self.events.get(timeout=0.05)
            except queue.Empty:
                if not req.chunk(":\n\n"):  # nhịp tim
                    return
                continue
            if not req.chunk(frame):
                return

    def push(self, event: str, data: Any) -> None:
        self.events.put(f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n")


@pytest.fixture()
def s2() -> Iterator[FakeService2]:
    fake = FakeService2()
    yield fake
    api.shutdown()
    fake.server.close()


def test_provider_that_qua_http_that(s2: FakeService2) -> None:
    store = ConfigStore()
    provider = with_internals(
        ProviderInternals(store=store), lambda: UDPFeatureFlagProvider(s2.server.base, "udp_sk_e2e")
    )
    api.set_provider_and_wait(provider)
    client = api.get_client()
    wait_until(lambda: s2.stream_paths == ["/sdk/stream?since=1"])

    users = [f"user-{i}" for i in range(400)]
    on = [u for u in users if client.get_boolean_value("checkout-v2", False, EvaluationContext(targeting_key=u))]
    assert 80 < len(on) < 160  # 30% của 400, cùng hàm băm với Service 2

    changed: list[list[str] | None] = []
    client.add_handler(ProviderEvent.PROVIDER_CONFIGURATION_CHANGED, lambda e: changed.append(e.flags_changed))
    v2_flags = [flag("checkout-v2", defaultVariantKey="off", rules=[SPLIT_RULE]), flag("banner", isEnabled=False)]
    after = {"flags": v2_flags, "segments": [], "trackedFlags": ["checkout-v2"]}
    s2.push(
        "flag_changed",
        delta_body(
            1,
            2,
            after,
            [
                {"configVersion": 2, "kind": "flag", "flag": flag("banner", isEnabled=False)},
                {"configVersion": 2, "kind": "trackedFlags", "trackedFlags": ["checkout-v2"]},
            ],
        ),
    )
    wait_until(lambda: changed == [["banner"]])
    assert client.get_boolean_details("banner", True).reason == "DISABLED"
    # I15c: cache dựng bằng DELTA trùng từng bit với snapshot server ghi ở version 2
    assert store.config_version == 2
    assert config_hash_of(store.snapshot or {}) == config_hash_of(after)
    assert s2.stream_paths == ["/sdk/stream?since=1"]  # không một lần RESYNC

    labels = RequestLabels()
    token = request_store.set(labels)
    try:
        variant = client.get_boolean_details("checkout-v2", False, EvaluationContext(targeting_key="user-1")).variant
    finally:
        request_store.reset(token)
    assert labels.flags == {"checkout-v2": variant}

    api.shutdown()
    counts = {(c["flagKey"], c["variant"]): c["count"] for r in s2.stats for c in r["counts"]}
    assert counts[("checkout-v2", "on")] + counts[("checkout-v2", "off")] == 401
    assert counts[("banner", "__disabled__")] == 1
