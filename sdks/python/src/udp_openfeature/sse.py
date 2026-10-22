"""Parser Server-Sent Events theo WHATWG (HTML §9.2) — bản Python của ``sse.ts`` (§6.8).

Đẩy từng mảnh chữ vào (``feed``), nhận lại từng sự kiện đã hoàn chỉnh. Dòng kết thúc bằng CRLF,
CR hoặc LF (kể cả CRLF bị cắt đôi giữa hai mảnh); BOM đầu stream bị bỏ; dòng bắt đầu bằng ``:``
là chú thích (nhịp tim của Service 2) — không thành sự kiện nhưng vẫn là dấu hiệu SỐNG.
Tuyến tính theo độ dài dòng: snapshot là MỘT dòng, quét hay nối lại từ đầu là O(n²).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .constants import PROVIDER

_DIGITS = re.compile(r"[0-9]+")
_NEWLINE = re.compile(r"\r\n|\r|\n")
_BOM = chr(0xFEFF)


@dataclass(frozen=True)
class SseEvent:
    event: str
    data: str
    id: str | None


@dataclass(frozen=True)
class SseRetry:
    ms: int


@dataclass(frozen=True)
class SseActivity:
    """Có byte tới nhưng không thành sự kiện (nhịp tim, dòng trống lẻ)."""


SseItem = SseEvent | SseRetry | SseActivity


class SseLineTooLong(ValueError):
    """Một dòng dài hơn trần — stream hỏng; nơi gọi huỷ kết nối và đếm một lần hỏng."""


class SseParser:
    def __init__(self, max_line_chars: int = PROVIDER["maxSseLineChars"]) -> None:
        self._max_line_chars = max_line_chars
        # Phần dòng dở giữ theo MẢNH, chỉ nối khi gặp xuống dòng — nối chuỗi mỗi lần `feed` là
        # O(n²) ở Python, mà snapshot là MỘT dòng tới theo nhiều mảnh
        self._parts: list[str] = []
        self._pending_len = 0
        self._first = True
        self._pending_cr = False
        self._event = ""
        self._data: list[str] = []
        self._id: str | None = None

    def feed(self, chunk: str) -> list[SseItem]:
        # Mảnh rỗng không mang byte nào: không được tiêu CR đang chờ hay chỗ của BOM
        if chunk == "":
            return []
        out: list[SseItem] = []
        text = chunk
        if self._first:
            self._first = False
            if text.startswith(_BOM):
                text = text[1:]
        # CR ở cuối mảnh trước + LF đầu mảnh này là MỘT xuống dòng
        if self._pending_cr and text.startswith("\n"):
            text = text[1:]
        self._pending_cr = False
        start = 0
        n = len(text)
        for match in _NEWLINE.finditer(text):
            head = "".join(self._parts) if self._parts else ""
            self._line(head + text[start : match.start()], out)
            self._parts = []
            self._pending_len = 0
            if match.group() == "\r" and match.end() == n:
                self._pending_cr = True
            start = match.end()
        if start < n:
            self._parts.append(text[start:])
            self._pending_len += n - start
        if self._pending_len > self._max_line_chars:
            raise SseLineTooLong(f"dòng SSE dài hơn {self._max_line_chars} ký tự — stream hỏng")
        if not out:
            out.append(SseActivity())
        return out

    def _dispatch(self, out: list[SseItem]) -> None:
        if not self._data:
            self._event = ""
            return
        out.append(SseEvent(self._event or "message", "\n".join(self._data), self._id))
        self._event = ""
        self._data = []

    def _line(self, text: str, out: list[SseItem]) -> None:
        if text == "":
            self._dispatch(out)
            return
        if text.startswith(":"):
            return
        field, sep, value = text.partition(":")
        if sep and value.startswith(" "):
            value = value[1:]
        if field == "event":
            self._event = value
        elif field == "data":
            self._data.append(value)
        elif field == "id":
            if "\x00" not in value:
                self._id = value
        elif field == "retry" and _DIGITS.fullmatch(value):
            out.append(SseRetry(int(value)))
