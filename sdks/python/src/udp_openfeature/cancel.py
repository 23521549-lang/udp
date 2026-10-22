"""Tín hiệu huỷ giữa các luồng — vai ``AbortSignal`` của bản Node.

Provider chạy vòng đồng bộ trên luồng nền; mọi chỗ chờ (ngủ backoff, đọc stream, request có
hạn) phải dừng NGAY khi provider đóng hoặc watchdog cắt kết nối. ``Cancel`` gom ba việc đó:
chờ ngắt được (``wait``), gọi lại khi huỷ (``on_cancel`` — transport đóng socket đang chặn),
và cây cha–con (huỷ cha kéo theo con, con huỷ không chạm cha).
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from contextlib import suppress


class Cancel:
    def __init__(self) -> None:
        self._event = threading.Event()
        self._lock = threading.Lock()
        self._callbacks: list[Callable[[], None]] = []

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        with self._lock:
            if self._event.is_set():
                return
            self._event.set()
            callbacks, self._callbacks = self._callbacks, []
        for callback in callbacks:
            # Một callback hỏng không được chặn các callback sau
            with suppress(Exception):
                callback()

    def on_cancel(self, callback: Callable[[], None]) -> Callable[[], None]:
        """Đăng ký ``callback``; đã huỷ thì gọi ngay. Trả hàm gỡ đăng ký."""
        with self._lock:
            if not self._event.is_set():
                self._callbacks.append(callback)
                return lambda: self._remove(callback)
        callback()
        return lambda: None

    def _remove(self, callback: Callable[[], None]) -> None:
        with self._lock:
            if callback in self._callbacks:
                self._callbacks.remove(callback)

    def wait(self, seconds: float) -> bool:
        """Ngủ tối đa ``seconds``; ``True`` nếu bị huỷ (trong lúc ngủ hoặc từ trước)."""
        return self._event.wait(max(0.0, seconds))

    def child(self, deadline_s: float | None = None) -> Cancel:
        """Tín hiệu con: huỷ khi cha huỷ, hoặc khi quá ``deadline_s`` (hạn TỔNG của một request).

        Người tạo PHẢI huỷ con khi xong việc: đó là lúc đăng ký ở cha và timer hạn được gỡ —
        cha sống suốt đời provider, bỏ quên con là rò dần theo từng request.
        """
        child = Cancel()
        detach = self.on_cancel(child.cancel)
        child.on_cancel(detach)
        if deadline_s is not None:
            timer = threading.Timer(max(0.0, deadline_s), child.cancel)
            timer.daemon = True
            timer.start()
            child.on_cancel(timer.cancel)
        return child
