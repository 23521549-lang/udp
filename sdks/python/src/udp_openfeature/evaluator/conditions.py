"""Điều kiện thuộc tính (§6.5) — cùng ngữ nghĩa ``conditions.ts`` và schema đọc của ``condition.ts``.

- Tra thuộc tính bằng khoá phẳng; vắng hoặc ``null`` ⇒ false với MỌI toán tử, kể cả ``neq``/``nin``.
- So CHẶT, không ép kiểu: ``eq 5`` không khớp ``"5"``; khác kiểu thì ``eq`` lẫn ``neq`` đều false.
- Chuỗi so sau NFC ở cả hai phía.

Hàm ``condition_issue`` là phép kiểm của schema ĐỌC (``readAttributeConditionSchema``): điều kiện
sai hình làm rule HỎNG (lỗi GENERAL), đúng như lõi Node — không đoán, không bỏ qua.
"""

from __future__ import annotations

import unicodedata
from collections.abc import Callable
from typing import Any

from .jsvalue import is_finite_number, js_typeof, utf16_length
from .regex_compat import InvalidPattern, UnsupportedPattern, compile_js_regex, translate
from .semver import compare_semver, parse_semver

REGEX_INPUT_MAX = 256

Context = dict[str, Any]
Compiled = Callable[[Context], bool]

_SCALAR_OPERATORS = {"eq", "neq"}
_LIST_OPERATORS = {"in", "nin"}
_NUMBER_OPERATORS = {"gt", "gte", "lt", "lte"}
_TEXT_OPERATORS = {"contains", "startsWith", "endsWith"}
_SEMVER_OPERATORS = {"semverGt", "semverLt"}
OPERATORS = _SCALAR_OPERATORS | _LIST_OPERATORS | _NUMBER_OPERATORS | _TEXT_OPERATORS | _SEMVER_OPERATORS | {"regex"}


def nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def attribute_of(context: Context, name: str) -> Any:
    """Giá trị của thuộc tính, hoặc ``None`` khi vắng hay ``null``."""
    return context.get(name)


def normalize_context(context: Context) -> Context:
    """Mọi chuỗi cấp một đã NFC — một lần mỗi lượt đánh giá."""
    return {k: nfc(v) if isinstance(v, str) else v for k, v in context.items()}


def regex_syntax_issue(pattern: str) -> str | None:
    """``regexSyntaxIssue`` của ``@udp/shared-types``: NFC, ngữ pháp khả chuyển, và biên dịch
    được với cờ ``u`` — parser của ``regex_compat`` nhận ĐÚNG tập pattern ``new RegExp`` nhận."""
    if pattern != nfc(pattern):
        return "pattern phải ở dạng Unicode NFC"
    try:
        translate(pattern)
    except (InvalidPattern, UnsupportedPattern) as err:
        return str(err)
    return None


def condition_issue(raw: Any) -> str | None:
    """Lý do một điều kiện thuộc tính không qua schema đọc, hoặc ``None``."""
    if not isinstance(raw, dict):
        return "điều kiện phải là object"
    if set(raw.keys()) != {"attribute", "operator", "value"}:
        return "điều kiện có trường thiếu hay thừa"
    attribute, operator, value = raw["attribute"], raw["operator"], raw["value"]
    if not isinstance(attribute, str) or attribute in ("", "__proto__"):
        return "tên thuộc tính không hợp lệ"
    if operator in _SCALAR_OPERATORS:
        ok = isinstance(value, (str, bool)) or is_finite_number(value)
    elif operator in _LIST_OPERATORS:
        ok = isinstance(value, list) and len(value) > 0 and all(isinstance(v, str) for v in value)
    elif operator in _NUMBER_OPERATORS:
        ok = is_finite_number(value)
    elif operator in _TEXT_OPERATORS:
        ok = isinstance(value, str) and value != ""
    elif operator in _SEMVER_OPERATORS:
        ok = isinstance(value, str) and parse_semver(value) is not None
    elif operator == "regex":
        ok = isinstance(value, str) and value != "" and regex_syntax_issue(value) is None
    else:
        return f"toán tử lạ: {operator!r}"
    return None if ok else f"giá trị không hợp lệ cho {operator}"


def _on_string(attribute: str, test: Callable[[str], bool]) -> Compiled:
    def run(ctx: Context) -> bool:
        v = attribute_of(ctx, attribute)
        return isinstance(v, str) and test(v)

    return run


def _on_number(attribute: str, test: Callable[[float], bool]) -> Compiled:
    def run(ctx: Context) -> bool:
        v = attribute_of(ctx, attribute)
        return is_finite_number(v) and test(v)

    return run


def compile_condition(c: dict[str, Any]) -> Compiled:
    """Biên dịch điều kiện ĐÃ qua ``condition_issue``. Ném khi semver/regex hỏng — rule HỎNG."""
    attribute: str = c["attribute"]
    operator: str = c["operator"]
    value = c["value"]
    if operator in _SCALAR_OPERATORS:
        target = nfc(value) if isinstance(value, str) else value
        want_equal = operator == "eq"
        target_type = js_typeof(target)

        def scalar(ctx: Context) -> bool:
            v = attribute_of(ctx, attribute)
            if v is None or js_typeof(v) != target_type:
                return False
            return bool(v == target) == want_equal

        return scalar
    if operator in _LIST_OPERATORS:
        members = {nfc(v) for v in value}
        want_member = operator == "in"
        return _on_string(attribute, lambda v: (v in members) == want_member)
    if operator == "gt":
        return _on_number(attribute, lambda v: v > value)
    if operator == "gte":
        return _on_number(attribute, lambda v: v >= value)
    if operator == "lt":
        return _on_number(attribute, lambda v: v < value)
    if operator == "lte":
        return _on_number(attribute, lambda v: v <= value)
    if operator == "contains":
        needle = nfc(value)
        return _on_string(attribute, lambda v: needle in v)
    if operator == "startsWith":
        needle = nfc(value)
        return _on_string(attribute, lambda v: v.startswith(needle))
    if operator == "endsWith":
        needle = nfc(value)
        return _on_string(attribute, lambda v: v.endswith(needle))
    if operator in _SEMVER_OPERATORS:
        target_version = parse_semver(value)
        if target_version is None:
            raise ValueError("semver hỏng")
        sign = 1 if operator == "semverGt" else -1

        def semver(v: str) -> bool:
            parsed = parse_semver(v)
            return parsed is not None and _sign(compare_semver(parsed, target_version)) == sign

        return _on_string(attribute, semver)
    if operator == "regex":
        # Nguyên văn như bản Node — schema đọc đã từ chối pattern chưa ở NFC
        compiled = compile_js_regex(value)
        return _on_string(
            attribute,
            lambda v: utf16_length(v) <= REGEX_INPUT_MAX and compiled.search(v) is not None,
        )
    raise ValueError(f"toán tử lạ: {operator!r}")


def _sign(x: int) -> int:
    return (x > 0) - (x < 0)
