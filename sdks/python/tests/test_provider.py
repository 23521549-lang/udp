"""Provider qua SDK OpenFeature THẬT (§6.8) với transport giả — cùng các ca của ``provider.test.ts``.

Vòng đời init, sự kiện (SDK tự phát READY/ERROR của init — provider không phát lặp), ánh xạ
reason/errorCode, fail-static, hook tự gắn, và I33 (không bao giờ ném).
"""

from __future__ import annotations

import math
import os
import subprocess
import sys
import threading
import time
from collections.abc import Iterator
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from hypothesis import HealthCheck, given, settings
from hypothesis import strategies as st
from openfeature import api
from openfeature.evaluation_context import EvaluationContext
from openfeature.event import EventDetails, ProviderEvent
from openfeature.exception import ErrorCode, OpenFeatureError
from openfeature.flag_evaluation import Reason
from support import (
    FAST_SYNC,
    InMemoryTransport,
    ScriptedStream,
    config_body,
    create_provider_for_testing,
    delta_body,
    flag,
    wait_until,
)

from udp_openfeature import RequestLabels, UDPFeatureFlagProvider, request_store
from udp_openfeature._internals import ProviderInternals
from udp_openfeature.provider import json_context
from udp_openfeature.transport import ConfigResult

RULE_ON = {
    "id": "r1",
    "type": "USER_BASED",
    "condition": {"userIds": ["u1"]},
    "serve": {"kind": "variant", "variantKey": "on"},
    "bucketSalt": "s",
    "priority": 0,
}


@pytest.fixture(autouse=True)
def _shutdown_api() -> Iterator[None]:
    yield
    api.shutdown()


def provider_with(transport: InMemoryTransport, init_timeout_ms: float = 2_000, **sync: Any) -> UDPFeatureFlagProvider:
    return create_provider_for_testing(
        ProviderInternals(transport=transport, sync={**FAST_SYNC, "heartbeat_timeout_ms": 5_000, **sync}),
        init_timeout_ms=init_timeout_ms,
    )


def ready_client(flags: list[dict[str, Any]], tracked: list[str] | None = None) -> Any:
    t = InMemoryTransport()
    t.configs.append(ConfigResult("ok", body=config_body(1, flags, tracked), etag='"1"'))
    t.streams.append(ScriptedStream())
    api.set_provider_and_wait(provider_with(t))
    return api.get_client()


# ------------------------------------------------------------- vòng đời


def test_init_cho_snapshot_dau_danh_gia_tai_cho() -> None:
    c = ready_client([flag("f", defaultVariantKey="off", rules=[RULE_ON])])
    hit = c.get_boolean_details("f", False, EvaluationContext(targeting_key="u1"))
    assert (hit.value, hit.variant, hit.reason, hit.flag_metadata) == (
        True,
        "on",
        Reason.TARGETING_MATCH,
        {"ruleId": "r1"},
    )
    miss = c.get_boolean_details("f", True, EvaluationContext(targeting_key="u2"))
    assert (miss.value, miss.variant, miss.reason) == (False, "off", Reason.DEFAULT)


def test_init_qua_han_thi_nem_du_lieu_ve_sau_thi_ready() -> None:
    t = InMemoryTransport()
    stream = ScriptedStream()
    t.streams.append(stream)
    provider = provider_with(t, init_timeout_ms=100)
    with pytest.raises(OpenFeatureError):
        api.set_provider_and_wait(provider)
    c = api.get_client()
    assert c.get_boolean_details("f", True).error_code == ErrorCode.PROVIDER_NOT_READY
    ready: list[EventDetails] = []
    c.add_handler(ProviderEvent.PROVIDER_READY, ready.append)
    stream.event("snapshot", config_body(1, [flag("f")]))
    wait_until(lambda: len(ready) >= 1)
    assert c.get_boolean_value("f", False) is True


def test_401_luc_init_thi_nem_ngay() -> None:
    t = InMemoryTransport()
    t.configs.append(ConfigResult("unauthorized"))
    started = time.monotonic()
    with pytest.raises(OpenFeatureError, match="401"):
        api.set_provider_and_wait(provider_with(t, init_timeout_ms=5_000))
    assert time.monotonic() - started < 2


