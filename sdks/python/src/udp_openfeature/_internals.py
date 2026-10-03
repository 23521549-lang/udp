"""Chỗ tiêm cho test và phép đo — NẰM NGOÀI chữ ký công khai của provider (như ``internals.ts``).

Chỉ ``udp_openfeature.testing`` đặt khe; constructor đọc và XOÁ khe ở lệnh đầu tiên — provider
dựng sau không bao giờ nhặt nhầm, kể cả khi constructor trước ném giữa chừng. Khe theo luồng:
hai luồng dựng provider song song không thấy khe của nhau.
"""

from __future__ import annotations

import threading
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, TypeVar

from .stats import StatsOptions
from .store import ConfigStore
from .transport import Transport

T = TypeVar("T")


@dataclass
class ProviderInternals:
    transport: Transport | None = None
    # Ghi đè từng trường của `SyncOptions` (random, now, các chu kỳ)
    sync: dict[str, Any] = field(default_factory=dict)
    stats: StatsOptions | None = None
    # Cache do test giữ để so với `/sdk/config` (I15c)
    store: ConfigStore | None = None


_slot = threading.local()


def take_internals() -> ProviderInternals:
    """Constructor gọi đúng một lần, trước mọi việc khác."""
    internals: ProviderInternals | None = getattr(_slot, "value", None)
    _slot.value = None
    return internals if internals is not None else ProviderInternals()


def with_internals(internals: ProviderInternals, build: Callable[[], T]) -> T:
    """Dựng một đối tượng với khe đã đặt; khe luôn bị xoá khi ``build`` xong hoặc ném."""
    _slot.value = internals
    try:
        return build()
    finally:
        _slot.value = None
