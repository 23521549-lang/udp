"""Toán tử ``regex`` với ngữ nghĩa ECMAScript cờ ``u`` — đúng cách lõi Node chạy nó (§6.5).

Một parser đệ quy theo NGỮ PHÁP ECMAScript (cờ ``u``, không Annex B) làm hai việc trong một lượt:

- **Kiểm** như ``new RegExp(pattern, "u")``: pattern Node bác thì ở đây cũng bác
  (``InvalidPattern``), pattern ngoài ngữ pháp khả chuyển của ``regexSyntaxIssue`` cũng bác
  (``UnsupportedPattern`` — backreference, lookaround, ``\\p{…}``, cờ nội tuyến, tên nhóm không
  phải định danh ASCII hoặc trùng). Hai bên nhận ĐÚNG cùng một tập pattern.
- **Dịch** sang ``re`` cùng nghĩa, biên dịch với ``re.ASCII`` (``\\b``, ``\\B``, ``\\D``, ``\\W``
  theo ASCII như ECMAScript khi không có cờ ``i``). Những chỗ hai bên khác nhau:

  =================  ===================================  =====================================
  Cú pháp            ECMAScript (cờ ``u``)                 Bản dịch
  =================  ===================================  =====================================
  ``\\s`` / ``\\S``   khoảng trắng ECMAScript (có NBSP,     lớp ký tự tường minh; ``\\S`` TRONG
                     BOM, không có U+0085)                lớp ⇒ phép hợp/hiệu bằng lookahead
  ``.``              trừ LF, CR, U+2028, U+2029           lớp phủ định tường minh
  ``$``              CHỈ cuối chuỗi                       ``\\Z``
  ``(?<n>…)``        nhóm có tên                          nhóm thường (tên vô nghĩa khi không
                                                          có backreference)
  ``\\u{…}``, cặp     MỘT code point                       ``\\U…`` của code point đó
  ``\\uD83D\\uDE00``
  ``\\cJ``            ký tự điều khiển                     ``\\x0a``
  ``[^]`` / ``[]``   mọi ký tự / không gì                 ``(?s:.)`` / ``(?!)``
  ``{n,m}`` rất lớn  V8 kẹp ở 2³¹−1                       kẹp ở 10 000 — chuỗi đem so ≤ 256 nên
                                                          cùng nghĩa, và ``re`` không tràn
  =================  ===================================  =====================================

Tương đương được KIỂM bằng vector do lõi Node sinh (pattern ngẫu nhiên, cả hợp lệ lẫn không).
"""

from __future__ import annotations

import re

_MAX_BOUND = 10_000
_SYNTAX = frozenset("^$\\.*+?()[]{}|/")
_CONTROL = {"f": 0x0C, "n": 0x0A, "r": 0x0D, "t": 0x09, "v": 0x0B}
_HEX = re.compile(r"[0-9A-Fa-f]+")
_HEX2 = re.compile(r"[0-9A-Fa-f]{2}")
_HEX4 = re.compile(r"[0-9A-Fa-f]{4}")
_BOUNDS = re.compile(r"\{([0-9]+)(,([0-9]*))?\}")
_GROUP_NAME = re.compile(r"[A-Za-z_$][A-Za-z0-9_$]*")


def _esc(cp: int) -> str:
    """Một code point ở dạng escape của ``re`` — an toàn ở mọi vị trí, kể cả trong lớp ký tự."""
    if cp < 0x100:
        return f"\\x{cp:02x}"
    if cp < 0x10000:
        return f"\\u{cp:04x}"
    return f"\\U{cp:08x}"


def _ranges(pairs: tuple[tuple[int, int], ...]) -> str:
    return "".join(_esc(a) if a == b else f"{_esc(a)}-{_esc(b)}" for a, b in pairs)


# WhiteSpace + LineTerminator của ECMAScript: TAB…CR, SP, NBSP, các Zs, LS/PS, BOM
JS_WHITESPACE = _ranges(
    (
        (0x09, 0x0D),
        (0x20, 0x20),
        (0xA0, 0xA0),
        (0x1680, 0x1680),
        (0x2000, 0x200A),
        (0x2028, 0x2029),
        (0x202F, 0x202F),
        (0x205F, 0x205F),
        (0x3000, 0x3000),
        (0xFEFF, 0xFEFF),
    )
)
_DOT = f"[^{_ranges(((0x0A, 0x0A), (0x0D, 0x0D), (0x2028, 0x2029)))}]"
_SPACE = f"[{JS_WHITESPACE}]"
_NOT_SPACE = f"[^{JS_WHITESPACE}]"
_OUTSIDE = {"d": "[0-9]", "D": "[^0-9]", "w": "[A-Za-z0-9_]", "W": "[^A-Za-z0-9_]", "s": _SPACE, "S": _NOT_SPACE}
# Trong lớp ký tự; `\D`/`\W` với `re.ASCII` trùng nghĩa ECMAScript, `\S` xử lý riêng
_INSIDE = {"d": "0-9", "w": "A-Za-z0-9_", "s": JS_WHITESPACE, "D": "\\D", "W": "\\W"}