def test_configuration_changed_mang_flags_changed_that_su_doi() -> None:
    t = InMemoryTransport()
    t.configs.append(ConfigResult("ok", body=config_body(1, [flag("a"), flag("b")]), etag='"1"'))
    stream = ScriptedStream()
    t.streams.append(stream)
    api.set_provider_and_wait(provider_with(t))
    changes: list[list[str] | None] = []
    api.get_client().add_handler(
        ProviderEvent.PROVIDER_CONFIGURATION_CHANGED, lambda e: changes.append(e.flags_changed)
    )
    after = {"flags": [flag("a", isEnabled=False), flag("b")], "segments": [], "trackedFlags": ["a"]}
    stream.event(
        "flag_changed",
        delta_body(
            1,
            2,
            after,
            [
                {"configVersion": 2, "kind": "flag", "flag": flag("a", isEnabled=False)},
                {"configVersion": 2, "kind": "trackedFlags", "trackedFlags": ["a"]},
            ],
        ),
    )
    wait_until(lambda: len(changes) == 1)
    assert changes == [["a"]]


def test_401_luc_init_roi_khoa_duoc_nhan_lai_thi_dung_mot_ready() -> None:
    t = InMemoryTransport()
    t.configs.extend([ConfigResult("unauthorized"), ConfigResult("ok", body=config_body(1, [flag("f")]), etag='"1"')])
    t.streams.append(ScriptedStream())
    provider = provider_with(t)
    readies: list[EventDetails] = []
    api.add_handler(ProviderEvent.PROVIDER_READY, readies.append)
    try:
        with pytest.raises(OpenFeatureError, match="401"):
            api.set_provider_and_wait(provider)
        wait_until(lambda: provider.config_version == 1)
        time.sleep(0.1)
        # Handler toàn cục chạy ngay cho provider no-op đang READY lúc đăng ký — chỉ đếm của udp
        assert [e.provider_name for e in readies if e.provider_name == "udp"] == ["udp"]
    finally:
        api.remove_handler(ProviderEvent.PROVIDER_READY, readies.append)


def test_dong_giua_luc_init_thi_init_ket_thuc_ngay() -> None:
    provider = provider_with(InMemoryTransport(), init_timeout_ms=10_000)
    errors: list[BaseException] = []

    def run() -> None:
        try:
            provider.initialize(EvaluationContext())
        except OpenFeatureError as err:
            errors.append(err)

    started = time.monotonic()
    runner = threading.Thread(target=run)
    runner.start()
    time.sleep(0.05)
    provider.shutdown()
    runner.join(2)
    assert errors and "đóng" in str(errors[0])
    assert time.monotonic() - started < 1


def test_tien_trinh_thoat_duoc_du_quen_shutdown_va_init_nem_khi_khong_toi_duoc() -> None:
    probe = Path(__file__).parent / "fixtures" / "init_exit_probe.py"
    src = Path(__file__).resolve().parents[1] / "src"
    done = subprocess.run(
        [sys.executable, str(probe)],
        capture_output=True,
        text=True,
        timeout=30,
        env={**os.environ, "PYTHONPATH": str(src)},
        check=False,
    )
    assert done.returncode == 0, done.stderr
    assert "init rejected" in done.stdout


# ------------------------------------------------------------- cấu hình


@pytest.mark.parametrize(
    ("stale", "polling"),
    [(30, None), (50, None), (100, 120_000), (math.nan, None)],
)
def test_stale_khong_dai_hon_nhip_tim_hoac_polling_thi_valueerror(stale: float, polling: float | None) -> None:
    extra: dict[str, Any] = {} if polling is None else {"polling_interval_ms": polling}
    with pytest.raises(ValueError):
        UDPFeatureFlagProvider("http://unused", "k", stale_after_seconds=stale, **extra)


def test_stale_60_giay_la_hop_le() -> None:
    UDPFeatureFlagProvider("http://unused", "k", stale_after_seconds=60)


