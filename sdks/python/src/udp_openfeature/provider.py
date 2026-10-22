"""``UDPFeatureFlagProvider`` — provider OpenFeature cho SERVER key (§6.8), bản Python.

Tải snapshot, giữ cache, nhận delta qua SSE, đánh giá TẠI CHỖ bằng lõi cùng ngữ nghĩa với OFREP
(I26 — kiểm bằng vector của bản Node), fail-static khi mất kết nối (I34), không bao giờ ném (I33).

Sự kiện: SDK tự phát READY/ERROR theo kết quả ``initialize()``; provider chỉ phát SAU init —
CONFIGURATION_CHANGED (kèm ``flags_changed``), và trạng thái khi nó THẬT SỰ đổi: STALE, ERROR khi
khoá bị từ chối, READY khi hồi phục (không bao giờ READY hai lần liền). DEGRADED (đang polling) là
trạng thái NỘI BỘ. Không bao giờ FATAL — FATAL làm SDK trả default, phá fail-static.

Kiểu NUMBER của UDP là số JSON; OpenFeature Python tách ``integer``/``float``: ``float`` nhận mọi số
hữu hạn, ``integer`` chỉ nhận số nguyên (``2.5`` ⇒ TYPE_MISMATCH, không làm tròn im lặng).
"""

from __future__ import annotations

import logging
import math
import threading
from collections.abc import Mapping, Sequence
from contextlib import suppress
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, Literal, TypeVar

from openfeature.evaluation_context import EvaluationContext
from openfeature.event import ProviderEventDetails
from openfeature.exception import ErrorCode, GeneralError, OpenFeatureError, ProviderNotReadyError
from openfeature.flag_evaluation import FlagResolutionDetails, FlagValueType, Reason
from openfeature.hook import Hook
from openfeature.provider import AbstractProvider, Metadata

from ._internals import take_internals
from .constants import PROVIDER, SSE
from .evaluator import evaluate
from .evaluator.jsvalue import MAX_SAFE_INTEGER, is_finite_number
from .labels import UDPRequestLabelHook
from .stats import StatsReporter
from .store import ConfigStore
from .sync import Synchronizer, SyncListener, SyncOptions
from .transport import ConnectionFactory, HttpTransport, Transport

T = TypeVar("T")
ValueKind = Literal["boolean", "string", "integer", "float", "object"]
Announced = Literal["READY", "STALE", "ERROR"]

FLAG_TYPE: Mapping[ValueKind, str] = {
    "boolean": "BOOLEAN",
    "string": "STRING",
    "integer": "NUMBER",
    "float": "NUMBER",
    "object": "JSON",
}

ERROR_CODE: Mapping[str, ErrorCode] = {
    "FLAG_NOT_FOUND": ErrorCode.FLAG_NOT_FOUND,
    "TYPE_MISMATCH": ErrorCode.TYPE_MISMATCH,
    "PROVIDER_NOT_READY": ErrorCode.PROVIDER_NOT_READY,
    "GENERAL": ErrorCode.GENERAL,
}

_OMIT = object()
_MISMATCH = object()


def _iso(value: datetime) -> str:
    """``Date.prototype.toISOString``: UTC, mili-giây, ``Z``. Datetime ngây thơ theo giờ máy, như Python."""
    d = value.astimezone(UTC)
    return f"{d:%Y-%m-%dT%H:%M:%S}.{d.microsecond // 1000:03d}Z"


