"""Vòng đồng bộ (§6.3, §6.8) với transport giả — cùng các ca của ``sync.test.ts`` (Node).

I15a (nội dung sai ⇒ RESYNC), I18 (hổng con trỏ ⇒ RESYNC), rơi về polling, STALE và hồi phục
(I34), 401, watchdog kết nối nửa mở, và các hồi quy QA của bản Node.
"""

from __future__ import annotations

import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from typing import Any

import pytest
from support import InMemoryTransport, ScriptedStream, config_body, delta_body, flag, snapshot_of, wait_until

from udp_openfeature.sse import SseActivity, SseEvent, SseRetry
from udp_openfeature.store import ConfigStore
from udp_openfeature.sync import Synchronizer, SyncListener, SyncOptions
from udp_openfeature.transport import ConfigResult, StreamOpen


@dataclass
class Harness:
    transport: InMemoryTransport
    store: ConfigStore
    sync: Synchronizer
    log: list[str]


_running: list[Synchronizer] = []


@pytest.fixture(autouse=True)
def _close_running() -> Iterator[None]:
    yield
    for sync in _running:
        sync.close()
        sync.join(2)
    _running.clear()


def harness(**overrides: Any) -> Harness:
    transport = InMemoryTransport()
    store = ConfigStore()
    log: list[str] = []
    listener = SyncListener(
        on_first_data=lambda: log.append("first"),
        on_changed=lambda keys: log.append(f"changed:{','.join(keys)}"),
        on_stale=lambda: log.append("stale"),
        on_fresh=lambda: log.append("fresh"),
        on_unauthorized=lambda: log.append("unauthorized"),
        on_authorized=lambda: log.append("authorized"),
        on_diagnostic=lambda message: log.append(f"diag:{message}"),
    )
    options: dict[str, Any] = {
        "polling_interval_ms": 60,
        "sse_failures_before_fallback": 3,
        "stale_after_ms": 10_000,
        "heartbeat_timeout_ms": 5_000,
        "backoff_min_ms": 5,
        "request_timeout_ms": 1_000,
        "stale_check_ms": 10,
        "random": lambda: 0.5,
        **overrides,
    }
    sync = Synchronizer(transport, store, SyncOptions(**options), listener)
    _running.append(sync)
    return Harness(transport, store, sync, log)


def ok(version: int, flags: list[dict[str, Any]], tracked: list[str] | None = None) -> ConfigResult:
    return ConfigResult("ok", body=config_body(version, flags, tracked), etag=f'"{version}"')


def changed(log: list[str]) -> list[str]:
    return [line for line in log if line.startswith("changed")]


# ------------------------------------------------------------- bootstrap và delta


def test_bootstrap_roi_stream_tu_dung_version_da_ap_delta_doi_noi_dung() -> None:
    h = harness()
    h.transport.configs.append(ok(1, [flag("a")]))
    stream = ScriptedStream()
    h.transport.streams.append(stream)
    h.sync.start()
    wait_until(lambda: "first" in h.log)
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    assert h.transport.stream_calls == [1]

    after = snapshot_of([flag("a", isEnabled=False)])
    stream.event(
        "flag_changed",
        delta_body(1, 2, after, [{"configVersion": 2, "kind": "flag", "flag": flag("a", isEnabled=False)}]),
    )
    wait_until(lambda: h.store.config_version == 2)
    assert "changed:a" in h.log

    # event cũ (toVersion ≤ con trỏ) bị bỏ qua, không lỗi
    stream.event("flag_changed", delta_body(1, 2, after, []))
    stream.event("flag_changed", delta_body(2, 3, after, [{"configVersion": 3, "kind": "flagAbsent", "key": "draft"}]))
    wait_until(lambda: h.store.config_version == 3)
    # flagAbsent của một flag vốn đã vắng không phải thay đổi
    assert changed(h.log) == ["changed:a"]


