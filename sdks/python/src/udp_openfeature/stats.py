"""Telemetry ``report_stats`` của provider (§6.8, V7/V8) — bản Python của ``stats.ts``.

Đếm lượt đánh giá TẠI CHỖ rồi báo về Service 2 mỗi ~60 giây. Ba ràng buộc (R19, R21):

  - **Đường nóng rẻ.** ``record`` chỉ tra hai tầng ``dict`` dưới một khoá không tranh chấp; không
    nối chuỗi khoá mỗi lượt. Khoá là bắt buộc ở Python: luồng báo cáo duyệt bộ đếm trong khi
    luồng đánh giá thêm vào, và ``dict`` đổi kích thước giữa lúc duyệt là ``RuntimeError``.
  - **Telemetry không bao giờ làm hỏng đánh giá.** Provider gọi ``record`` SAU khi kết quả đã
    dựng xong, trong ``try`` riêng (I26, R19 (d)).
  - **Thà mất một báo cáo còn hơn đếm đôi** (V7): chỉ ``retry`` được gộp lô lại.
"""

from __future__ import annotations

import random
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from .cancel import Cancel
from .constants import SDK_STATS_REPORT, STATS_VARIANT_DISABLED, STATS_VARIANT_ERROR
from .transport import StatsPostResult, Transport

# Chỉ để Service 2 ghi log — không tham gia vào bất kỳ quyết định nào
SDK_LABEL = {"name": "udp-openfeature-provider-python"}


def stats_variant_of(evaluation: dict[str, Any]) -> str | None:
    """Nhãn stats của MỘT lần đánh giá, hoặc ``None`` = không đếm — cùng ``statsVariantOf`` (INV-23.9).

    ``FLAG_NOT_FOUND``/``PROVIDER_NOT_READY`` không đếm: key lạ do ứng dụng tự gõ không được làm
    phình bộ đếm trong tiến trình của khách.
    """
    if evaluation.get("errorCode") in ("FLAG_NOT_FOUND", "PROVIDER_NOT_READY"):
        return None
    if evaluation.get("reason") == "ERROR":
        return STATS_VARIANT_ERROR
    variant = evaluation.get("variant")
    return variant if isinstance(variant, str) else STATS_VARIANT_DISABLED


@dataclass(frozen=True)
class StatsEntry:
    flag_key: str
    variant: str
    count: int

    def wire(self) -> dict[str, Any]:
        return {"flagKey": self.flag_key, "variant": self.variant, "count": self.count}


class StatsCounter:
    """Bộ đếm trong tiến trình của ứng dụng khách.

    Trần ``max_pending_entries`` tính theo số cặp (flag, variant); chạm trần thì cặp MỚI bị bỏ
    im lặng — bộ đếm telemetry không được ném hay ghi log trên đường đánh giá.
    """

    def __init__(self, max_pending_entries: int, max_count_per_entry: int) -> None:
        self._max_pending = max_pending_entries
        self._max_count = max_count_per_entry
        self._by_flag: dict[str, dict[str, int]] = {}
        self._pairs = 0
        self._lock = threading.Lock()

    @property
    def is_empty(self) -> bool:
        return self._pairs == 0

    def record(self, flag_key: str, variant: str) -> None:
        with self._lock:
            self._add(flag_key, variant, 1)

    def take(self, limit: int) -> list[StatsEntry]:
        """Lấy ra tối đa ``limit`` mục và XOÁ chúng; phần dư ở lại cho lượt sau."""
        batch: list[StatsEntry] = []
        with self._lock:
            for flag_key in list(self._by_flag):
                by_variant = self._by_flag[flag_key]
                for variant in list(by_variant):
                    batch.append(StatsEntry(flag_key, variant, by_variant.pop(variant)))
                    self._pairs -= 1
                    if len(batch) >= limit:
                        break
                if not by_variant:
                    del self._by_flag[flag_key]
                if len(batch) >= limit:
                    break
        return batch

    def restore(self, batch: list[StatsEntry]) -> None:
        """Gộp một lô CHƯA được server xử lý trở lại (V7) — vẫn tôn trọng trần."""
        with self._lock:
            for entry in batch:
                self._add(entry.flag_key, entry.variant, entry.count)

    def _add(self, flag_key: str, variant: str, n: int) -> None:
        by_variant = self._by_flag.get(flag_key)
        if by_variant is None:
            if self._pairs >= self._max_pending:
                return
            self._pairs += 1
            self._by_flag[flag_key] = {variant: min(n, self._max_count)}
            return
        current = by_variant.get(variant)
        if current is None:
            if self._pairs >= self._max_pending:
                return
            self._pairs += 1
            by_variant[variant] = min(n, self._max_count)
            return
        # Bão hoà ở trần của schema: vượt trần làm Service 2 trả 400 và mất cả báo cáo
        by_variant[variant] = min(current + n, self._max_count)


@dataclass(frozen=True)
class StatsOptions:
    interval_ms: float = SDK_STATS_REPORT["intervalMs"]
    # 0..1 — N tiến trình khởi động cùng lúc không báo cùng một giây
    jitter_ratio: float = SDK_STATS_REPORT["jitterRatio"]
    request_timeout_ms: float = SDK_STATS_REPORT["requestTimeoutMs"]
    # Hạn TỔNG của lần gửi cuối trong `shutdown()`
    shutdown_flush_timeout_ms: float = SDK_STATS_REPORT["shutdownFlushTimeoutMs"]
    max_entries_per_report: int = SDK_STATS_REPORT["maxEntriesPerReport"]
    max_pending_entries: int = SDK_STATS_REPORT["maxPendingEntries"]
    max_count_per_entry: int = SDK_STATS_REPORT["maxCountPerEntry"]
    random: Callable[[], float] = field(default=random.random)


