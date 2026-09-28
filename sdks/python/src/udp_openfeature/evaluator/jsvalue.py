"""Ngữ nghĩa giá trị JavaScript mà lõi đánh giá phụ thuộc vào.

Lõi của UDP chạy trên JavaScript (Service 2 và provider Node). Bản Python phải ra CÙNG kết quả
(I26 giữa hai ngôn ngữ, §6.8), nên ba chỗ JavaScript và Python khác nhau phải được viết lại
tường minh ở đây thay vì tin vào hành vi mặc định của Python:

- ``String(number)``: ECMAScript in số theo thuật toán Number::toString (``1e+21``, ``1e-7``,
  ``5`` cho 5.0) — ``repr`` của Python in ``1e-07`` và ``5.0``. RFC 8785 (JSON chuẩn tắc) dùng
  đúng thuật toán này, nên ``config_hash`` phụ thuộc vào nó.
- Thứ tự chuỗi: JavaScript so theo ĐƠN VỊ MÃ UTF-16, Python theo code point. Hai phép so khác
  nhau với ký tự ngoài BMP (emoji đứng TRƯỚC U+E000–U+FFFF trong UTF-16).
- Kiểu: ``bool`` của Python là lớp con của ``int``; ``typeof true`` là ``"boolean"``, không
  phải ``"number"``.
"""

from __future__ import annotations

import json
import math
from typing import Any

MAX_SAFE_INTEGER = 2**53 - 1


def _reject_constant(name: str) -> Any:
    raise ValueError(f"JSON không có {name}")


def _js_int(text: str) -> int | float:
    value = int(text)
    return value if abs(value) <= MAX_SAFE_INTEGER else float(text)


def json_parse(text: str | bytes) -> Any:
    """``JSON.parse``: không ``NaN``/``Infinity`` (``json`` của Python nhận chúng), và số nguyên
    ngoài vùng an toàn thành double như JavaScript — phép so của lõi phải thấy CÙNG con số."""
    return json.loads(text, parse_constant=_reject_constant, parse_int=_js_int)


def js_typeof(value: Any) -> str:
    """``typeof`` của JavaScript cho giá trị đến từ JSON."""
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if value is None:
        return "object"
    return "object"


def is_finite_number(value: Any) -> bool:
    """Số hữu hạn theo nghĩa JavaScript — ``True`` không phải số."""
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value)


def utf16_key(text: str) -> bytes:
    """Khoá sắp xếp theo đơn vị mã UTF-16 — phép so ``<`` của JavaScript trên chuỗi."""
    return text.encode("utf-16-be", "surrogatepass")


def utf16_length(text: str) -> int:
    """``string.length`` của JavaScript: số đơn vị mã UTF-16, không phải số code point."""
    return len(text.encode("utf-16-le", "surrogatepass")) // 2


def number_to_string(value: float | int) -> str:
    """ECMAScript Number::toString (ECMA-262 §6.1.6.1.20) cho số hữu hạn.

    Chữ số ngắn nhất lấy từ ``repr`` (Python cũng in biểu diễn ngắn nhất đọc ngược lại đúng
    double đó), còn vị trí dấu chấm và dạng mũ đặt theo quy tắc của ECMAScript.
    """
    if isinstance(value, bool):
        raise TypeError("bool không phải số")
    if isinstance(value, int):
        if abs(value) < 10**21:
            return str(value)
        value = float(value)
    if not math.isfinite(value):
        raise ValueError(f"số không hữu hạn: {value!r}")
    if value == 0:
        return "0"
    if value < 0:
        return "-" + number_to_string(-value)
    mantissa, _, exponent = repr(value).partition("e")
    whole, _, fraction = mantissa.partition(".")
    digits = (whole + fraction).lstrip("0")
    point = len(whole) + (int(exponent) if exponent else 0)
    if whole == "0":
        # 0.000123 ⇒ chữ số "123", dấu chấm lùi theo số số 0 đứng đầu phần thập phân
        point -= len(fraction) - len(fraction.lstrip("0"))
        point -= 1
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    n = point
    if k <= n <= 21:
        return digits + "0" * (n - k)
    if 0 < n <= 21:
        return digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return "0." + "0" * (-n) + digits
    e = n - 1
    sign = "+" if e > 0 else "-"
    head = digits if k == 1 else digits[0] + "." + digits[1:]
    return f"{head}e{sign}{abs(e)}"


def to_js_string(value: Any) -> str:
    """``String(value)`` của JavaScript cho giá trị đến từ JSON."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return number_to_string(value)
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join("" if v is None else to_js_string(v) for v in value)
    return "[object Object]"