class InvalidPattern(ValueError):
    """Không phải regex ECMAScript cờ ``u`` hợp lệ — ``new RegExp`` của Node cũng ném."""


class UnsupportedPattern(ValueError):
    """Hợp lệ với ECMAScript nhưng ngoài ngữ pháp khả chuyển (``regexSyntaxIssue``, D-P35)."""


class _Translator:
    def __init__(self, pattern: str) -> None:
        self._p = pattern
        self._i = 0
        self._names: set[str] = set()

    def run(self) -> str:
        out = self._disjunction()
        if self._i < len(self._p):
            raise InvalidPattern(f"thừa {self._p[self._i]!r}")
        return out

    def _peek(self, ahead: int = 0) -> str:
        j = self._i + ahead
        return self._p[j] if j < len(self._p) else ""

    def _disjunction(self) -> str:
        parts = [self._alternative()]
        while self._peek() == "|":
            self._i += 1
            parts.append(self._alternative())
        return "|".join(parts)

    def _alternative(self) -> str:
        out: list[str] = []
        while self._peek() not in ("", "|", ")"):
            out.append(self._term())
        return "".join(out)

    def _term(self) -> str:
        c = self._peek()
        if c in ("^", "$"):
            self._i += 1
            assertion = "^" if c == "^" else "\\Z"
        elif c == "\\" and self._peek(1) in ("b", "B"):
            # `\B` của `re` (trước 3.14) KHÔNG khớp chuỗi rỗng; ECMAScript thì có — hai phía
            # của vị trí 0 đều không phải chữ
            assertion = "\\b" if self._peek(1) == "b" else "(?:\\B|^\\Z)"
            self._i += 2
        else:
            return self._atom() + self._quantifier()
        # Khẳng định (assertion) không lặp được với cờ `u`
        if self._peek() in ("*", "+", "?", "{"):
            raise InvalidPattern("không có gì để lặp")
        return assertion

    def _quantifier(self) -> str:
        c = self._peek()
        if c in ("*", "+", "?"):
            self._i += 1
            quantifier = c
        elif c == "{":
            m = _BOUNDS.match(self._p, self._i)
            if m is None:
                raise InvalidPattern("{ không thành lượng từ")
            low = int(m.group(1))
            high = None if m.group(3) in (None, "") else int(m.group(3))
            if high is not None and high < low:
                raise InvalidPattern("lượng từ ngược")
            if m.group(2) is None:
                quantifier = f"{{{min(low, _MAX_BOUND)}}}"
            else:
                tail = "" if high is None else str(min(high, _MAX_BOUND))
                quantifier = f"{{{min(low, _MAX_BOUND)},{tail}}}"
            self._i = m.end()
        else:
            return ""
        if self._peek() == "?":
            self._i += 1
            quantifier += "?"
        return quantifier

    def _atom(self) -> str:
        c = self._peek()
        if c == ".":
            self._i += 1
            return _DOT
        if c == "(":
            return self._group()
        if c == "[":
            return self._class()
        if c == "\\":
            return self._atom_escape()
        if c in ("*", "+", "?", "{", "}", "]"):
            raise InvalidPattern(f"{c} đứng một mình")
        self._i += 1
        return re.escape(c)

    def _group(self) -> str:
        p, i = self._p, self._i
        if p.startswith(("(?=", "(?!", "(?<=", "(?<!"), i):
            raise UnsupportedPattern("không hỗ trợ lookahead/lookbehind")
        if p.startswith("(?:", i):
            self._i += 3
            prefix = "(?:"
        elif p.startswith("(?<", i):
            m = _GROUP_NAME.match(p, i + 3)
            if m is None or not p.startswith(">", m.end()):
                raise UnsupportedPattern("tên nhóm phải là định danh ASCII")
            if m.group() in self._names:
                raise UnsupportedPattern("tên nhóm trùng")
            self._names.add(m.group())
            self._i = m.end() + 1
            prefix = "("
        elif p.startswith("(?", i):
            raise UnsupportedPattern("không hỗ trợ cờ nội tuyến")
        else:
            self._i += 1
            prefix = "("
        inner = self._disjunction()
        if self._peek() != ")":
            raise InvalidPattern("thiếu )")
        self._i += 1
        return f"{prefix}{inner})"

    def _atom_escape(self) -> str:
        nxt = self._peek(1)
        if nxt == "":
            raise InvalidPattern("\\ ở cuối pattern")
        if nxt in "123456789k":
            raise UnsupportedPattern("không hỗ trợ backreference")
        if nxt in ("p", "P"):
            raise UnsupportedPattern("không hỗ trợ \\p{…}")
        if nxt in _OUTSIDE:
            self._i += 2
            return _OUTSIDE[nxt]
        return _esc(self._character_escape(in_class=False))

    def _character_escape(self, *, in_class: bool) -> int:
        """Code point của một CharacterEscape (con trỏ ở ``\\``)."""
        nxt = self._peek(1)
        if nxt in _CONTROL:
            self._i += 2
            return _CONTROL[nxt]
        if nxt == "c":
            letter = self._peek(2)
            if not (letter.isascii() and letter.isalpha()):
                raise InvalidPattern("\\c cần một chữ cái ASCII")
            self._i += 3
            return ord(letter) % 32
        if nxt == "0":
            if self._peek(2).isascii() and self._peek(2).isdigit():
                raise InvalidPattern("\\0 theo sau là chữ số")
            self._i += 2
            return 0
        if nxt == "x":
            digits = self._p[self._i + 2 : self._i + 4]
            if not _HEX2.fullmatch(digits):
                raise InvalidPattern("\\x cần hai chữ số hex")
            self._i += 4
            return int(digits, 16)
        if nxt == "u":
            return self._unicode_escape()
        if nxt in _SYNTAX or (in_class and nxt == "-"):
            self._i += 2
            return ord(nxt)
        raise InvalidPattern(f"\\{nxt} không hợp lệ với cờ u")

    def _unicode_escape(self) -> int:
        """``\\u{…}`` hoặc ``\\uHHHH`` — cặp thay thế viết thành hai escape là MỘT code point."""
        p, i = self._p, self._i
        if self._peek(2) == "{":
            end = p.find("}", i + 3)
            digits = p[i + 3 : end] if end > 0 else ""
            if not _HEX.fullmatch(digits) or int(digits, 16) > 0x10FFFF:
                raise InvalidPattern("\\u{…} không phải code point")
            self._i = end + 1
            return int(digits, 16)
        digits = p[i + 2 : i + 6]
        if not _HEX4.fullmatch(digits):
            raise InvalidPattern("\\u cần bốn chữ số hex")
        self._i += 6
        high = int(digits, 16)
        if 0xD800 <= high <= 0xDBFF and p.startswith("\\u", self._i):
            low_digits = p[self._i + 2 : self._i + 6]
            if _HEX4.fullmatch(low_digits) and 0xDC00 <= int(low_digits, 16) <= 0xDFFF:
                self._i += 6
                return 0x10000 + ((high - 0xD800) << 10) + (int(low_digits, 16) - 0xDC00)
        return high

    def _class(self) -> str:
        self._i += 1
        negated = self._peek() == "^"
        if negated:
            self._i += 1
        if self._peek() == "]":
            self._i += 1
            return "(?s:.)" if negated else "(?!)"
        items: list[str] = []
        not_space = False
        while self._peek() != "]":
            if self._peek() == "":
                raise InvalidPattern("lớp ký tự thiếu ]")
            atom, cp = self._class_atom()
            if self._peek() == "-" and self._peek(1) not in ("", "]"):
                self._i += 1
                atom2, cp2 = self._class_atom()
                if cp is None or cp2 is None:
                    raise InvalidPattern("khoảng với lớp ký tự")
                if cp > cp2:
                    raise InvalidPattern("khoảng ngược")
                items.append(f"{atom}-{atom2}")
            elif atom == _NOT_SPACE:
                not_space = True
            else:
                items.append(atom)
        self._i += 1
        inner = "".join(items)
        if not not_space:
            return f"[{'^' if negated else ''}{inner}]"
        # `\S` trong lớp: ECMAScript lấy HỢP với phần còn lại — `re` không có phủ định lồng
        if not negated:
            return f"(?:[{inner}]|{_NOT_SPACE})" if inner else _NOT_SPACE
        return f"(?:(?![{inner}]){_SPACE})" if inner else _SPACE

    def _class_atom(self) -> tuple[str, int | None]:
        """(mảnh ``re``, code point) — code point ``None`` khi là một lớp (``\\d``…)."""
        c = self._peek()
        if c != "\\":
            self._i += 1
            return _esc(ord(c)), ord(c)
        nxt = self._peek(1)
        if nxt == "b":
            self._i += 2
            return _esc(0x08), 0x08
        if nxt == "S":
            self._i += 2
            return _NOT_SPACE, None
        if nxt in _INSIDE:
            self._i += 2
            return _INSIDE[nxt], None
        if nxt in ("p", "P"):
            raise UnsupportedPattern("không hỗ trợ \\p{…}")
        if nxt.isascii() and nxt.isdigit() and nxt != "0":
            raise InvalidPattern("\\số trong lớp ký tự")
        cp = self._character_escape(in_class=True)
        return _esc(cp), cp


def translate(pattern: str) -> str:
    """Kiểm theo ngữ pháp ECMAScript cờ ``u`` rồi dịch sang ``re`` cùng nghĩa."""
    return _Translator(pattern).run()


def compile_js_regex(pattern: str) -> re.Pattern[str]:
    """Biên dịch với ngữ nghĩa ECMAScript — ném ``InvalidPattern``/``UnsupportedPattern``."""
    return re.compile(translate(pattern), re.ASCII)
