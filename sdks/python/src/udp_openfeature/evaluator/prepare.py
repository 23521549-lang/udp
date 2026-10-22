"""Dựng snapshot MỘT lần mỗi version (§6.5) — cùng ``prepareSnapshot`` của lõi Node.

Dữ liệu dây đi qua ĐÚNG các phép kiểm của schema đọc bên Node: entry sai hình có ``key`` là
flag HỎNG (đánh giá trả lỗi GENERAL), rule sai hình là rule HỎNG, segment sai hình là segment
HỎNG. Không phép kiểm nào ở đây được lỏng hơn hay chặt hơn bản Node — lệch là I26 vỡ.
"""

from __future__ import annotations

import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any, Literal, TypeGuard

from .conditions import Compiled, attribute_of, compile_condition, condition_issue, nfc
from .hashing import TOTAL_BUCKETS
from .jsvalue import to_js_string, utf16_key, utf16_length

RULE_TYPES = ("ALL", "USER_BASED", "ATTRIBUTE_BASED", "SEGMENT")

# `z.string().uuid()` của zod 3
_UUID = re.compile(r"^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}\Z")

Broken = Literal["broken"]
SegmentMatcher = Callable[[str], "bool | Broken"]
RuleMatcher = Callable[[dict[str, Any], SegmentMatcher], "bool | Broken"]


@dataclass
class PreparedRule:
    id: str
    matches: RuleMatcher | None
    serve: dict[str, Any] | None
    bucket_salt: str


@dataclass
class PreparedFlag:
    key: str
    type: str
    is_enabled: bool
    stickiness_attribute: str
    variants: dict[str, Any]
    default_variant_key: str
    rules: list[PreparedRule]
    kind: Literal["flag"] = "flag"


@dataclass
class Tombstone:
    key: str
    kind: Literal["tombstone"] = "tombstone"


@dataclass
class BrokenFlag:
    key: str
    kind: Literal["broken"] = "broken"


@dataclass
class PreparedSegment:
    user_ids: frozenset[str]
    all: list[Compiled]


@dataclass
class PreparedSnapshot:
    flags: dict[str, PreparedFlag | Tombstone | BrokenFlag] = field(default_factory=dict)
    keys: list[str] = field(default_factory=list)
    segments: dict[str, PreparedSegment | Broken] = field(default_factory=dict)


def _is_str(v: Any) -> TypeGuard[str]:
    return isinstance(v, str)


def _serve_ok(serve: Any) -> bool:
    """``flagServeWireSchema``: hai hình ``.strict()``, tổng trọng số đúng, variant không trùng."""
    if not isinstance(serve, dict):
        return False
    kind = serve.get("kind")
    if kind == "variant":
        key = serve.get("variantKey")
        return set(serve) == {"kind", "variantKey"} and _is_str(key) and 1 <= utf16_length(key) <= 100
    if kind != "distribution" or set(serve) != {"kind", "weights"}:
        return False
    weights = serve.get("weights")
    if not isinstance(weights, list) or len(weights) == 0:
        return False
    seen: set[str] = set()
    total = 0
    for w in weights:
        if not isinstance(w, dict):
            return False
        key, weight = w.get("variantKey"), w.get("weight")
        if not (_is_str(key) and 1 <= utf16_length(key) <= 100):
            return False
        if isinstance(weight, bool) or not isinstance(weight, (int, float)):
            return False
        if weight != int(weight) or not 0 <= weight <= TOTAL_BUCKETS:
            return False
        if key in seen:
            return False
        seen.add(key)
        total += int(weight)
    return total == TOTAL_BUCKETS


def _strict(condition: Any, keys: set[str]) -> bool:
    return isinstance(condition, dict) and set(condition) == keys


def _matcher_of(rule_type: str, condition: Any) -> RuleMatcher | None:
    if rule_type == "ALL":
        return (lambda _ctx, _seg: True) if _strict(condition, set()) else None
    if rule_type == "USER_BASED":
        if not _strict(condition, {"userIds"}):
            return None
        ids = condition["userIds"]
        if not isinstance(ids, list) or len(ids) == 0 or not all(_is_str(u) for u in ids):
            return None
        members = {nfc(u) for u in ids}

        def user_based(ctx: dict[str, Any], _seg: SegmentMatcher) -> bool:
            key = attribute_of(ctx, "targetingKey")
            return isinstance(key, str) and key != "" and key in members

        return user_based
    if rule_type == "ATTRIBUTE_BASED":
        if not _strict(condition, {"all"}):
            return None
        items = condition["all"]
        if not isinstance(items, list) or len(items) == 0:
            return None
        if any(condition_issue(c) is not None for c in items):
            return None
        compiled = [compile_condition(c) for c in items]
        return lambda ctx, _seg: all(c(ctx) for c in compiled)
    if rule_type == "SEGMENT":
        if not _strict(condition, {"segmentId"}):
            return None
        segment_id = condition["segmentId"]
        if not _is_str(segment_id) or _UUID.match(segment_id) is None:
            return None
        return lambda _ctx, segments: segments(segment_id)
    return None


