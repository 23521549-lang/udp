"""SemVer 2.0 — cùng ``parseSemver``/``compareSemver`` của ``@udp/shared-types``.

So chữ số bằng độ dài rồi thứ tự từ điển (không đổi sang số): ``1.10.0 > 1.9.0`` và phần số rất
dài không tràn. Build metadata (``+…``) không tham gia so sánh.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_SEMVER = re.compile(
    r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
    r"(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?"
    r"(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?\Z",
    re.ASCII,
)
_NUMERIC = re.compile(r"^(0|[1-9]\d*)\Z", re.ASCII)


@dataclass(frozen=True)
class Semver:
    core: tuple[str, str, str]
    pre: tuple[str, ...]


def parse_semver(text: str) -> Semver | None:
    m = _SEMVER.match(text)
    if m is None:
        return None
    major, minor, patch, pre = m.group(1, 2, 3, 4)
    return Semver((major, minor, patch), tuple(pre.split(".")) if pre else ())


def _compare_digits(a: str, b: str) -> int:
    if len(a) != len(b):
        return -1 if len(a) < len(b) else 1
    return (a > b) - (a < b)


def _compare_identifier(a: str, b: str) -> int:
    an = _NUMERIC.match(a) is not None
    bn = _NUMERIC.match(b) is not None
    if an and bn:
        return _compare_digits(a, b)
    if an != bn:
        return -1 if an else 1
    return (a > b) - (a < b)


def compare_semver(a: Semver, b: Semver) -> int:
    for x, y in zip(a.core, b.core, strict=True):
        c = _compare_digits(x, y)
        if c != 0:
            return c
    if not a.pre or not b.pre:
        if len(a.pre) == len(b.pre):
            return 0
        return 1 if not a.pre else -1
    for x, y in zip(a.pre, b.pre, strict=False):
        c = _compare_identifier(x, y)
        if c != 0:
            return c
    if len(a.pre) == len(b.pre):
        return 0
    return -1 if len(a.pre) < len(b.pre) else 1