def test_bootstrap_503_khong_cho_stream_khong_con_tro_la_bootstrap() -> None:
    h = harness()
    h.transport.configs.append(ConfigResult("unavailable", retry_after_ms=60_000))
    stream = ScriptedStream()
    h.transport.streams.append(stream)
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    assert h.transport.stream_calls == [None]
    stream.event("snapshot", config_body(4, [flag("a")]))
    wait_until(lambda: "first" in h.log)
    assert h.store.config_version == 4


def test_changes_rong_hash_y_nguyen_chi_tien_version_va_etag() -> None:
    h = harness()
    h.transport.configs.append(ok(1, [flag("a")]))
    stream = ScriptedStream()
    h.transport.streams.extend([stream, ScriptedStream()])
    h.sync.start()
    wait_until(lambda: "first" in h.log)
    prepared, snapshot = h.store.prepared, h.store.snapshot
    h.log.clear()

    stream.event("flag_changed", delta_body(1, 2, snapshot_of([flag("a")]), []))
    wait_until(lambda: h.store.config_version == 2)
    assert h.store.etag == '"2"'
    assert h.store.needs_resync is False
    assert h.log == [], "đã phát sự kiện cho một thay đổi rỗng"
    assert h.store.snapshot is snapshot
    assert h.store.prepared is prepared, "đã dựng lại bản prepared"
    assert h.transport.stream_calls == [1]


def test_doi_segment_la_doi_moi_flag_tro_toi_no() -> None:
    seg = {"id": "00000000-0000-4000-8000-000000000001", "all": [], "userIds": ["u1"]}
    rule = {
        "id": "r",
        "type": "SEGMENT",
        "condition": {"segmentId": seg["id"]},
        "serve": {"kind": "variant", "variantKey": "off"},
        "bucketSalt": "s",
        "priority": 1,
    }
    h = harness()
    h.transport.configs.append(
        ConfigResult("ok", body=config_body(1, [flag("a", rules=[rule]), flag("b")], segments=[seg]), etag='"1"')
    )
    stream = ScriptedStream()
    h.transport.streams.append(stream)
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    seg2 = {**seg, "userIds": ["u2"]}
    after = {"flags": [flag("a", rules=[rule]), flag("b")], "segments": [seg2], "trackedFlags": []}
    stream.event("flag_changed", delta_body(1, 2, after, [{"configVersion": 2, "kind": "segment", "segment": seg2}]))
    wait_until(lambda: h.store.config_version == 2)
    assert changed(h.log) == ["changed:a"]


# ------------------------------------------------------------- RESYNC


def test_i15a_delta_dung_so_sai_noi_dung_thi_resync() -> None:
    h = harness()
    h.transport.configs.append(ok(1, [flag("a")]))
    first, second = ScriptedStream(), ScriptedStream()
    h.transport.streams.extend([first, second])
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    first.event(
        "flag_changed",
        {
            "fromVersion": 1,
            "toVersion": 2,
            "configHash": "f" * 64,
            "changes": [{"configVersion": 2, "kind": "flag", "flag": flag("a", isEnabled=False)}],
        },
    )
    wait_until(lambda: len(h.transport.stream_calls) == 2)
    assert h.transport.stream_calls[1] is None
    assert h.store.config_version == 1  # kết quả áp sai bị vứt

    second.event("snapshot", config_body(2, [flag("a", isEnabled=False)]))
    wait_until(lambda: h.store.config_version == 2)
    assert h.store.needs_resync is False


@pytest.mark.parametrize(
    "bad",
    [
        lambda s: s.event("flag_changed", {"fromVersion": 5, "toVersion": 6, "configHash": "", "changes": []}),
        lambda s: s.event("segment_changed", {}),
        lambda s: s.raw("snapshot", "{hỏng"),
        lambda s: s.event(
            "flag_changed", {"fromVersion": 1, "toVersion": 2, "configHash": "", "changes": [{"kind": "lạ"}]}
        ),
    ],
    ids=["hong-con-tro", "event-la", "json-hong", "kind-la"],
)
def test_i18_ca_hong_deu_resync_khong_con_tro(bad: Callable[[ScriptedStream], None]) -> None:
    h = harness()
    h.transport.configs.append(ok(1, [flag("a")]))
    s1 = ScriptedStream()
    h.transport.streams.extend([s1, ScriptedStream()])
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    bad(s1)
    wait_until(lambda: len(h.transport.stream_calls) == 2)
    assert h.transport.stream_calls[1] is None


