"""Cache cấu hình của MỘT environment trong provider (§6.8) — bản Python của ``store.ts``.

Thuần, không I/O. Giữ snapshot, bản đã dựng cho đánh giá (một lần mỗi version), con trỏ, và tập
``tracked_flags`` (sửa TẠI CHỖ: hook đọc cùng một ``set`` suốt đời provider). Con trỏ là
``configVersion`` ĐÃ ÁP — event nhận được mà không áp được không làm con trỏ tiến.

Luồng: chỉ vòng đồng bộ ghi (dưới khoá của nó); luồng đánh giá chỉ đọc ``prepared`` — MỘT lần
đọc tham chiếu, luôn thấy trọn một bản đã dựng.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

from .evaluator import apply_delta, canonical_json, prepare_snapshot
from .evaluator.jsvalue import utf16_key
from .evaluator.prepare import PreparedSnapshot

Snapshot = dict[str, Any]

ResyncReason = Literal[
    "gap", "hash-mismatch", "malformed", "no-baseline-cache", "bad-cursor", "unknown-event", "malformed-event"
]


def etag_of(config_version: int) -> str:
    """ETag của ``/sdk/config`` tại một version — cùng ``etagOf`` của ``@udp/flag-evaluator``."""
    return f'"{config_version}"'


@dataclass(frozen=True)
class StoreDeltaOutcome:
    kind: Literal["applied", "ignored", "resync"]
    changed: list[str] = field(default_factory=list)
    reason: ResyncReason | None = None


class ConfigStore:
    def __init__(self) -> None:
        self._current: Snapshot | None = None
        self._prepared: PreparedSnapshot | None = None
        self._version = -1
        self._etag: str | None = None
        self._resync = False
        self.tracked_flags: set[str] = set()

    @property
    def has_data(self) -> bool:
        return self._current is not None

    @property
    def config_version(self) -> int:
        return self._version

    @property
    def snapshot(self) -> Snapshot | None:
        """Snapshot đang phục vụ — I15c so nó với ``/sdk/config`` cùng version."""
        return self._current

    @property
    def prepared(self) -> PreparedSnapshot | None:
        return self._prepared

    @property
    def etag(self) -> str | None:
        """ETag của cấu hình đang giữ — ``If-None-Match`` của polling (revalidate)."""
        return self._etag

    @property
    def needs_resync(self) -> bool:
        """Cache có thể đang sai nội dung: giữ tới khi áp được một SNAPSHOT.

        Trong lúc này polling không gửi ``If-None-Match`` và stream mở không con trỏ —
        revalidate sẽ nhận 304 "xác nhận" đúng cái cache đang hỏng.
        """
        return self._resync

    def mark_needs_resync(self) -> None:
        self._resync = True

    def replace(self, config: dict[str, Any], etag: str | None) -> list[str]:
        """Thay toàn bộ cache (snapshot từ ``/sdk/config`` hoặc event ``snapshot``)."""
        nxt: Snapshot = {
            "flags": config["flags"],
            "segments": config["segments"],
            "trackedFlags": config["trackedFlags"],
        }
        changed = _changed_keys(self._current, nxt)
        self._install(nxt, config["configVersion"])
        self._etag = etag if etag is not None else etag_of(config["configVersion"])
        self._resync = False
        return changed

    def apply_delta(self, delta: dict[str, Any]) -> StoreDeltaOutcome:
        """Áp một ``flag_changed`` bằng hàm áp delta DÙNG CHUNG với Service 2 (I15c)."""
        if self._current is None:
            return StoreDeltaOutcome("resync", reason="no-baseline-cache")
        if self._resync:
            return StoreDeltaOutcome("resync", reason="gap")
        out = apply_delta(self._current, self._version, delta)
        if out.kind == "ignored":
            return StoreDeltaOutcome("ignored")
        if out.kind == "resync" or out.snapshot is None or out.config_version is None:
            self._resync = True
            return StoreDeltaOutcome("resync", reason=out.reason or "malformed")
        # `changes` rỗng ⇒ nội dung y nguyên: chỉ tiến con trỏ và ETag, không dựng lại (C-17)
        if out.snapshot is self._current:
            self._version = out.config_version
            self._etag = etag_of(out.config_version)
            return StoreDeltaOutcome("applied")
        changed = _changed_keys(self._current, out.snapshot)
        self._install(out.snapshot, out.config_version)
        # Đúng ETag của `/sdk/config` tại version này — poll sau đó nhận 304
        self._etag = etag_of(out.config_version)
        return StoreDeltaOutcome("applied", changed=changed)

    def _install(self, snapshot: Snapshot, version: int) -> None:
        self._current = snapshot
        self._prepared = prepare_snapshot(snapshot)
        self._version = version
        # Sửa theo HIỆU chứ không xoá-rồi-thêm: luồng đánh giá đọc tập này song song, và một
        # key đang tracked không được vắng mặt dù chỉ một khoảnh khắc (mất nhãn `ff`)
        wanted = {k for k in snapshot["trackedFlags"] if isinstance(k, str)}
        self.tracked_flags.difference_update(self.tracked_flags - wanted)
        self.tracked_flags.update(wanted)


def _segment_refs_of(entry: Any) -> list[str]:
    """id segment mà một flag trỏ tới qua rule SEGMENT."""
    rules = entry.get("rules") if isinstance(entry, dict) else None
    if not isinstance(rules, list):
        return []
    ids: list[str] = []
    for rule in rules:
        if not isinstance(rule, dict) or rule.get("type") != "SEGMENT":
            continue
        condition = rule.get("condition")
        segment_id = condition.get("segmentId") if isinstance(condition, dict) else None
        if isinstance(segment_id, str):
            ids.append(segment_id)
    return ids


def _changed_keys(before: Snapshot | None, after: Snapshot) -> list[str]:
    """Key flag có KẾT QUẢ ĐÁNH GIÁ có thể đã đổi — ``flagsChanged`` của CONFIGURATION_CHANGED.

    Entry của nó đổi, HOẶC một segment nó trỏ tới đổi. Lỗi chuẩn hoá ⇒ coi mọi key là đổi —
    thà báo thừa còn hơn nuốt một thay đổi.
    """

    def index(items: list[Any], key: str) -> dict[str, str]:
        return {item[key]: canonical_json(item) for item in items}

    def diff(a: dict[str, str], b: dict[str, str]) -> set[str]:
        return {k for k in a.keys() | b.keys() if a.get(k) != b.get(k)}

    try:
        changed = diff(index(before["flags"] if before else [], "key"), index(after["flags"], "key"))
        segments = diff(index(before["segments"] if before else [], "id"), index(after["segments"], "id"))
        if segments:
            for entry in after["flags"]:
                if any(sid in segments for sid in _segment_refs_of(entry)):
                    changed.add(entry["key"])
        return sorted(changed, key=utf16_key)
    except Exception:  # noqa: BLE001
        return sorted((f["key"] for f in after["flags"]), key=utf16_key)
