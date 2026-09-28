"""Áp delta của stream (§6.3) — cùng ``applyChange``/``applyDelta``/``hashVerdict`` của lõi Node.

Luật con trỏ phía provider: ``toVersion ≤ con trỏ`` ⇒ bỏ qua (tới trễ hay trùng);
``fromVersion ≠ con trỏ`` ⇒ RESYNC (hổng); hash lệch sau khi áp ⇒ RESYNC; ``configHash`` rỗng là
environment CHƯA CÓ MỐC, không phải lệch. Dữ liệu sai hình ⇒ RESYNC, không ném.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

from .jsvalue import is_finite_number
from .snapshot import config_hash_of

Snapshot = dict[str, Any]


def _is_int(v: Any, minimum: int | None = None) -> bool:
    """``z.number().int()``: JSON ``5.0`` là số nguyên với JS, nên ``float`` nguyên cũng hợp lệ."""
    ok = is_finite_number(v) and float(v).is_integer()
    return ok and (minimum is None or v >= minimum)


def _pick(raw: dict[str, Any], keys: tuple[str, ...]) -> dict[str, Any]:
    """``z.object`` mặc định bỏ khoá lạ — bản Python cũng bỏ, để hai bên cầm cùng một vật."""
    return {k: raw[k] for k in keys}


def _entry_ok(v: Any) -> bool:
    return isinstance(v, dict) and isinstance(v.get("key"), str) and v["key"] != ""


def _segment_ok(v: Any) -> bool:
    return (
        isinstance(v, dict)
        and isinstance(v.get("id"), str)
        and isinstance(v.get("all"), list)
        and isinstance(v.get("userIds"), list)
        and all(isinstance(u, str) for u in v["userIds"])
    )


def _change_ok(c: Any) -> bool:
    if not isinstance(c, dict) or not _is_int(c.get("configVersion")):
        return False
    kind = c.get("kind")
    if kind == "flag":
        return _entry_ok(c.get("flag"))
    if kind == "flagAbsent":
        return isinstance(c.get("key"), str) and c["key"] != ""
    if kind == "trackedFlags":
        return isinstance(c.get("trackedFlags"), list) and all(isinstance(k, str) for k in c["trackedFlags"])
    if kind == "segment":
        return _segment_ok(c.get("segment"))
    if kind == "segmentAbsent":
        return isinstance(c.get("id"), str) and c["id"] != ""
    return False


_CONFIG_KEYS = ("configVersion", "configHash", "environment", "trackedFlags", "flags", "segments")
_DELTA_KEYS = ("fromVersion", "toVersion", "configHash", "changes")
_CHANGE_KEYS = {
    "flag": ("configVersion", "kind", "flag"),
    "flagAbsent": ("configVersion", "kind", "key"),
    "trackedFlags": ("configVersion", "kind", "trackedFlags"),
    "segment": ("configVersion", "kind", "segment"),
    "segmentAbsent": ("configVersion", "kind", "id"),
}


def parse_sdk_config(raw: Any) -> dict[str, Any] | None:
    """Body ``/sdk/config`` hợp lệ, hoặc ``None`` (⇒ RESYNC, không ném)."""
    ok = (
        isinstance(raw, dict)
        and _is_int(raw.get("configVersion"), 0)
        and isinstance(raw.get("configHash"), str)
        and isinstance(raw.get("environment"), str)
        and isinstance(raw.get("trackedFlags"), list)
        and all(isinstance(k, str) for k in raw["trackedFlags"])
        and isinstance(raw.get("flags"), list)
        and all(_entry_ok(f) for f in raw["flags"])
        and isinstance(raw.get("segments"), list)
        and all(_segment_ok(s) for s in raw["segments"])
    )
    return _pick(raw, _CONFIG_KEYS) if ok else None


def parse_sdk_delta(raw: Any) -> dict[str, Any] | None:
    ok = (
        isinstance(raw, dict)
        and _is_int(raw.get("fromVersion"), 0)
        and _is_int(raw.get("toVersion"), 0)
        and isinstance(raw.get("configHash"), str)
        and isinstance(raw.get("changes"), list)
        and all(_change_ok(c) for c in raw["changes"])
    )
    if not ok:
        return None
    return {**_pick(raw, _DELTA_KEYS), "changes": [_pick(c, _CHANGE_KEYS[c["kind"]]) for c in raw["changes"]]}


def apply_change(snapshot: Snapshot, change: dict[str, Any]) -> Snapshot:
    kind = change["kind"]
    if kind == "flag":
        key = change["flag"]["key"]
        return {**snapshot, "flags": [f for f in snapshot["flags"] if f.get("key") != key] + [change["flag"]]}
    if kind == "flagAbsent":
        return {**snapshot, "flags": [f for f in snapshot["flags"] if f.get("key") != change["key"]]}
    if kind == "trackedFlags":
        return {**snapshot, "trackedFlags": list(change["trackedFlags"])}
    if kind == "segment":
        sid = change["segment"]["id"]
        return {**snapshot, "segments": [s for s in snapshot["segments"] if s.get("id") != sid] + [change["segment"]]}
    if kind == "segmentAbsent":
        return {**snapshot, "segments": [s for s in snapshot["segments"] if s.get("id") != change["id"]]}
    raise ValueError(f"kind lạ: {kind!r}")


HashVerdict = Literal["ok", "mismatch", "no-baseline"]


def hash_verdict(snapshot: Snapshot, expected: str) -> HashVerdict:
    if expected == "":
        return "no-baseline"
    return "ok" if config_hash_of(snapshot) == expected else "mismatch"


@dataclass(frozen=True)
class DeltaOutcome:
    kind: Literal["applied", "ignored", "resync"]
    snapshot: Snapshot | None = None
    config_version: int | None = None
    reason: Literal["gap", "hash-mismatch", "malformed"] | None = None


def apply_delta(snapshot: Snapshot, config_version: int, delta: dict[str, Any]) -> DeltaOutcome:
    try:
        if delta["toVersion"] <= config_version:
            return DeltaOutcome("ignored")
        if delta["fromVersion"] != config_version:
            return DeltaOutcome("resync", reason="gap")
        current = snapshot
        for change in delta["changes"]:
            current = apply_change(current, change)
        if hash_verdict(current, delta["configHash"]) == "mismatch":
            return DeltaOutcome("resync", reason="hash-mismatch")
        return DeltaOutcome("applied", snapshot=current, config_version=delta["toVersion"])
    except Exception:  # noqa: BLE001 — dữ liệu dây hỏng ⇒ RESYNC, không bao giờ ném
        return DeltaOutcome("resync", reason="malformed")