def test_snapshot_version_thap_hon_van_thay_cache() -> None:
    h = harness()
    h.transport.configs.append(ok(9, [flag("a")]))
    s = ScriptedStream()
    h.transport.streams.append(s)
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    s.event("snapshot", config_body(3, [flag("b")]))
    wait_until(lambda: h.store.config_version == 3)


# ------------------------------------------------------------- mất stream (I34)


def test_ba_lan_hong_thi_polling_stream_gui_byte_thi_thoi_polling() -> None:
    h = harness()
    h.transport.configs.append(ok(1, [flag("a")]))
    h.transport.default_config = ConfigResult("not-modified")
    h.sync.start()
    wait_until(lambda: len(h.transport.config_calls) >= 2, 5)
    assert len(h.transport.stream_calls) >= 3
    assert all(tag == '"1"' for tag in h.transport.config_calls[1:])

    s = ScriptedStream()
    s.push(SseActivity())
    h.transport.streams.append(s)
    wait_until(lambda: len(h.transport.streams) == 0, 5)
    wait_until(lambda: not h.sync.is_degraded)
    polls = len(h.transport.config_calls)
    time.sleep(0.2)
    assert len(h.transport.config_calls) <= polls + 1  # một lượt đang bay có thể về sau


def test_khong_xac_nhan_tuoi_qua_han_thi_stale_mot_lan_roi_fresh() -> None:
    h = harness(stale_after_ms=80, polling_interval_ms=10_000)
    h.transport.configs.append(ok(1, [flag("a")], ["a"]))
    s = ScriptedStream()
    h.transport.streams.append(s)
    tracked = h.store.tracked_flags
    h.sync.start()
    wait_until(lambda: "stale" in h.log, 2)
    assert h.sync.is_stale is True
    assert h.store.config_version == 1
    assert sorted(h.store.tracked_flags) == ["a"]
    assert h.store.tracked_flags is tracked  # cùng một set

    s.push(SseActivity())  # nhịp tim
    wait_until(lambda: "fresh" in h.log)
    assert h.log.count("stale") == 1


def test_ket_noi_nua_mo_thi_watchdog_huy_va_noi_lai() -> None:
    h = harness(heartbeat_timeout_ms=60)
    h.transport.configs.append(ok(1, [flag("a")]))
    h.transport.streams.extend([ScriptedStream(), ScriptedStream()])
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) >= 2, 2)
    assert h.transport.stream_calls[1] == 1


# ------------------------------------------------------------- 401


def test_401_error_mot_lan_thu_config_theo_chu_ky_duoc_lai_thi_authorized() -> None:
    h = harness(polling_interval_ms=30)
    h.transport.configs.append(ok(1, [flag("a")]))
    h.transport.streams.append(StreamOpen("unauthorized"))
    h.transport.configs.extend([ConfigResult("unauthorized"), ConfigResult("unauthorized")])
    h.transport.default_config = ConfigResult("not-modified")
    h.sync.start()
    wait_until(lambda: "unauthorized" in h.log)
    assert h.sync.is_stale is True
    wait_until(lambda: "authorized" in h.log, 2)
    assert h.log.count("unauthorized") == 1


def test_polling_khong_de_bang_version_cu_hon() -> None:
    h = harness(polling_interval_ms=20)
    h.transport.configs.append(ok(5, [flag("a")]))
    h.transport.streams.append(StreamOpen("unauthorized"))
    h.transport.configs.append(ok(3, [flag("old")]))
    h.sync.start()
    wait_until(lambda: "authorized" in h.log, 2)
    assert h.store.config_version == 5


# ------------------------------------------------------------- hồi quy QA của bản Node