def _prepare_rule(raw: Any) -> PreparedRule:
    valid = (
        isinstance(raw, dict)
        and _is_str(raw.get("id"))
        and raw.get("type") in RULE_TYPES
        and _serve_ok(raw.get("serve"))
        and _is_str(raw.get("bucketSalt"))
    )
    if not valid:
        rid = to_js_string(raw["id"]) if isinstance(raw, dict) and "id" in raw else ""
        return PreparedRule(rid, None, None, "")
    try:
        matches = _matcher_of(raw["type"], raw.get("condition"))
    except Exception:  # noqa: BLE001 — semver/regex hỏng ⇒ rule hỏng, như `catch` của bản Node
        matches = None
    # `condition: z.unknown()` của bản Node nhận cả khi vắng — schema theo loại mới từ chối nó
    return PreparedRule(raw["id"], matches, raw["serve"], raw["bucketSalt"])


def _prepare_entry(raw: Any) -> PreparedFlag | Tombstone | BrokenFlag | None:
    if isinstance(raw, dict) and _is_str(raw.get("key")) and raw.get("archived") is True:
        return Tombstone(raw["key"])
    valid = (
        isinstance(raw, dict)
        and _is_str(raw.get("key"))
        and _is_str(raw.get("type"))
        and isinstance(raw.get("isEnabled"), bool)
        and _is_str(raw.get("stickinessAttribute"))
        and isinstance(raw.get("variants"), dict)
        and _is_str(raw.get("defaultVariantKey"))
        and isinstance(raw.get("rules"), list)
    )
    if not valid:
        key = raw.get("key") if isinstance(raw, dict) else None
        return BrokenFlag(key) if _is_str(key) else None
    return PreparedFlag(
        key=raw["key"],
        type=raw["type"],
        is_enabled=raw["isEnabled"],
        stickiness_attribute=raw["stickinessAttribute"],
        variants=dict(raw["variants"]),
        default_variant_key=raw["defaultVariantKey"],
        rules=[_prepare_rule(r) for r in raw["rules"]],
    )


def _prepare_segment(raw: Any) -> tuple[str, PreparedSegment | Broken] | None:
    valid = (
        isinstance(raw, dict)
        and _is_str(raw.get("id"))
        and isinstance(raw.get("all"), list)
        and isinstance(raw.get("userIds"), list)
        and all(_is_str(u) for u in raw["userIds"])
    )
    if not valid:
        sid = raw.get("id") if isinstance(raw, dict) else None
        return (sid, "broken") if _is_str(sid) else None
    if any(condition_issue(c) is not None for c in raw["all"]):
        return raw["id"], "broken"
    try:
        compiled = [compile_condition(c) for c in raw["all"]]
    except Exception:  # noqa: BLE001 — cùng lý do với rule
        return raw["id"], "broken"
    return raw["id"], PreparedSegment(frozenset(nfc(u) for u in raw["userIds"]), compiled)


def prepare_snapshot(snapshot: dict[str, Any]) -> PreparedSnapshot:
    """Snapshot dây ⇒ bản đã dựng; không bao giờ ném (I33)."""
    prepared = PreparedSnapshot()
    try:
        flags = snapshot.get("flags") if isinstance(snapshot, dict) else None
        if isinstance(flags, list):
            for raw in flags:
                entry = _prepare_entry(raw)
                if entry is not None:
                    prepared.flags[entry.key] = entry
        segments = snapshot.get("segments") if isinstance(snapshot, dict) else None
        if isinstance(segments, list):
            for raw in segments:
                seg = _prepare_segment(raw)
                if seg is not None:
                    prepared.segments[seg[0]] = seg[1]
    except Exception:  # noqa: BLE001 — một snapshot hỏng không được làm sập ứng dụng khách
        pass
    prepared.keys = sorted(prepared.flags.keys(), key=utf16_key)
    return prepared


def segment_matcher_of(prepared: PreparedSnapshot, context: dict[str, Any]) -> SegmentMatcher:
    memo: dict[str, bool | Broken] = {}

    def match(segment_id: str) -> bool | Broken:
        if segment_id in memo:
            return memo[segment_id]
        segment = prepared.segments.get(segment_id)
        result: bool | Broken
        if segment is None:
            result = False
        elif segment == "broken":
            result = "broken"
        else:
            key = attribute_of(context, "targetingKey")
            result = (isinstance(key, str) and key != "" and key in segment.user_ids) or (
                len(segment.all) > 0 and all(c(context) for c in segment.all)
            )
        memo[segment_id] = result
        return result

    return match
