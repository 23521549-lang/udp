"""Hằng số của provider — CÙNG giá trị với ``@udp/config/constants`` (§6.3, §6.8).

Khoá giữ nguyên tên của bản TypeScript: ``tests/test_conformance.py`` so từng bảng với phần
``defaults`` của ``packages/flag-evaluator/conformance/vectors.json`` (do Node sinh) — sửa một
bên mà quên bên kia là đỏ, nên "máy trạng thái, giá trị mặc định giống hệt" (§6.8) được kiểm.
"""

from __future__ import annotations

from typing import Final, TypedDict


class _Sse(TypedDict):
    heartbeatMs: int
    fallbackAfterFailures: int
    pollingFallbackMs: int


class _Provider(TypedDict):
    initTimeoutMs: int
    staleAfterSeconds: int
    heartbeatTimeoutFactor: float
    reconnectBackoffMinMs: int
    configRequestTimeoutMs: int
    maxSseLineChars: int


class _StatsReport(TypedDict):
    intervalMs: int
    jitterRatio: float
    requestTimeoutMs: int
    shutdownFlushTimeoutMs: int
    maxEntriesPerReport: int
    maxCountPerEntry: int
    maxPendingEntries: int


SSE: Final[_Sse] = {
    "heartbeatMs": 20_000,
    "fallbackAfterFailures": 3,
    "pollingFallbackMs": 30_000,
}

PROVIDER: Final[_Provider] = {
    "initTimeoutMs": 10_000,
    "staleAfterSeconds": 300,
    "heartbeatTimeoutFactor": 2.5,
    "reconnectBackoffMinMs": 1_000,
    "configRequestTimeoutMs": 5_000,
    "maxSseLineChars": 64 * 1024 * 1024,
}

SDK_STATS_REPORT: Final[_StatsReport] = {
    "intervalMs": 60_000,
    "jitterRatio": 0.1,
    "requestTimeoutMs": 5_000,
    "shutdownFlushTimeoutMs": 2_000,
    "maxEntriesPerReport": 2_000,
    "maxCountPerEntry": 1_000_000_000,
    "maxPendingEntries": 10_000,
}

# Nhãn stats không phải variant (``STATS_VARIANT`` của ``@udp/shared-types``)
STATS_VARIANT_DISABLED: Final = "__disabled__"
STATS_VARIANT_ERROR: Final = "__error__"

# Hạn KẾT NỐI TCP/TLS của mọi request — bằng mặc định của undici (``fetch`` của bản Node)
CONNECT_TIMEOUT_S: Final = 10.0