def test_proxy_giu_moi_byte_van_dem_hong_va_roi_ve_polling() -> None:
    h = harness(heartbeat_timeout_ms=30)
    h.transport.configs.append(ok(1, [flag("a")]))
    h.transport.default_config = ConfigResult("not-modified")
    h.transport.streams.extend(ScriptedStream() for _ in range(10))
    h.sync.start()
    wait_until(lambda: len(h.transport.config_calls) >= 2, 3)
    assert any(line.startswith("diag:3 lần stream hỏng") for line in h.log)


def test_stream_dong_ngay_khong_byte_la_hong_khong_vong_nong() -> None:
    h = harness()
    h.transport.configs.append(ok(1, [flag("a")]))
    h.transport.default_config = ConfigResult("not-modified")
    for _ in range(5):
        s = ScriptedStream()
        s.end()
        h.transport.streams.append(s)
    h.sync.start()
    wait_until(lambda: len(h.transport.config_calls) >= 2, 3)
    assert len(h.transport.stream_calls) < 10


def test_stream_ket_thuc_sach_sau_retry_thi_noi_lai_sau_retry() -> None:
    h = harness()
    h.transport.configs.append(ok(1, [flag("a")]))
    s = ScriptedStream()
    h.transport.streams.extend([s, ScriptedStream()])
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    s.push(SseRetry(250))
    s.end()
    ended = time.monotonic()
    wait_until(lambda: len(h.transport.stream_calls) == 2, 3)
    assert time.monotonic() - ended >= 0.24
    assert h.transport.stream_calls[1] == 1


def test_retry_after_la_san_jitter_khong_keo_som_hon() -> None:
    h = harness(random=lambda: 0.0)
    h.transport.configs.append(ok(1, [flag("a")]))
    h.transport.streams.extend([StreamOpen("unavailable", retry_after_ms=250), ScriptedStream()])
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    refused = time.monotonic()
    wait_until(lambda: len(h.transport.stream_calls) == 2, 3)
    assert time.monotonic() - refused >= 0.24


def test_config_treo_thi_qua_han_rieng_stream_van_bootstrap() -> None:
    h = harness(request_timeout_ms=50)
    h.transport.configs.append("hang")
    s = ScriptedStream()
    h.transport.streams.append(s)
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1, 2)
    assert h.transport.stream_calls[0] is None
    s.event("snapshot", config_body(3, [flag("a")]))
    wait_until(lambda: "first" in h.log)


def test_dang_401_khong_bao_stale_chong_len() -> None:
    h = harness(stale_after_ms=40, polling_interval_ms=20)
    h.transport.configs.append(ok(1, [flag("a")]))
    h.transport.streams.append(StreamOpen("unauthorized"))
    h.transport.default_config = ConfigResult("unauthorized")
    h.sync.start()
    wait_until(lambda: "unauthorized" in h.log)
    time.sleep(0.2)
    assert "stale" not in h.log
    assert h.sync.is_stale is True


def test_snapshot_hash_lech_van_thay_cache_nhung_bao_chan_doan() -> None:
    h = harness()
    h.transport.configs.append(
        ConfigResult("ok", body={**config_body(1, [flag("a")]), "configHash": "0" * 64}, etag='"1"')
    )
    h.transport.streams.append(ScriptedStream())
    h.sync.start()
    wait_until(lambda: "first" in h.log)
    assert any(line.startswith("diag:hash của snapshot") for line in h.log)


def test_close_dung_moi_luong_nen() -> None:
    h = harness(heartbeat_timeout_ms=60_000)
    h.transport.configs.append(ok(1, [flag("a")]))
    h.transport.streams.append(ScriptedStream())
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    h.sync.close()
    h.sync.join(2)
    assert h.transport.stream_calls == [1]


def test_event_la_sau_snapshot_hop_le_khong_lam_cache_sai() -> None:
    h = harness()
    s = ScriptedStream()
    h.transport.streams.extend([s, ScriptedStream()])
    h.sync.start()
    wait_until(lambda: len(h.transport.stream_calls) == 1)
    s.event("snapshot", config_body(2, [flag("a")]))
    s.push(SseEvent("flag_changed", "[1,2,3]", None))
    wait_until(lambda: len(h.transport.stream_calls) == 2)
    assert h.store.config_version == 2
    assert h.store.needs_resync is True
