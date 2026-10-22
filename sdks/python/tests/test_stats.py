"""``report_stats`` của provider (§6.8, V7/V8) — cùng các ca của ``stats.test.ts`` (Node).

Trọng tâm là R19: telemetry không làm hỏng đánh giá (I33), không giữ tiến trình của khách sống,
không chặn ``shutdown()``, và KHÔNG BAO GIỜ đếm đôi.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import pytest
from hypothesis import given, settings
from hypothesis import strategies as st
from openfeature.evaluation_context import EvaluationContext
from support import (
    FAST_SYNC,
    InMemoryTransport,
    ScriptedStream,
    config_body,
    create_provider_for_testing,
    flag,
    wait_until,
)

from udp_openfeature._internals import ProviderInternals
from udp_openfeature.provider import UDPFeatureFlagProvider
from udp_openfeature.stats import StatsCounter, StatsOptions, StatsReporter, stats_variant_of
from udp_openfeature.transport import ConfigResult, StatsPostResult, StreamOpen

INTERVAL_MS = 25
# `random() = 0.5` ⇒ hệ số jitter đúng 1, chu kỳ tất định
FAST_STATS = StatsOptions(interval_ms=INTERVAL_MS, random=lambda: 0.5)


def provider_with(
    transport: InMemoryTransport, stats: StatsOptions = FAST_STATS, **options: Any
) -> UDPFeatureFlagProvider:
    return create_provider_for_testing(
        ProviderInternals(transport=transport, sync={**FAST_SYNC, "heartbeat_timeout_ms": 5_000}, stats=stats),
        init_timeout_ms=2_000,
        **options,
    )


def ready_transport(flags: list[dict[str, Any]] | None = None) -> InMemoryTransport:
    t = InMemoryTransport()
    t.configs.append(ConfigResult("ok", body=config_body(1, flags or [flag("f"), flag("g")]), etag='"1"'))
    t.streams.append(ScriptedStream())
    return t


def totals(reports: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for report in reports:
        for entry in report["counts"]:
            key = f"{entry['flagKey']}|{entry['variant']}"
            out[key] = out.get(key, 0) + entry["count"]
    return out


def reports_reach(t: InMemoryTransport, n: int) -> Callable[[], bool]:
    return lambda: len(t.stats_reports) == n


def evaluate_boolean(provider: UDPFeatureFlagProvider, key: str, times: int = 1) -> None:
    for _ in range(times):
        provider.resolve_boolean_details(key, False, EvaluationContext())


def started(provider: UDPFeatureFlagProvider) -> UDPFeatureFlagProvider:
    provider.initialize(EvaluationContext())
    return provider


# ------------------------------------------------------------- bộ đếm


def test_dem_theo_flag_variant_shutdown_thi_dung_mot_bao_cao() -> None:
    t = ready_transport()
    p = started(provider_with(t, replace(FAST_STATS, interval_ms=60_000)))
    evaluate_boolean(p, "f", 3)
    evaluate_boolean(p, "g", 2)
    p.shutdown()
    assert len(t.stats_reports) == 1
    assert totals(t.stats_reports) == {"f|on": 3, "g|on": 2}
    assert t.stats_reports[0]["sdk"] == {"name": "udp-openfeature-provider-python"}


def test_nhan_disabled_error_va_ca_khong_dem() -> None:
    assert stats_variant_of({"reason": "DISABLED"}) == "__disabled__"
    assert stats_variant_of({"reason": "DISABLED", "archived": True}) == "__disabled__"
    assert stats_variant_of({"reason": "ERROR", "errorCode": "TYPE_MISMATCH"}) == "__error__"
    assert stats_variant_of({"reason": "ERROR", "errorCode": "FLAG_NOT_FOUND"}) is None
    assert stats_variant_of({"reason": "ERROR", "errorCode": "PROVIDER_NOT_READY"}) is None
    assert stats_variant_of({"reason": "SPLIT", "variant": "b", "value": 1}) == "b"

    t = ready_transport([flag("f"), flag("off", isEnabled=False)])
    p = started(provider_with(t, replace(FAST_STATS, interval_ms=60_000)))
    evaluate_boolean(p, "off")
    p.resolve_string_details("f", "x", EvaluationContext())
    evaluate_boolean(p, "khong-co", 5)
    p.shutdown()
    assert totals(t.stats_reports) == {"off|__disabled__": 1, "f|__error__": 1}


def test_chua_co_du_lieu_thi_khong_dem() -> None:
    t = InMemoryTransport()
    p = provider_with(t)
    evaluate_boolean(p, "f", 3)
    p.shutdown()
    assert t.stats_reports == []


def test_het_chu_ky_thi_mot_bao_cao_cua_so_rong_khong_request() -> None:
    t = ready_transport()
    p = started(provider_with(t))
    evaluate_boolean(p, "f")
    wait_until(lambda: len(t.stats_reports) == 1)
    time.sleep(INTERVAL_MS * 6 / 1000)
    assert len(t.stats_reports) == 1
    p.shutdown()


def test_shutdown_voi_bo_dem_rong_khong_goi_post() -> None:
    t = ready_transport()
    p = started(provider_with(t, replace(FAST_STATS, interval_ms=60_000)))
    p.shutdown()
    assert t.stats_reports == []


def test_report_stats_false_khong_dem_khong_luong_khong_request() -> None:
    t = ready_transport()
    before = {th.name for th in threading.enumerate()}
    p = started(provider_with(t, report_stats=False))
    evaluate_boolean(p, "f", 5)
    assert "udp-stats" not in {th.name for th in threading.enumerate()} - before
    p.shutdown()
    assert t.stats_reports == []


def test_mot_lo_khong_vuot_max_entries_phan_du_di_luot_sau() -> None:
    flags = [flag(f"k{i}") for i in range(7)]
    t = ready_transport(flags)
    p = started(provider_with(t, replace(FAST_STATS, max_entries_per_report=3)))
    for f in flags:
        evaluate_boolean(p, f["key"])
    wait_until(lambda: len(totals(t.stats_reports)) == 7)
    p.shutdown()
    sizes = [len(r["counts"]) for r in t.stats_reports]
    assert max(sizes) <= 3
    assert len(sizes) >= 3


# ------------------------------------------------------------- phân loại phản hồi (V7)


def test_429_gop_lo_lai_va_ton_trong_retry_after() -> None:
    t = ready_transport()
    t.stats.append(StatsPostResult("retry", retry_after_ms=1_000))
    p = started(provider_with(t))
    evaluate_boolean(p, "f", 2)
    wait_until(lambda: len(t.stats_reports) == 1)
    evaluate_boolean(p, "f", 3)
    # Retry-After 1 000 ms ≫ chu kỳ 25 ms: lượt sau KHÔNG được tới sớm
    time.sleep(INTERVAL_MS * 8 / 1000)
    assert len(t.stats_reports) == 1
    wait_until(lambda: len(t.stats_reports) == 2, 3)
    p.shutdown()
    assert totals(t.stats_reports) == {"f|on": 2 + 2 + 3}


def test_qua_han_hoac_ma_la_thi_bo_lo_khong_gui_lai() -> None:
    t = ready_transport()
    t.stats.append(StatsPostResult("ambiguous"))
    p = started(provider_with(t))
    evaluate_boolean(p, "f", 4)
    wait_until(lambda: len(t.stats_reports) == 1)
    evaluate_boolean(p, "f", 1)
    wait_until(lambda: len(t.stats_reports) == 2)
    p.shutdown()
    assert totals(t.stats_reports) == {"f|on": 4 + 1}


def test_400_bo_lo_va_dung_mot_chan_doan_moi_phien(caplog: pytest.LogCaptureFixture) -> None:
    t = ready_transport()
    t.default_stats = StatsPostResult("rejected")
    logger = logging.getLogger("udp-test-stats")
    p = started(provider_with(t, logger=logger))
    with caplog.at_level(logging.WARNING, logger="udp-test-stats"):
        for sent in range(1, 5):
            evaluate_boolean(p, "f")
            wait_until(reports_reach(t, sent))
        p.shutdown()
    assert len([r for r in caplog.records if "/sdk/stats" in r.getMessage()]) == 1


def test_404_ngung_gui_khoa_duoc_nhan_lai_thi_gui_tiep() -> None:
    t = ready_transport()
    t.stats.append(StatsPostResult("stop"))
    first = t.streams[0]
    assert isinstance(first, ScriptedStream)
    # Stream đầu kết thúc ⇒ 401 ⇒ polling đọc cấu hình này ⇒ authorized ⇒ READY trở lại
    t.streams.append(StreamOpen("unauthorized"))
    t.configs.append(ConfigResult("ok", body=config_body(2, [flag("f")]), etag='"2"'))
    p = started(provider_with(t))
    evaluate_boolean(p, "f", 2)
    wait_until(lambda: len(t.stats_reports) == 1)
    evaluate_boolean(p, "f", 3)
    time.sleep(INTERVAL_MS * 6 / 1000)
    assert len(t.stats_reports) == 1
    first.end()
    wait_until(lambda: len(t.stats_reports) == 2, 5)
    p.shutdown()
    assert totals(t.stats_reports) == {"f|on": 2 + 3}


# ------------------------------------------------------------- không chặn ứng dụng khách (R19)


def test_post_stats_nem_khong_lot_vao_ung_dung() -> None:
    t = ready_transport()
    t.stats.extend(["throw", StatsPostResult("retry")])
    p = started(provider_with(t))
    evaluate_boolean(p, "f", 2)
    wait_until(lambda: len(t.stats_reports) == 1)
    evaluate_boolean(p, "f")
    wait_until(lambda: len(t.stats_reports) >= 2)
    details = p.resolve_boolean_details("f", False, EvaluationContext())
    assert (details.value, details.error_code) == (True, None)
    p.shutdown()


def test_shutdown_luc_bao_cao_dang_bay_ve_trong_han_khong_bao_doi() -> None:
    t = ready_transport()
    t.stats.append("hang")
    p = started(provider_with(t, replace(FAST_STATS, shutdown_flush_timeout_ms=150)))
    evaluate_boolean(p, "f", 2)
    wait_until(lambda: len(t.stats_reports) == 1)
    began = time.monotonic()
    p.shutdown()
    assert time.monotonic() - began < 2
    assert len(t.stats_reports) == 1


def test_server_treo_o_lan_gui_cuoi_shutdown_van_ve_trong_han() -> None:
    t = ready_transport()
    t.stats.append("hang")
    p = started(provider_with(t, replace(FAST_STATS, interval_ms=60_000, shutdown_flush_timeout_ms=150)))
    evaluate_boolean(p, "f")
    began = time.monotonic()
    p.shutdown()
    assert time.monotonic() - began < 2
    assert len(t.stats_reports) == 1


def test_record_sau_close_khong_dem_close_hai_lan_vo_hai() -> None:
    t = InMemoryTransport()
    reporter = StatsReporter(t, lambda _m: None, FAST_STATS)
    reporter.start()
    reporter.close()
    reporter.record("f", {"reason": "DEFAULT", "variant": "on", "value": True})
    reporter.close()
    assert reporter.counter.is_empty
    assert t.stats_reports == []


def test_resume_sau_stop_moi_gui_tiep() -> None:
    t = InMemoryTransport()
    t.stats.append(StatsPostResult("stop"))
    reporter = StatsReporter(t, lambda _m: None, FAST_STATS)
    reporter.start()
    reporter.record("f", {"reason": "DEFAULT", "variant": "on"})
    wait_until(lambda: len(t.stats_reports) == 1)
    reporter.record("f", {"reason": "DEFAULT", "variant": "on"})
    time.sleep(INTERVAL_MS * 5 / 1000)
    assert len(t.stats_reports) == 1
    reporter.resume()
    wait_until(lambda: len(t.stats_reports) == 2)
    reporter.close()


# ------------------------------------------------------------- StatsCounter


def test_cham_tran_thi_bo_cap_moi_khong_bo_luot_cua_cap_da_co() -> None:
    c = StatsCounter(2, 1_000)
    for key in ("a", "b", "c"):
        c.record(key, "on")
    c.record("a", "on")
    c.record("a", "off")
    assert sorted((e.flag_key, e.variant, e.count) for e in c.take(10)) == [("a", "on", 2), ("b", "on", 1)]
    assert c.is_empty


def test_bao_hoa_o_max_count() -> None:
    c = StatsCounter(10, 3)
    for _ in range(5):
        c.record("a", "on")
    c.restore(list(c.take(1)) * 2)
    assert [e.count for e in c.take(1)] == [3]


@settings(max_examples=100, deadline=None)
@given(
    ops=st.lists(st.tuples(st.sampled_from(["f1", "f2", "f3"]), st.sampled_from(["on", "off", "x"])), max_size=60),
    limit=st.integers(min_value=1, max_value=4),
)
def test_property_flushed_cong_pending_bang_input(ops: list[tuple[str, str]], limit: int) -> None:
    c = StatsCounter(100, 1_000_000)
    for key, variant in ops:
        c.record(key, variant)
    flushed: dict[tuple[str, str], int] = {}
    while not c.is_empty:
        batch = c.take(limit)
        assert 0 < len(batch) <= limit
        assert len({(e.flag_key, e.variant) for e in batch}) == len(batch)
        for e in batch:
            assert e.count > 0
            flushed[(e.flag_key, e.variant)] = flushed.get((e.flag_key, e.variant), 0) + e.count
    expected: dict[tuple[str, str], int] = {}
    for op in ops:
        expected[op] = expected.get(op, 0) + 1
    assert flushed == expected


def test_record_song_song_voi_take_khong_mat_luot() -> None:
    c = StatsCounter(100, 10**9)
    stop = threading.Event()
    flushed = [0]

    def drain() -> None:
        while not stop.is_set():
            flushed[0] += sum(e.count for e in c.take(5))

    drainer = threading.Thread(target=drain)
    drainer.start()
    for i in range(20_000):
        c.record(f"f{i % 7}", "on")
    stop.set()
    drainer.join()
    flushed[0] += sum(e.count for e in c.take(1_000))
    assert flushed[0] == 20_000
