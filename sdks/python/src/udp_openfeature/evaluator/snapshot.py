"""``config_hash`` — cùng luật chuẩn hoá với ``@udp/flag-evaluator`` (§9 ``SdkConfigResponse``).

::

    configHash = sha256(canonicalJson(normalizeSnapshot({ flags, segments, trackedFlags })))

JSON chuẩn tắc được VIẾT TAY chứ không gọi ``json.dumps``: số theo Number::toString của
ECMAScript (RFC 8785), khoá sắp theo đơn vị mã UTF-16, chuỗi giá trị chuẩn hoá NFC (KHOÁ thì
không), và ký tự thay thế đơn lẻ in thành ``\\udXXX`` như ``JSON.stringify`` bản ES2019. Lệch
một trong bốn điều đó là ``config_hash`` lệch vĩnh viễn và provider RESYNC mãi.
"""

from __future__ import annotations

import hashlib
import math
import unicodedata
from typing import Any

from .jsvalue import number_to_string, utf16_key

_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\b": "\\b",
    "\f": "\\f",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
}


def _quote(text: str) -> str:
    out = ['"']
    for ch in text:
        code = ord(ch)
        if ch in _ESCAPES:
            out.append(_ESCAPES[ch])
        elif code < 0x20 or 0xD800 <= code <= 0xDFFF:
            out.append(f"\\u{code:04x}")
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _canonical(value: Any, path: str) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return _quote(unicodedata.normalize("NFC", value))
    if isinstance(value, (int, float)):
        if isinstance(value, float) and not math.isfinite(value):
            raise ValueError(f"Snapshot chứa số không hữu hạn tại {path}: {value!r}")
        return number_to_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(_canonical(v, f"{path}[{i}]") for i, v in enumerate(value)) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys(), key=utf16_key)
        return "{" + ",".join(f"{_quote(k)}:{_canonical(value[k], f'{path}.{k}')}" for k in keys) + "}"
    raise TypeError(f"Snapshot chứa giá trị không tuần tự hoá ổn định được tại {path}: {type(value).__name__}")


def canonical_json(value: Any) -> str:
    """``canonicalJson`` của lõi Node — xem đầu tệp."""
    return _canonical(value, "$")


def normalize_snapshot(snapshot: dict[str, Any]) -> dict[str, Any]:
    """Sắp flag theo ``key``, rule theo ``(priority, id)``, segment theo ``id``, ``trackedFlags``.

    KHÔNG sắp ``weights``: thứ tự đó mang ngữ nghĩa (khoảng tích luỹ), sắp ở tầng băm là để hai
    cấu hình hành vi khác nhau ra cùng hash.
    """

    def entry_of(entry: dict[str, Any]) -> dict[str, Any]:
        # Cùng phép thử của lõi Node: có khoá `archived` là bia mộ, không có rule để sắp
        if "archived" in entry:
            return entry
        rules = sorted(
            entry.get("rules", []),
            key=lambda r: (r.get("priority", 0), utf16_key(str(r.get("id", "")))),
        )
        return {**entry, "rules": rules}

    return {
        "flags": [entry_of(e) for e in sorted(snapshot.get("flags", []), key=lambda e: utf16_key(e["key"]))],
        "segments": sorted(snapshot.get("segments", []), key=lambda s: utf16_key(s["id"])),
        "trackedFlags": sorted(snapshot.get("trackedFlags", []), key=utf16_key),
    }


def config_hash_of(snapshot: dict[str, Any]) -> str:
    """SHA-256 hex của snapshot đã chuẩn hoá — 64 ký tự như cột ``config_hash``."""
    normalized = normalize_snapshot(snapshot)
    return hashlib.sha256(canonical_json(normalized).encode("utf-8", "surrogatepass")).hexdigest()