@pytest.mark.parametrize(
    "bad",
    [
        {"polling_interval_ms": 0},
        {"polling_interval_ms": math.nan},
        {"sse_failures_before_fallback": 0},
        {"sse_failures_before_fallback": 1.5},
        {"sse_failures_before_fallback": True},
        {"init_timeout_ms": math.nan},
        {"init_timeout_ms": -1},
    ],
)
def test_so_khong_duong_hoac_nan_thi_valueerror(bad: dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        UDPFeatureFlagProvider("http://unused", "k", **bad)


def test_host_khong_phai_url_http_thi_valueerror() -> None:
    with pytest.raises(ValueError):
        UDPFeatureFlagProvider("flags.udp.example", "k")


# ------------------------------------------------------------- ánh xạ kết quả


def test_disabled_bia_mo_khong_co_sai_kieu() -> None:
    c = ready_client([flag("off", isEnabled=False), {"key": "old", "archived": True}])
    d = c.get_boolean_details("off", True)
    assert (d.value, d.reason) == (True, Reason.DISABLED)
    old = c.get_boolean_details("old", False)
    assert (old.reason, old.flag_metadata) == (Reason.DISABLED, {"archived": True})
    assert c.get_boolean_details("none", False).error_code == ErrorCode.FLAG_NOT_FOUND
    assert c.get_string_details("off", "x").error_code == ErrorCode.TYPE_MISMATCH


def test_number_tach_integer_va_float_khong_lam_tron_im_lang() -> None:
    c = ready_client(
        [
            flag("n", type="NUMBER", variants={"on": 5, "off": 2.5}),
            flag("h", type="NUMBER", variants={"on": 2.5, "off": 1}),
        ]
    )
    assert c.get_integer_value("n", 0) == 5
    assert c.get_float_value("n", 0.0) == 5.0
    assert c.get_float_value("h", 0.0) == 2.5
    half = c.get_integer_details("h", 7)
    assert (half.value, half.error_code) == (7, ErrorCode.TYPE_MISMATCH)


def test_json_flag_va_gia_tri_null_la_sai_kieu() -> None:
    c = ready_client([flag("j", type="JSON", variants={"on": {"a": [1]}, "off": None})])
    assert c.get_object_value("j", {}) == {"a": [1]}
    c2 = ready_client([flag("j", type="JSON", variants={"on": None, "off": {}})])
    assert c2.get_object_details("j", {"d": 1}).error_code == ErrorCode.TYPE_MISMATCH


def test_datetime_trong_context_theo_ngu_nghia_json() -> None:
    at = datetime(2026, 9, 22, tzinfo=UTC)
    rule = {
        "id": "r",
        "type": "ATTRIBUTE_BASED",
        "condition": {"all": [{"attribute": "since", "operator": "eq", "value": "2026-09-22T00:00:00.000Z"}]},
        "serve": {"kind": "variant", "variantKey": "on"},
        "bucketSalt": "s",
        "priority": 0,
    }
    c = ready_client([flag("d", defaultVariantKey="off", rules=[rule])])
    assert c.get_boolean_value("d", False, EvaluationContext(attributes={"since": at})) is True


def test_nan_thanh_null_thuoc_tinh_vang() -> None:
    rule = {
        "id": "r",
        "type": "ATTRIBUTE_BASED",
        "condition": {"all": [{"attribute": "age", "operator": "neq", "value": 5}]},
        "serve": {"kind": "variant", "variantKey": "on"},
        "bucketSalt": "s",
        "priority": 0,
    }
    c = ready_client([flag("n", defaultVariantKey="off", rules=[rule])])
    d = c.get_boolean_details("n", True, EvaluationContext(attributes={"age": math.nan}))
    assert (d.value, d.reason) == (False, Reason.DEFAULT)
    assert c.get_boolean_value("n", False, EvaluationContext(attributes={"age": 7})) is True


def test_json_context_gom_targeting_key_datetime_long_va_so_nguyen_lon() -> None:
    ctx = EvaluationContext(
        targeting_key="u",
        attributes={
            "when": {"at": datetime(2026, 1, 2, 3, 4, 5, 678_901, tzinfo=UTC)},
            "big": 2**60,
            "inf": math.inf,
            "items": [1, math.nan],
        },
    )
    assert json_context(ctx) == {
        "targetingKey": "u",
        "when": {"at": "2026-01-02T03:04:05.678Z"},
        "big": float(2**60),
        "inf": None,
        "items": [1, None],
    }


# ------------------------------------------------------------- hook tự gắn


def test_chi_tracked_flag_co_variant_duoc_ghi_vao_store() -> None:
    c = ready_client([flag("t"), flag("u"), flag("off", isEnabled=False)], ["t", "off"])
    labels = RequestLabels()
    token = request_store.set(labels)
    try:
        c.get_boolean_value("t", False)
        c.get_boolean_value("u", False)
        c.get_boolean_value("off", False)
    finally:
        request_store.reset(token)
    assert labels.flags == {"t": "on"}


def test_ngoai_request_hook_khong_lam_gi() -> None:
    c = ready_client([flag("t")], ["t"])
    assert c.get_boolean_value("t", False) is True


# ------------------------------------------------------------- chỗ tiêm test


def test_constructor_nem_giua_chung_thi_khe_van_duoc_xoa() -> None:
    t = InMemoryTransport()
    with pytest.raises(ValueError):
        create_provider_for_testing(ProviderInternals(transport=t), polling_interval_ms=0)
    plain = UDPFeatureFlagProvider("http://127.0.0.1:9", "k", init_timeout_ms=200, report_stats=False)
    with pytest.raises(OpenFeatureError):
        plain.initialize(EvaluationContext())
    plain.shutdown()
    assert t.config_calls == []
    assert t.stream_calls == []


# ------------------------------------------------------------- I33


json_values = st.recursive(
    st.none() | st.booleans() | st.integers() | st.floats() | st.text(),
    lambda children: st.lists(children, max_size=4) | st.dictionaries(st.text(max_size=8), children, max_size=4),
    max_leaves=12,
)
context_values = st.recursive(
    st.none() | st.booleans() | st.integers() | st.floats() | st.text() | st.datetimes(),
    lambda children: st.lists(children, max_size=3) | st.dictionaries(st.text(max_size=6), children, max_size=3),
    max_leaves=8,
)


def assert_typed(c: Any, key: str, ctx: EvaluationContext) -> str:
    d = c.get_boolean_details(key, False, ctx)
    assert isinstance(d.value, bool)
    assert isinstance(c.get_string_value(key, "d", ctx), str)
    assert isinstance(c.get_integer_value(key, 1, ctx), int)
    assert isinstance(c.get_float_value(key, 1.5, ctx), float)
    assert isinstance(c.get_object_value(key, {"a": 1}, ctx), (dict, list))
    return str(d.reason)


@settings(max_examples=30, deadline=None, suppress_health_check=[HealthCheck.too_slow])
@given(body=json_values, attributes=st.dictionaries(st.text(max_size=8), context_values, max_size=4))
def test_fuzz_snapshot_rac_context_rac_luon_dung_kieu(body: Any, attributes: dict[str, Any]) -> None:
    t = InMemoryTransport()
    t.configs.append(ConfigResult("ok", body=body, etag='"1"'))
    s = ScriptedStream()
    t.streams.append(s)
    s.event("snapshot", body)
    with suppress(OpenFeatureError):
        api.set_provider_and_wait(provider_with(t, init_timeout_ms=50))
    assert_typed(api.get_client(), "f", EvaluationContext(attributes=attributes))
    api.shutdown()


TYPED = [
    flag("b"),
    flag("s", type="STRING", variants={"on": "x", "off": "y"}),
    flag("n", type="NUMBER", variants={"on": 1, "off": 2}),
    flag("j", type="JSON", variants={"on": {"a": 1}, "off": []}),
    flag(
        "r",
        rules=[
            {
                "id": "r1",
                "type": "ATTRIBUTE_BASED",
                "condition": {
                    "all": [
                        {"attribute": "plan", "operator": "in", "value": ["pro"]},
                        {"attribute": "v", "operator": "semverGte", "value": "1.2.0"},
                        {"attribute": "e", "operator": "regex", "value": "^a.*$"},
                    ]
                },
                "serve": {
                    "kind": "distribution",
                    "weights": [{"variantKey": "on", "weight": 50_000}, {"variantKey": "off", "weight": 50_000}],
                },
                "bucketSalt": "s",
                "priority": 0,
            }
        ],
    ),
]


def test_fuzz_context_bat_ky_tren_snapshot_that() -> None:
    c = ready_client(TYPED)
    reasons: set[str] = set()

    @settings(max_examples=150, deadline=None)
    @given(
        attributes=st.dictionaries(st.text(max_size=8), context_values, max_size=5),
        key=st.sampled_from(["b", "s", "n", "j", "r", "missing"]),
    )
    def run(attributes: dict[str, Any], key: str) -> None:
        reasons.add(assert_typed(c, key, EvaluationContext(attributes=attributes)))

    run()
    assert "ERROR" in reasons
    assert any(r != "ERROR" for r in reasons)


def test_fuzz_event_rac_sau_ready_van_phuc_vu_dung_kieu() -> None:
    t = InMemoryTransport()
    t.configs.append(ConfigResult("ok", body=config_body(1, TYPED), etag='"1"'))
    t.default_config = ConfigResult("not-modified")
    streams = [ScriptedStream() for _ in range(80)]
    t.streams.extend(streams)
    api.set_provider_and_wait(provider_with(t))
    c = api.get_client()
    counter = iter(range(10_000))

    @settings(max_examples=60, deadline=None)
    @given(event=st.sampled_from(["snapshot", "flag_changed", "segment_changed", "message"]), data=json_values)
    def run(event: str, data: Any) -> None:
        streams[min(next(counter), len(streams) - 1)].event(event, data)
        time.sleep(0.001)
        assert isinstance(c.get_boolean_value("b", False), bool)
        assert isinstance(c.get_string_value("s", "d"), str)

    run()