def _json_value(value: Any) -> Any:
    """Một giá trị qua ``JSON.parse(JSON.stringify(...))`` — thứ OFREP nhận qua dây."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        # Số nguyên ngoài vùng an toàn thành double ở phía Node — đánh giá tại chỗ cũng vậy
        return value if abs(value) <= MAX_SAFE_INTEGER else float(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, datetime):
        return _iso(value)
    if isinstance(value, Mapping):
        out: dict[str, Any] = {}
        for key, item in value.items():
            converted = _json_value(item)
            if converted is not _OMIT:
                out[str(key)] = converted
        return out
    if isinstance(value, Sequence) and not isinstance(value, (bytes, bytearray)):
        return [None if (c := _json_value(item)) is _OMIT else c for item in value]
    return _OMIT


def json_context(context: EvaluationContext | None) -> dict[str, Any]:
    """Context theo ngữ nghĩa JSON — ĐÚNG thứ OFREP nhận: ``{targetingKey, ...attributes}``.

    ``datetime`` (mọi độ sâu) ⇒ chuỗi ISO, ``NaN``/``Infinity`` ⇒ ``None``, kiểu không tuần tự
    hoá được bị bỏ. Khác đi thì cùng một context cho hai kết quả ở local và OFREP (I26).
    """
    if context is None:
        return {}
    out = _json_value(dict(context.attributes))
    if not isinstance(out, dict):
        return {}
    if context.targeting_key is not None:
        out["targetingKey"] = context.targeting_key
    return out


def _coerce(kind: ValueKind, value: Any) -> Any:
    if kind == "boolean":
        return value if isinstance(value, bool) else _MISMATCH
    if kind == "string":
        return value if isinstance(value, str) else _MISMATCH
    if kind == "integer":
        return int(value) if is_finite_number(value) and float(value).is_integer() else _MISMATCH
    if kind == "float":
        return float(value) if is_finite_number(value) else _MISMATCH
    return value if isinstance(value, (dict, list)) else _MISMATCH


def _positive(name: str, value: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or value <= 0:
        raise ValueError(f"{name} phải là số dương hữu hạn")
    return float(value)


class UDPFeatureFlagProvider(AbstractProvider):
    """Provider OpenFeature cho SERVER key của UDP.

    ``host``: gốc của Service 2, vd ``https://flags.udp.example``. ``sdk_key``: SERVER key — suy ra
    project và environment (ADR-03). Tuỳ chọn và mặc định giống hệt bản Node (§6.8): sai là lỗi
    cấu hình của lập trình viên ⇒ ``ValueError`` ngay lúc dựng (số không dương là vòng lặp NÓNG;
    ``stale_after_seconds`` không dài hơn nhịp tim và chu kỳ polling thì kết nối khoẻ vẫn nhảy
    STALE/READY). ``connection_factory`` thay kết nối HTTP (proxy, TLS) — vai ``fetch`` của Node.
    ``logger`` nhận chẩn đoán ở mức warning; mặc định logger ``udp_openfeature`` (im lặng tới khi
    ứng dụng cấu hình logging).
    """

    def __init__(
        self,
        host: str,
        sdk_key: str,
        *,
        stale_after_seconds: float = PROVIDER["staleAfterSeconds"],
        polling_interval_ms: float = SSE["pollingFallbackMs"],
        sse_failures_before_fallback: int = SSE["fallbackAfterFailures"],
        init_timeout_ms: float = PROVIDER["initTimeoutMs"],
        report_stats: bool = True,
        connection_factory: ConnectionFactory | None = None,
        logger: logging.Logger | None = None,
    ) -> None:
        # Đọc-và-xoá khe tiêm TRƯỚC mọi thứ có thể ném (xem `_internals.py`)
        internals = take_internals()
        super().__init__()
        polling = _positive("polling_interval_ms", polling_interval_ms)
        failures = sse_failures_before_fallback
        if isinstance(failures, bool) or not isinstance(failures, int) or failures < 1:
            raise ValueError("sse_failures_before_fallback phải là số nguyên ≥ 1")
        self._init_timeout_ms = _positive("init_timeout_ms", init_timeout_ms)
        stale_after_ms = _positive("stale_after_seconds", stale_after_seconds) * 1000
        heartbeat_timeout_ms = SSE["heartbeatMs"] * PROVIDER["heartbeatTimeoutFactor"]
        floor = max(heartbeat_timeout_ms, polling)
        if stale_after_ms <= floor:
            raise ValueError(
                f"stale_after_seconds phải lớn hơn {floor / 1000:g} giây "
                "(max của thời hạn nhịp tim và polling_interval_ms)"
            )

        self._logger = logger if logger is not None else logging.getLogger("udp_openfeature")
        self._store = internals.store if internals.store is not None else ConfigStore()
        self._hook = UDPRequestLabelHook(lambda: self._store.tracked_flags)
        transport: Transport = (
            internals.transport if internals.transport is not None else HttpTransport(host, sdk_key, connection_factory)
        )
        self._stats = None if report_stats is False else StatsReporter(transport, self._diagnostic, internals.stats)
        options = SyncOptions(
            polling_interval_ms=polling,
            sse_failures_before_fallback=failures,
            stale_after_ms=stale_after_ms,
            heartbeat_timeout_ms=heartbeat_timeout_ms,
            backoff_min_ms=PROVIDER["reconnectBackoffMinMs"],
            request_timeout_ms=PROVIDER["configRequestTimeoutMs"],
            stale_check_ms=max(100.0, min(1_000.0, stale_after_ms / 4)),
        )
        self._sync = Synchronizer(
            transport,
            self._store,
            replace(options, **internals.sync),
            SyncListener(
                on_first_data=self._on_first_data,
                on_changed=self._on_changed,
                on_stale=lambda: self._announce("STALE"),
                on_fresh=self._on_fresh,
                on_unauthorized=self._on_unauthorized,
                on_authorized=self._on_authorized,
                on_diagnostic=self._diagnostic,
            ),
        )
        self._lock = threading.Lock()
        self._init_started = False
        self._init_pending = False
        self._init_done = threading.Event()
        self._init_error: OpenFeatureError | None = None
        self._initialized = False
        self._closed = False
        self._announced: Announced | None = None

    # ------------------------------------------------------------- bề mặt công khai

    def get_metadata(self) -> Metadata:
        return Metadata(name="udp")

    def get_provider_hooks(self) -> list[Hook]:
        return [self._hook]

    @property
    def tracked_flags(self) -> frozenset[str]:
        """Tập flag đang gắn nhãn ``ff`` (§6.6)."""
        return frozenset(self._store.tracked_flags)

    @property
    def config_version(self) -> int | None:
        """Version của cấu hình đang phục vụ; ``None`` trước khi có dữ liệu."""
        return self._store.config_version if self._store.has_data else None

    def initialize(self, evaluation_context: EvaluationContext | None = None) -> None:
        """Chờ snapshot đầu tới ``init_timeout_ms``. Quá hạn ⇒ NÉM (SDK phát ERROR; ứng dụng vẫn
        chạy với default) nhưng vẫn thử nền và phát READY khi có. 401 ⇒ ném ngay. Gọi lại ⇒ cùng
        một kết cục."""
        with self._lock:
            first = not self._init_started
            self._init_started = True
            if first:
                if self._store.has_data:
                    self._initialized = True
                    self._announced = "READY"
                    self._init_done.set()
                else:
                    self._init_pending = True
        if first:
            self._sync.start()
            # Đồng hồ báo cáo khởi động cùng vòng đồng bộ, KHÔNG ở constructor: dựng rồi bỏ một
            # provider (test, phép đo) không được để lại luồng nào
            if self._stats is not None:
                self._stats.start()
        if not self._init_done.wait(self._init_timeout_ms / 1000):
            self._settle_init(
                ProviderNotReadyError(f"Không tải được cấu hình trong {self._init_timeout_ms:g} ms — đang thử lại nền")
            )
        if self._init_error is not None:
            raise self._init_error

    def shutdown(self) -> None:
        """Không bao giờ ném và không vượt ``shutdownFlushTimeoutMs`` (R19 (a))."""
        with self._lock:
            self._closed = True
        self._sync.close()
        # Đóng giữa lúc init: không bắt `initialize()` chờ hết hạn
        self._settle_init(ProviderNotReadyError("provider đã đóng trước khi có cấu hình"))
        if self._stats is not None:
            self._stats.close()

    # ------------------------------------------------------------- vòng đời

    def _diagnostic(self, message: str) -> None:
        # Logger của khách hỏng không được giết vòng đồng bộ
        with suppress(Exception):
            self._logger.warning("[udp] %s", message)

    def _settle_init(self, error: OpenFeatureError | None) -> bool:
        """Kết thúc lần ``initialize()`` đang chờ; ``False`` khi không có lần init nào đang chờ.

        Xoá chỗ chờ NGAY: snapshot tới đúng lúc hạn chờ vừa hết phải thành READY do provider
        phát, không rơi vào một lần init đã thất bại."""
        with self._lock:
            if not self._init_pending:
                return False
            self._init_pending = False
            self._initialized = True
            # SDK tự phát READY/ERROR theo kết quả này
            self._announced = "READY" if error is None else "ERROR"
            self._init_error = error
            self._init_done.set()
            return True

    def _announce(self, status: Announced, message: str | None = None) -> None:
        with self._lock:
            if self._closed or not self._initialized or self._announced == status:
                return
            self._announced = status
        details = ProviderEventDetails(message=message)
        if status == "READY":
            self.emit_provider_ready(details)
        elif status == "STALE":
            self.emit_provider_stale(details)
        else:
            self.emit_provider_error(details)

    def _on_first_data(self) -> None:
        if self._stats is not None:
            self._stats.resume()
        if not self._settle_init(None):
            self._announce("READY")

    def _on_changed(self, flags_changed: list[str]) -> None:
        if self._closed or not self._initialized:
            return
        self.emit_provider_configuration_changed(ProviderEventDetails(flags_changed=flags_changed))

    def _on_fresh(self) -> None:
        if self._stats is not None:
            self._stats.resume()
        self._announce("READY")

    def _on_unauthorized(self) -> None:
        message = "SDK key bị từ chối (401) — khoá sai hoặc đã thu hồi"
        self._diagnostic(message)
        if not self._settle_init(GeneralError(message)):
            self._announce("ERROR", f"{message}; phục vụ cấu hình cuối")

    def _on_authorized(self) -> None:
        # Khoá được nhận lại ⇒ telemetry đã ngừng vì 401/403 chạy tiếp (V7)
        if self._stats is not None:
            self._stats.resume()
        if self._store.has_data:
            self._announce("READY")

    # ------------------------------------------------------------- đánh giá

    def _resolve(
        self, kind: ValueKind, flag_key: str, default_value: T, context: EvaluationContext | None
    ) -> FlagResolutionDetails[T]:
        try:
            prepared = self._store.prepared
            if prepared is None:
                return FlagResolutionDetails(
                    value=default_value, reason=Reason.ERROR, error_code=ErrorCode.PROVIDER_NOT_READY
                )
            evaluation = evaluate(prepared, flag_key, json_context(context), FLAG_TYPE[kind])
            details: FlagResolutionDetails[T] = self._details_of(kind, default_value, evaluation)
            # Đếm SAU khi kết quả đã dựng xong, trong `try` RIÊNG (I26, R19 (d)); nhãn lấy từ
            # `evaluation` — đúng thứ OFREP đếm ở Service 2 (INV-23.9)
            if self._stats is not None:
                with suppress(Exception):
                    self._stats.record(flag_key, evaluation)
            return details
        except Exception:  # noqa: BLE001 — I33
            return FlagResolutionDetails(value=default_value, reason=Reason.ERROR, error_code=ErrorCode.GENERAL)

    def _details_of(
        self, kind: ValueKind, default_value: Any, evaluation: dict[str, Any]
    ) -> FlagResolutionDetails[Any]:
        """Kết quả của lõi ⇒ hợp đồng của OpenFeature; thuần, không chạm trạng thái."""
        metadata: dict[str, bool | int | float | str] = {}
        if "ruleId" in evaluation:
            metadata["ruleId"] = evaluation["ruleId"]
        if evaluation.get("archived") is True:
            metadata["archived"] = True
        if self._sync.is_stale:
            metadata["stale"] = True

        if evaluation["reason"] == "ERROR":
            return FlagResolutionDetails(
                value=default_value,
                reason=Reason.ERROR,
                error_code=ERROR_CODE[evaluation.get("errorCode", "GENERAL")],
                error_message=evaluation.get("errorMessage"),
                flag_metadata=metadata,
            )
        reason = Reason(evaluation["reason"])
        if "value" not in evaluation:
            # DISABLED: default trong code của ứng dụng (§6.5)
            return FlagResolutionDetails(value=default_value, reason=reason, flag_metadata=metadata)
        value = _coerce(kind, evaluation["value"])
        if value is _MISMATCH:
            return FlagResolutionDetails(
                value=default_value,
                reason=Reason.ERROR,
                error_code=ErrorCode.TYPE_MISMATCH,
                error_message="giá trị variant không đúng kiểu flag",
                flag_metadata=metadata,
            )
        return FlagResolutionDetails(
            value=value, reason=reason, variant=evaluation.get("variant"), flag_metadata=metadata
        )

    def resolve_boolean_details(
        self, flag_key: str, default_value: bool, evaluation_context: EvaluationContext | None = None
    ) -> FlagResolutionDetails[bool]:
        return self._resolve("boolean", flag_key, default_value, evaluation_context)

    def resolve_string_details(
        self, flag_key: str, default_value: str, evaluation_context: EvaluationContext | None = None
    ) -> FlagResolutionDetails[str]:
        return self._resolve("string", flag_key, default_value, evaluation_context)

    def resolve_integer_details(
        self, flag_key: str, default_value: int, evaluation_context: EvaluationContext | None = None
    ) -> FlagResolutionDetails[int]:
        return self._resolve("integer", flag_key, default_value, evaluation_context)

    def resolve_float_details(
        self, flag_key: str, default_value: float, evaluation_context: EvaluationContext | None = None
    ) -> FlagResolutionDetails[float]:
        return self._resolve("float", flag_key, default_value, evaluation_context)

    def resolve_object_details(
        self,
        flag_key: str,
        default_value: Sequence[FlagValueType] | Mapping[str, FlagValueType],
        evaluation_context: EvaluationContext | None = None,
    ) -> FlagResolutionDetails[Sequence[FlagValueType] | Mapping[str, FlagValueType]]:
        return self._resolve("object", flag_key, default_value, evaluation_context)
