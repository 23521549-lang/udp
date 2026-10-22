"""Vòng đồng bộ cấu hình với Service 2 (§6.3, §6.8) — bản Python của ``sync.ts``.

CÙNG máy trạng thái với bản Node (§6.8 "giống hệt"); chỉ khác cơ chế chạy: luồng nền daemon
thay event loop (daemon = ``unref`` — không giữ tiến trình sống), ``Cancel`` thay ``AbortSignal``,
và MỘT khoá cho mọi thay đổi trạng thái (stream, polling và kiểm STALE chạy trên ba luồng).
Khoá không bao giờ giữ qua I/O hay lúc ngủ.

  - Bootstrap: ``GET /sdk/config``. 429/503/mạng hỏng/quá hạn ⇒ KHÔNG chờ: mở stream không con
    trỏ — event ``snapshot`` đầu tiên cũng là bootstrap.
  - Stream: con trỏ = version ĐÃ ÁP; cần RESYNC thì mở lại KHÔNG con trỏ. "Còn sống" = mọi byte
    (kể cả nhịp tim); rỗi quá ``heartbeat_timeout_ms`` ⇒ watchdog cắt và đếm một lần hỏng. Bộ
    đếm lỗi chỉ về 0 khi stream đã GỬI một byte.
  - Stream kết thúc sạch ⇒ nối lại sau ``retry:`` của server; kết thúc mà chưa gửi byte nào ⇒
    tính là hỏng (proxy trả 200 rồi đóng ngay không được thành vòng nối lại nóng).
  - ``sse_failures_before_fallback`` lần hỏng liên tiếp ⇒ DEGRADED: polling ``/sdk/config``
    (revalidate bằng ``If-None-Match``) song song với việc thử lại stream có backoff.
  - Không xác nhận được cấu hình còn tươi quá ``stale_after_ms`` ⇒ STALE (vẫn phục vụ cache —
    fail-static, I34); xác nhận lại được ⇒ hết STALE.
  - 401/403 ⇒ thôi stream, thử ``/sdk/config`` theo chu kỳ polling; đang 401 thì không báo STALE.

Hai nguồn cùng ghi cache không đè nhau: polling chỉ áp khi version TIẾN (hoặc cache đang cần
RESYNC); chỉ snapshot của stream được lùi version.
"""

from __future__ import annotations

import random
import threading
import time
from collections.abc import Callable
from contextlib import suppress
from dataclasses import dataclass, field
from typing import Any, Literal

from .cancel import Cancel
from .evaluator import hash_verdict, parse_sdk_config, parse_sdk_delta
from .evaluator.jsvalue import json_parse
from .sse import SseEvent, SseRetry
from .store import ConfigStore, ResyncReason
from .transport import ConfigResult, Transport

StreamOutcome = Literal["ended", "failed", "resync", "unauthorized"]


@dataclass(frozen=True)
class SyncListener:
    on_first_data: Callable[[], None]
    on_changed: Callable[[list[str]], None]
    on_stale: Callable[[], None]
    on_fresh: Callable[[], None]
    on_unauthorized: Callable[[], None]
    # Hết 401 — gọi SAU khi cấu hình của lần thử thành công đã được áp
    on_authorized: Callable[[], None]
    # Chẩn đoán cho người vận hành ứng dụng khách (RESYNC, DEGRADED, lỗi lạ)
    on_diagnostic: Callable[[str], None]


def _monotonic_ms() -> float:
    return time.monotonic() * 1000


@dataclass(frozen=True)
class SyncOptions:
    polling_interval_ms: float
    sse_failures_before_fallback: int
    stale_after_ms: float
    heartbeat_timeout_ms: float
    backoff_min_ms: float
    request_timeout_ms: float
    stale_check_ms: float
    # 0..1 và đồng hồ — tiêm được để test tất định
    random: Callable[[], float] = field(default=random.random)
    now: Callable[[], float] = field(default=_monotonic_ms)


class _Watchdog:
    """Cắt kết nối khi rỗi quá hạn. MỘT luồng mỗi kết nối; ``arm`` chỉ dời mốc."""

    def __init__(self, timeout_s: float, on_expire: Callable[[], None]) -> None:
        self._timeout_s = timeout_s
        self._deadline = time.monotonic() + timeout_s
        self._on_expire = on_expire
        self._done = Cancel()
        threading.Thread(target=self._run, name="udp-watchdog", daemon=True).start()

    def arm(self) -> None:
        self._deadline = time.monotonic() + self._timeout_s

    def stop(self) -> None:
        self._done.cancel()

    def _run(self) -> None:
        while True:
            remaining = self._deadline - time.monotonic()
            if remaining <= 0:
                self._on_expire()
                return
            if self._done.wait(remaining):
                return


