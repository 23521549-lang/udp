"""Nhãn ``ff`` theo request (§6.6) — bản Python của ``labels.ts``.

``contextvars`` thay ``AsyncLocalStorage``: cơ chế duy nhất của Python mang ngữ cảnh qua
``await`` mà không phải chuyền tay tham số, và mỗi luồng WSGI có ngữ cảnh riêng — một cơ chế cho
cả ASGI lẫn WSGI. Provider tự gắn hook (tính chất b §6.8: developer không cấu hình gì); middleware
ở ``udp_openfeature.metrics`` mở store — hai bên gặp nhau ở ``request_store`` của module này.
"""

from __future__ import annotations

from collections.abc import Callable, Set
from contextvars import ContextVar
from dataclasses import dataclass, field

from openfeature.flag_evaluation import FlagEvaluationDetails, FlagValueType
from openfeature.hook import Hook, HookContext, HookHints


@dataclass
class RequestLabels:
    """flagKey ⇒ variant, chỉ tracked flag; lần đánh giá CUỐI trong request thắng."""

    flags: dict[str, str] = field(default_factory=dict)


request_store: ContextVar[RequestLabels | None] = ContextVar("udp_request_labels", default=None)


class UDPRequestLabelHook(Hook):
    """Ghi ``flagKey ⇒ variant`` của tracked flag vào store của request đang chạy.

    Bỏ qua khi không có store (ngoài request), flag không tracked, hoặc không có ``variant``
    (DISABLED/ERROR). KHÔNG BAO GIỜ ném: hook ``after`` ném thì SDK trả default thay giá trị thật
    — một lỗi đo lường sẽ đổi hành vi của ứng dụng khách (I33).
    """

    def __init__(self, tracked: Callable[[], Set[str]]) -> None:
        self._tracked = tracked

    def after(
        self,
        hook_context: HookContext,
        details: FlagEvaluationDetails[FlagValueType],
        hints: HookHints,
    ) -> None:
        try:
            labels = request_store.get()
            if labels is None or details.variant is None:
                return
            if hook_context.flag_key not in self._tracked():
                return
            labels.flags[hook_context.flag_key] = details.variant
        except Exception:  # noqa: BLE001 — đo lường không bao giờ được làm hỏng một lần đánh giá
            pass
