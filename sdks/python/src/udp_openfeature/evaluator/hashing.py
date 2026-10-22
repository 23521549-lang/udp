"""Chia nhóm bằng consistent hashing (§6.4) — cùng bucket với ``bucketOf`` của lõi Node.

MurmurHash3 x86 32-bit, hạt 0, trên BYTE UTF-8 của chuỗi đã chuẩn hoá NFC. Lõi Node vá thư
viện ``murmurhash3js`` (vốn cắt mỗi đơn vị UTF-16 còn byte thấp) để khớp đúng murmur3 chuẩn trên
UTF-8 — chính để SDK ngôn ngữ khác ra cùng bucket (I26). Hàm dưới đây là murmur3 chuẩn đó.
"""

from __future__ import annotations

import re
import unicodedata

TOTAL_BUCKETS = 100_000

# Ký tự thay thế UTF-16 đơn lẻ — viết bằng escape của `re`, không phải ký tự thật trong mã nguồn
_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")

_C1 = 0xCC9E2D51
_C2 = 0x1B873593
_MASK = 0xFFFFFFFF


def _rotl(x: int, r: int) -> int:
    return ((x << r) | (x >> (32 - r))) & _MASK


def murmur3_32(data: bytes, seed: int = 0) -> int:
    """MurmurHash3 x86 32-bit — số không dấu."""
    h = seed & _MASK
    length = len(data)
    rounded = length & ~3
    for i in range(0, rounded, 4):
        k = data[i] | (data[i + 1] << 8) | (data[i + 2] << 16) | (data[i + 3] << 24)
        k = (k * _C1) & _MASK
        k = _rotl(k, 15)
        k = (k * _C2) & _MASK
        h ^= k
        h = _rotl(h, 13)
        h = (h * 5 + 0xE6546B64) & _MASK
    k = 0
    tail = length & 3
    if tail == 3:
        k ^= data[rounded + 2] << 16
    if tail >= 2:
        k ^= data[rounded + 1] << 8
    if tail >= 1:
        k ^= data[rounded]
        k = (k * _C1) & _MASK
        k = _rotl(k, 15)
        k = (k * _C2) & _MASK
        h ^= k
    h ^= length
    h ^= h >> 16
    h = (h * 0x85EBCA6B) & _MASK
    h ^= h >> 13
    h = (h * 0xC2B2AE35) & _MASK
    h ^= h >> 16
    return h


def bucket_of(sticky_value: str, flag_key: str, bucket_salt: str) -> int:
    """Bucket trong ``[0, TOTAL_BUCKETS)`` — khoá ``salt:flagKey:sticky`` như bản Node."""
    key = unicodedata.normalize("NFC", f"{bucket_salt}:{flag_key}:{sticky_value}")
    # `Buffer.from(…, "utf8")` của Node thay ký tự thay thế đơn lẻ bằng U+FFFD — làm y hệt
    key = _LONE_SURROGATE.sub("\N{REPLACEMENT CHARACTER}", key)
    return murmur3_32(key.encode("utf-8")) % TOTAL_BUCKETS