class Synchronizer:
    def __init__(self, transport: Transport, store: ConfigStore, options: SyncOptions, listener: SyncListener) -> None:
        self._transport = transport
        self._store = store
        self._o = options
        self._listener = listener
        self._abort = Cancel()
        self._lock = threading.RLock()
        self._threads: list[threading.Thread] = []
        self._started = False
        self._seen_data = False
        self._failures = 0
        self._resync_streak = 0
        self._degraded = False
        self._unauthorized = False
        self._stale = False
        self._last_fresh_at = 0.0
        # `retry:` của stream — theo WHATWG, giữ cho mọi lần nối lại sau
        self._retry_hint_ms: float | None = None
        # `Retry-After` của lần từ chối gần nhất — dùng MỘT lần rồi bỏ
        self._retry_after_ms: float | None = None
        self._poll: Cancel | None = None

    @property
    def is_stale(self) -> bool:
        """Cache có thể không còn đúng — cờ ``stale`` của ``flag_metadata``."""
        return self._stale or self._unauthorized

    @property
    def is_degraded(self) -> bool:
        return self._degraded

    def start(self) -> None:
        with self._lock:
            if self._started:
                return
            self._started = True
            self._last_fresh_at = self._o.now()
        self._spawn("udp-sync", self._run)
        self._spawn("udp-stale", self._stale_loop)

    def close(self) -> None:
        # Không lấy khoá: đóng từ một handler sự kiện (đang giữ khoá trên luồng đồng bộ) vẫn an toàn
        self._abort.cancel()

    def join(self, timeout_s: float) -> None:
        """Chờ các luồng nền kết thúc sau ``close()`` — cho test và phép đo."""
        deadline = time.monotonic() + timeout_s
        for thread in list(self._threads):
            thread.join(max(0.0, deadline - time.monotonic()))

    def _spawn(self, name: str, target: Callable[[], None]) -> None:
        thread = threading.Thread(target=target, name=name, daemon=True)
        self._threads = [t for t in self._threads if t.is_alive()] + [thread]
        thread.start()

    # ------------------------------------------------------------- vòng chính

    def _run(self) -> None:
        self._guarded(self._bootstrap)
        attempt = 0
        while not self._abort.cancelled:
            # Lỗi lạ trong một vòng không được giết cả vòng đồng bộ (cấu hình đóng băng
            # vĩnh viễn, không sự kiện nào báo): ghi chẩn đoán, lùi lại, đi tiếp
            ok = self._guarded(self._step)
            if self._abort.cancelled:
                break
            attempt = 0 if ok else attempt + 1
            if not ok:
                self._sleep(self._backoff(attempt))

    def _step(self) -> None:
        if self._unauthorized:
            self._sleep(self._o.polling_interval_ms)
            self._poll_once()
            return
        outcome = self._stream_once()
        if self._abort.cancelled or outcome == "unauthorized":
            return
        if outcome == "ended":
            self._sleep(self._reconnect_delay())
            return
        if outcome == "resync":
            # Hash lệch LẶP LẠI không được thành bão mở stream: lần đầu nối lại ngay
            self._resync_streak += 1
            if self._resync_streak > 1:
                self._sleep(self._backoff(self._resync_streak - 1))
            return
        with self._lock:
            self._failures += 1
            if self._failures >= self._o.sse_failures_before_fallback and not self._degraded:
                self._degraded = True
                self._listener.on_diagnostic(
                    f"{self._failures} lần stream hỏng liên tiếp — chuyển sang polling /sdk/config"
                )
                self._start_polling()
        self._sleep(self._backoff(self._failures))

    def _guarded(self, fn: Callable[[], None]) -> bool:
        """``True`` nếu ``fn`` chạy xong; ngoại lệ ⇒ chẩn đoán, ``False``."""
        try:
            fn()
            return True
        except Exception as err:  # noqa: BLE001
            if not self._abort.cancelled:
                self._listener.on_diagnostic(f"lỗi không lường trước: {err!r}")
            return False

    def _get_config(self, if_none_match: str | None) -> ConfigResult:
        """MỘT lần ``GET /sdk/config`` với hạn riêng: server nhận kết nối rồi im không treo vòng."""
        cancel = self._abort.child(self._o.request_timeout_ms / 1000)
        try:
            return self._transport.get_config(if_none_match, cancel)
        finally:
            cancel.cancel()

    def _bootstrap(self) -> None:
        result = self._get_config(None)
        with self._lock:
            if result.kind == "ok":
                self._accept_config(result.body, result.etag, from_poll=False)
            elif result.kind == "unauthorized":
                self._mark_unauthorized()
            # 429/503/mạng/quá hạn: stream không con trỏ lo bootstrap

    def _stream_once(self) -> StreamOutcome:
        since = self._store.config_version if self._store.has_data and not self._store.needs_resync else None
        connection = self._abort.child()
        watchdog = _Watchdog(self._o.heartbeat_timeout_ms / 1000, connection.cancel)
        items = None
        received = False
        try:
            opened = self._transport.open_stream(since, connection)
            if opened.kind == "unauthorized":
                with self._lock:
                    self._mark_unauthorized()
                return "unauthorized"
            if opened.kind == "bad-cursor":
                with self._lock:
                    return self._resync("bad-cursor")
            if opened.kind == "unavailable" or opened.items is None:
                self._retry_after_ms = opened.retry_after_ms
                return "failed"
            items = opened.items
            for item in items:
                if self._abort.cancelled:
                    return "ended"
                watchdog.arm()
                with self._lock:
                    if not received:
                        self._stream_proved_alive()
                    received = True
                    self._fresh()
                    if isinstance(item, SseRetry):
                        self._retry_hint_ms = item.ms
                    if isinstance(item, SseEvent) and self._handle_event(item.event, item.data) == "resync":
                        return "resync"
            # Watchdog cắt (hoặc provider đóng) làm việc đọc kết thúc — đó là hỏng, không phải "xong"
            if connection.cancelled and not self._abort.cancelled:
                return "failed"
            return "ended" if received else "failed"
        except Exception:  # noqa: BLE001 — stream hỏng giữa chừng là một kết cục, không phải lỗi
            return "failed"
        finally:
            watchdog.stop()
            connection.cancel()
            close = getattr(items, "close", None)
            if callable(close):
                with suppress(Exception):
                    close()

    def _stream_proved_alive(self) -> None:
        """Byte đầu tiên của một stream — lúc này mới biết đường stream thật sự chạy."""
        self._failures = 0
        self._retry_after_ms = None
        if self._degraded:
            self._degraded = False
            self._stop_polling()

    def _resync(self, reason: ResyncReason) -> Literal["resync"]:
        self._store.mark_needs_resync()
        self._listener.on_diagnostic(f"RESYNC ({reason}) — mở lại stream không con trỏ")
        return "resync"

    def _handle_event(self, event: str, data: str) -> Literal["ok", "resync"]:
        try:
            raw = json_parse(data)
        except Exception:  # noqa: BLE001 — JSON hỏng, lồng quá sâu: cùng một ca
            return self._resync("malformed-event")
        if event == "snapshot":
            # Snapshot là sự thật của server — thay cache kể cả khi version LÙI (DB restore) và
            # không RESYNC vì hash (lệch ở đây là lệch evaluator) — chỉ báo chẩn đoán
            config = parse_sdk_config(raw)
            if config is None:
                return self._resync("malformed-event")
            self._resync_streak = 0
            self._emit_data(self._store.replace(config, None))
            self._check_snapshot_hash(config["configHash"])
            return "ok"
        if event == "flag_changed":
            delta = parse_sdk_delta(raw)
            if delta is None:
                return self._resync("malformed-event")
            out = self._store.apply_delta(delta)
            if out.kind == "resync":
                return self._resync(out.reason or "malformed")
            if out.kind == "applied":
                self._emit_data(out.changed)
            return "ok"
        # Event lạ ⇒ RESYNC, không đoán (§6.8)
        return self._resync("unknown-event")

    def _check_snapshot_hash(self, expected: str) -> None:
        snapshot = self._store.snapshot
        if snapshot is not None and hash_verdict(snapshot, expected) == "mismatch":
            self._listener.on_diagnostic(
                "hash của snapshot không khớp configHash của server — provider và Service 2 lệch phiên bản chuẩn hoá?"
            )

    # ------------------------------------------------------------- polling

    def _start_polling(self) -> None:
        if self._poll is not None or self._abort.cancelled:
            return
        token = self._abort.child()
        self._poll = token
        # Lượt đầu rải ngẫu nhiên: N tiến trình mất stream cùng lúc không cùng gọi `/sdk/config`
        delay_ms = self._o.random() * self._o.polling_interval_ms
        self._spawn("udp-poll", lambda: self._poll_loop(token, delay_ms))

    def _poll_loop(self, token: Cancel, delay_ms: float) -> None:
        wait_ms = delay_ms
        while not token.wait(wait_ms / 1000):
            self._guarded(self._poll_once)
            with self._lock:
                if token.cancelled or not self._degraded:
                    break
            wait_ms = self._o.polling_interval_ms
        with self._lock:
            if self._poll is token:
                self._poll = None
        token.cancel()

    def _stop_polling(self) -> None:
        poll, self._poll = self._poll, None
        if poll is not None:
            poll.cancel()

    def _poll_once(self) -> None:
        # Đọc không khoá: hai giá trị chỉ vòng đồng bộ ghi, và một lần đọc lệch chỉ tốn một 200 thay vì 304
        result = self._get_config(None if self._store.needs_resync else self._store.etag)
        with self._lock:
            if self._abort.cancelled:
                return
            if result.kind == "unauthorized":
                self._mark_unauthorized()
                return
            if result.kind == "unavailable":
                return
            was_unauthorized = self._unauthorized
            self._unauthorized = False
            if result.kind == "not-modified":
                self._fresh()
            else:
                self._accept_config(result.body, result.etag, from_poll=True)
            if was_unauthorized:
                self._listener.on_authorized()

    # ------------------------------------------------------------- trạng thái (giữ khoá)

    def _accept_config(self, raw: Any, etag: str | None, *, from_poll: bool) -> None:
        config = parse_sdk_config(raw)
        if config is None:
            self._store.mark_needs_resync()
            self._listener.on_diagnostic("body /sdk/config sai hình — RESYNC")
            return
        regresses = self._store.has_data and config["configVersion"] <= self._store.config_version
        if from_poll and regresses and not self._store.needs_resync:
            # Không tiến: xác nhận tươi, KHÔNG đè — stream có thể đã đi trước lượt poll này
            self._fresh()
            return
        changed = self._store.replace(config, etag)
        self._fresh()
        self._emit_data(changed)
        self._check_snapshot_hash(config["configHash"])

    def _emit_data(self, changed: list[str]) -> None:
        if self._abort.cancelled:
            return
        if not self._seen_data:
            self._seen_data = True
            self._listener.on_first_data()
            return
        if changed:
            self._listener.on_changed(changed)

    def _fresh(self) -> None:
        self._last_fresh_at = self._o.now()
        if self._stale and not self._unauthorized:
            self._stale = False
            if not self._abort.cancelled:
                self._listener.on_fresh()

    def _stale_loop(self) -> None:
        while not self._abort.wait(self._o.stale_check_ms / 1000):
            with self._lock:
                self._guarded(self._check_stale)

    def _check_stale(self) -> None:
        # Đang 401 thì trạng thái công bố là ERROR — STALE chồng lên sẽ che mất việc khoá bị thu hồi
        if self._abort.cancelled or self._stale or self._unauthorized or not self._store.has_data:
            return
        if self._o.now() - self._last_fresh_at > self._o.stale_after_ms:
            self._stale = True
            self._listener.on_stale()

    def _mark_unauthorized(self) -> None:
        self._stop_polling()
        self._degraded = False
        if self._unauthorized:
            return
        self._unauthorized = True
        if not self._abort.cancelled:
            self._listener.on_unauthorized()

    # ------------------------------------------------------------- thời gian

    def _backoff(self, attempt: int) -> float:
        """Nhân đôi từ ``backoff_min_ms``, trần là chu kỳ polling, jitter xuống tới một nửa —
        nhưng KHÔNG BAO GIỜ sớm hơn ``Retry-After`` (dùng một lần) hay ``retry:`` của server."""
        exponent = min(max(0, attempt - 1), 30)
        exponential = min(self._o.polling_interval_ms, self._o.backoff_min_ms * 2.0**exponent)
        floor = max(self._retry_after_ms or 0.0, self._retry_hint_ms or 0.0)
        self._retry_after_ms = None
        return max(floor, exponential * (0.5 + self._o.random() / 2))

    def _reconnect_delay(self) -> float:
        """Sau khi stream kết thúc sạch: ``retry:`` của server (hoặc mức tối thiểu), rải lên trên."""
        floor = self._retry_hint_ms if self._retry_hint_ms is not None else self._o.backoff_min_ms
        return floor * (1 + self._o.random() / 2)

    def _sleep(self, ms: float) -> None:
        self._abort.wait(ms / 1000)