class StatsReporter:
    """Đồng hồ báo cáo: một lượt mỗi ``interval_ms`` ± ``jitter_ratio`` trên luồng daemon (tiến
    trình của khách thoát được dù quên ``api.shutdown()`` — R19 (b)), không chồng lượt, không ném."""

    def __init__(
        self,
        transport: Transport,
        on_diagnostic: Callable[[str], None],
        options: StatsOptions | None = None,
    ) -> None:
        self._transport = transport
        self._on_diagnostic = on_diagnostic
        self._o = options or StatsOptions()
        self._counter = StatsCounter(self._o.max_pending_entries, self._o.max_count_per_entry)
        # Huỷ mọi lời gọi đang bay khi `close()` hết hạn; `_wake` chỉ dừng đồng hồ
        self._abort = Cancel()
        self._wake = Cancel()
        self._flush_lock = threading.Lock()
        self._state_lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._closed = False
        # 401/403/404/405: ngừng gửi TỚI lần READY kế (V7)
        self._stopped = False
        # 400/413: chẩn đoán đúng MỘT lần mỗi phiên (V7)
        self._warned = False
        # `Retry-After` của lần từ chối gần nhất — dùng một lần rồi bỏ
        self._retry_after_ms: float | None = None

    @property
    def counter(self) -> StatsCounter:
        return self._counter

    def record(self, flag_key: str, evaluation: dict[str, Any]) -> None:
        """ĐƯỜNG NÓNG — gọi sau khi kết quả đã dựng xong (I26)."""
        if self._closed:
            return
        variant = stats_variant_of(evaluation)
        if variant is not None:
            self._counter.record(flag_key, variant)

    def start(self) -> None:
        """Bắt đầu đồng hồ — ``initialize()`` gọi, không phải constructor."""
        with self._state_lock:
            if self._thread is not None or self._closed:
                return
            self._thread = threading.Thread(target=self._loop, name="udp-stats", daemon=True)
        self._thread.start()

    def resume(self) -> None:
        """Cấu hình lại READY: khoá được cấp lại hay Service 2 được nâng cấp thì báo cáo chạy tiếp."""
        self._stopped = False

    def close(self) -> None:
        """Lần gửi cuối, có hạn, KHÔNG BAO GIỜ ném (R19 (a)); bộ đếm rỗng ⇒ không request nào."""
        with self._state_lock:
            if self._closed:
                return
            self._closed = True
        self._wake.cancel()
        deadline = time.monotonic() + self._o.shutdown_flush_timeout_ms / 1000
        try:
            # Lượt đang bay đã RÚT lô ra khỏi bộ đếm: chờ nó xong (trong hạn) rồi mới gửi phần
            # còn lại — nếu không thì lô đó vừa mất vừa có thể bị đếm đôi
            if self._flush_lock.acquire(timeout=max(0.0, deadline - time.monotonic())):
                self._flush_lock.release()
                self._flush_once((deadline - time.monotonic()) * 1000)
        except Exception:  # noqa: BLE001 — hàng rào cuối: `shutdown` là hợp đồng "không ném"
            pass
        finally:
            self._abort.cancel()

    def _loop(self) -> None:
        while True:
            jittered = self._o.interval_ms * (1 + (self._o.random() * 2 - 1) * self._o.jitter_ratio)
            delay = max(jittered, self._retry_after_ms or 0.0)
            self._retry_after_ms = None
            if self._wake.wait(delay / 1000):
                return
            self._flush_once(self._o.request_timeout_ms)

    def _flush_once(self, timeout_ms: float) -> None:
        """Không bao giờ ném; không chồng lượt."""
        if timeout_ms <= 0 or self._stopped or self._counter.is_empty:
            return
        if not self._flush_lock.acquire(blocking=False):
            return
        try:
            batch = self._counter.take(self._o.max_entries_per_report)
            if batch:
                self._send(batch, timeout_ms)
        finally:
            self._flush_lock.release()

    def _send(self, batch: list[StatsEntry], timeout_ms: float) -> None:
        cancel = self._abort.child(timeout_ms / 1000)
        try:
            result: StatsPostResult = self._transport.post_stats(
                {"counts": [e.wire() for e in batch], "sdk": SDK_LABEL}, cancel
            )
        except Exception:  # noqa: BLE001 — transport giả của khách có thể ném: coi như mơ hồ, bỏ lô
            return
        finally:
            cancel.cancel()
        if result.kind == "retry":
            self._retry_after_ms = result.retry_after_ms
            self._counter.restore(batch)
        elif result.kind == "stop":
            self._stopped = True
        elif result.kind == "rejected" and not self._warned:
            self._warned = True
            self._on_diagnostic("Service 2 từ chối báo cáo /sdk/stats (400/413) — bỏ lô; kiểm tra phiên bản provider")
        # `accepted`, `rejected` và `ambiguous` đều KHÔNG gộp lại (V7)
