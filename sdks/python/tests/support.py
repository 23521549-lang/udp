"""Chỗ dựa cho test — bản Python của ``testing.ts``; KHÔNG nằm trong gói phát hành.

``InMemoryTransport`` điều khiển được: mỗi lời gọi ``/sdk/config`` lấy phản hồi kế tiếp trong
hàng đợi, mỗi lần mở stream lấy một ``ScriptedStream`` mà test đẩy sự kiện vào.
"""

from __future__ import annotations

import json
import threading
import time
from collections import deque
from collections.abc import Callable, Iterator
from typing import Any, Literal

from udp_openfeature._internals import ProviderInternals, with_internals
from udp_openfeature.cancel import Cancel
from udp_openfeature.evaluator import config_hash_of
from udp_openfeature.provider import UDPFeatureFlagProvider
from udp_openfeature.sse import SseEvent, SseItem
from udp_openfeature.transport import ConfigResult, StatsPostResult, StreamOpen

# Chu kỳ ngắn cho vòng đồng bộ trong test — cùng tỉ lệ với mặc định, nhanh hơn ~1000 lần
FAST_SYNC: dict[str, Any] = {
    "polling_interval_ms": 40,
    "heartbeat_timeout_ms": 150,
    "backoff_min_ms": 5,
    "request_timeout_ms": 150,
    "stale_check_ms": 10,
    "random": lambda: 0.5,
}


def wait_until(predicate: Callable[[], bool], timeout_s: float = 3.0, what: str = "điều kiện") -> None:
    deadline = time.monotonic() + timeout_s
    while not predicate():
        if time.monotonic() > deadline:
            raise AssertionError(f"quá hạn chờ {what}")
        time.sleep(0.005)


class ScriptedStream:
    def __init__(self) -> None:
        self._queue: deque[SseItem | Literal["end", "fail"]] = deque()
        self._cond = threading.Condition()

    def push(self, item: SseItem | Literal["end", "fail"]) -> None:
        with self._cond:
            self._queue.append(item)
            self._cond.notify_all()

    def event(self, event: str, data: Any) -> None:
        self.push(SseEvent(event, json.dumps(data, ensure_ascii=False), None))

    def raw(self, event: str, data: str) -> None:
        self.push(SseEvent(event, data, None))

    def end(self) -> None:
        self.push("end")

    def fail(self) -> None:
        self.push("fail")

    def _wake(self) -> None:
        with self._cond:
            self._cond.notify_all()

    def items(self, cancel: Cancel) -> Iterator[SseItem]:
        detach = cancel.on_cancel(self._wake)
        try:
            while True:
                with self._cond:
                    while not self._queue and not cancel.cancelled:
                        self._cond.wait()
                    if cancel.cancelled:
                        raise ConnectionAbortedError("đã huỷ")
                    nxt = self._queue.popleft()
                if nxt == "end":
                    return
                if nxt == "fail":
                    raise ConnectionError("stream hỏng")
                yield nxt
        finally:
            detach()


def _hang(cancel: Cancel) -> None:
    while not cancel.wait(3600):
        pass


class InMemoryTransport:
    def __init__(self) -> None:
        self.config_calls: list[str | None] = []
        self.stream_calls: list[int | None] = []
        self.stats_reports: list[dict[str, Any]] = []
        # "hang": server nhận kết nối rồi im — chỉ huỷ/quá hạn kết thúc nó
        self.configs: deque[ConfigResult | Literal["hang"]] = deque()
        self.streams: deque[ScriptedStream | StreamOpen] = deque()
        self.stats: deque[StatsPostResult | Literal["hang", "throw"]] = deque()
        self.default_config = ConfigResult("unavailable")
        self.default_stats = StatsPostResult("accepted")

    def get_config(self, if_none_match: str | None, cancel: Cancel) -> ConfigResult:
        self.config_calls.append(if_none_match)
        nxt = self.configs.popleft() if self.configs else self.default_config
        if nxt == "hang":
            _hang(cancel)
            return ConfigResult("unavailable")
        return nxt

    def open_stream(self, since: int | None, cancel: Cancel) -> StreamOpen:
        self.stream_calls.append(since)
        nxt = self.streams.popleft() if self.streams else StreamOpen("unavailable")
        if isinstance(nxt, ScriptedStream):
            return StreamOpen("open", items=nxt.items(cancel))
        return nxt

    def post_stats(self, report: dict[str, Any], cancel: Cancel) -> StatsPostResult:
        self.stats_reports.append(report)
        nxt = self.stats.popleft() if self.stats else self.default_stats
        if nxt == "throw":
            raise RuntimeError("post_stats hỏng")
        if nxt == "hang":
            _hang(cancel)
            return StatsPostResult("ambiguous")
        return nxt


def create_provider_for_testing(internals: ProviderInternals, **options: Any) -> UDPFeatureFlagProvider:
    options.setdefault("host", "http://udp.invalid")
    options.setdefault("sdk_key", "udp_sk_test")
    return with_internals(internals, lambda: UDPFeatureFlagProvider(**options))


def flag(key: str, **over: Any) -> dict[str, Any]:
    return {
        "key": key,
        "type": "BOOLEAN",
        "isEnabled": True,
        "stickinessAttribute": "targetingKey",
        "variants": {"on": True, "off": False},
        "defaultVariantKey": "on",
        "rules": [],
        **over,
    }


def config_body(
    config_version: int,
    flags: list[dict[str, Any]],
    tracked_flags: list[str] | None = None,
    segments: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Body ``/sdk/config`` (hoặc data của event ``snapshot``) có hash đúng."""
    tracked = tracked_flags or []
    segs = segments or []
    snapshot = {"flags": flags, "segments": segs, "trackedFlags": tracked}
    return {
        "configVersion": config_version,
        "configHash": config_hash_of(snapshot),
        "environment": "dev",
        "trackedFlags": tracked,
        "flags": flags,
        "segments": segs,
    }


def delta_body(
    from_version: int,
    to_version: int,
    after: dict[str, Any],
    changes: list[dict[str, Any]],
    config_hash: str | None = None,
) -> dict[str, Any]:
    """Data của event ``flag_changed`` đưa cache tới snapshot ``after``."""
    return {
        "fromVersion": from_version,
        "toVersion": to_version,
        "configHash": config_hash if config_hash is not None else config_hash_of(after),
        "changes": changes,
    }


def snapshot_of(flags: list[dict[str, Any]], tracked: list[str] | None = None) -> dict[str, Any]:
    return {"flags": flags, "segments": [], "trackedFlags": tracked or []}
