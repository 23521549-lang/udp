"""Đánh giá một flag (§6.5) — cùng ``evaluate``/``evaluateAll`` của lõi Node, không bao giờ ném (I33).

Kết quả là ``dict`` cùng khoá với ``Evaluation`` của ``@udp/shared-types``: ``reason``, ``value``,
``variant``, ``errorCode``, ``errorMessage``, ``ruleId``, ``archived`` — khoá vắng khi không có.
"""

from __future__ import annotations

from typing import Any

from .conditions import attribute_of, normalize_context
from .hashing import bucket_of
from .jsvalue import is_finite_number, number_to_string
from .prepare import PreparedFlag, PreparedSnapshot, SegmentMatcher, segment_matcher_of

EVALUATOR_SEMANTICS_VERSION = 1

Evaluation = dict[str, Any]


def _failure(code: str, message: str) -> Evaluation:
    return {"reason": "ERROR", "errorCode": code, "errorMessage": message}


def sticky_value_of(flag: PreparedFlag, context: dict[str, Any]) -> str | None:
    """Thuộc tính stickiness, rơi về ``targetingKey``; số và boolean in như ``String()`` của JS."""
    raw = attribute_of(context, flag.stickiness_attribute)
    if raw is None:
        raw = attribute_of(context, "targetingKey")
    if isinstance(raw, str):
        return raw
    if isinstance(raw, bool):
        return "true" if raw else "false"
    if is_finite_number(raw):
        return number_to_string(raw)
    return None


def _pick_variant(serve: dict[str, Any], sticky: str | None, flag_key: str, salt: str) -> tuple[str, str] | None:
    """``(loại, variantKey)``; ``None`` khi rule phân phối gặp người dùng ẩn danh — bỏ qua rule."""
    if serve["kind"] == "variant":
        return "variant", serve["variantKey"]
    if sticky is None or sticky == "":
        return None
    bucket = bucket_of(sticky, flag_key, salt)
    cumulative = 0
    for piece in serve["weights"]:
        cumulative += int(piece["weight"])
        if bucket < cumulative:
            return "distribution", piece["variantKey"]
    raise ValueError(f"serve.weights tổng {cumulative} không phủ bucket {bucket}")


def _evaluate_flag(flag: PreparedFlag, context: dict[str, Any], segments: SegmentMatcher) -> Evaluation:
    if not flag.is_enabled:
        return {"reason": "DISABLED"}
    sticky = sticky_value_of(flag, context)
    for rule in flag.rules:
        if rule.matches is None or rule.serve is None:
            return {**_failure("GENERAL", "rule hỏng trong snapshot"), "ruleId": rule.id}
        matched = rule.matches(context, segments)
        if matched == "broken":
            return {**_failure("GENERAL", "segment hỏng trong snapshot"), "ruleId": rule.id}
        if not matched:
            continue
        pick = _pick_variant(rule.serve, sticky, flag.key, rule.bucket_salt)
        if pick is None:
            continue
        kind, variant = pick
        if variant not in flag.variants:
            return {**_failure("GENERAL", "orphan variant"), "ruleId": rule.id}
        return {
            "reason": "SPLIT" if kind == "distribution" else "TARGETING_MATCH",
            "value": flag.variants[variant],
            "variant": variant,
            "ruleId": rule.id,
        }
    if flag.default_variant_key not in flag.variants:
        return _failure("GENERAL", "orphan default variant")
    return {
        "reason": "DEFAULT",
        "value": flag.variants[flag.default_variant_key],
        "variant": flag.default_variant_key,
    }


def _evaluate_normalized(
    prepared: PreparedSnapshot,
    flag_key: str,
    context: dict[str, Any],
    segments: SegmentMatcher,
    expected_type: str | None,
) -> Evaluation:
    try:
        entry = prepared.flags.get(flag_key)
        if entry is None:
            return _failure("FLAG_NOT_FOUND", "flag không có")
        if entry.kind == "tombstone":
            return {"reason": "DISABLED", "archived": True}
        if entry.kind == "broken":
            return _failure("GENERAL", "flag hỏng trong snapshot")
        if expected_type is not None and expected_type != entry.type:
            return _failure("TYPE_MISMATCH", f"flag có kiểu {entry.type}")
        return _evaluate_flag(entry, context, segments)
    except Exception:  # noqa: BLE001 — I33: không ngoại lệ nào thoát ra ứng dụng của khách
        return _failure("GENERAL", "lỗi đánh giá")


def _context_of(context: Any) -> dict[str, Any]:
    return normalize_context(context) if isinstance(context, dict) else {}


def evaluate(
    prepared: PreparedSnapshot,
    flag_key: str,
    context: Any,
    expected_type: str | None = None,
) -> Evaluation:
    try:
        ctx = _context_of(context)
        return _evaluate_normalized(prepared, flag_key, ctx, segment_matcher_of(prepared, ctx), expected_type)
    except Exception:  # noqa: BLE001 — cùng lý do
        return _failure("GENERAL", "lỗi đánh giá")


def evaluate_all(prepared: PreparedSnapshot, context: Any) -> list[tuple[str, Evaluation]]:
    try:
        ctx = _context_of(context)
    except Exception:  # noqa: BLE001
        ctx = {}
    segments = segment_matcher_of(prepared, ctx)
    return [(key, _evaluate_normalized(prepared, key, ctx, segments, None)) for key in prepared.keys]
