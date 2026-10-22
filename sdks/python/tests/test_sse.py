"""Parser SSE theo WHATWG — cùng các ca của ``sse.test.ts`` (Node)."""

from __future__ import annotations

import time

import pytest

from udp_openfeature.sse import SseActivity, SseEvent, SseItem, SseLineTooLong, SseParser, SseRetry

BOM = chr(0xFEFF)


def events(items: list[SseItem]) -> list[SseEvent]:
    return [i for i in items if isinstance(i, SseEvent)]


def test_id_event_data_nhieu_dong_dong_trong_ket_thuc_su_kien() -> None:
    out = SseParser().feed('id: 7\nevent: snapshot\ndata: {"a":1}\ndata: x\n\n')
    assert events(out) == [SseEvent("snapshot", '{"a":1}\nx', "7")]


def test_crlf_va_cr_deu_la_xuong_dong_ke_ca_crlf_cat_doi() -> None:
    p = SseParser()
    assert events(p.feed("data: a\r")) == []
    out = p.feed("\n\r\ndata: b\r\r")
    assert [e.data for e in events(out)] == ["a", "b"]


def test_chu_thich_la_dau_hieu_song_retry_duoc_doc() -> None:
    p = SseParser()
    assert p.feed(":\n\n") == [SseActivity()]
    assert p.feed("retry: 3000\n\n") == [SseRetry(3000)]
    assert p.feed("retry: 3s\n\n") == [SseActivity()]


def test_bom_dau_stream_bi_bo_su_kien_khong_data_khong_phat() -> None:
    out = SseParser().feed(f"{BOM}event: x\n\ndata: y\n\n")
    assert events(out) == [SseEvent("message", "y", None)]


def test_du_lieu_toi_tung_ky_tu_van_ra_dung_mot_su_kien() -> None:
    p = SseParser()
    got: list[SseItem] = []
    for ch in "event: flag_changed\ndata: 1\n\n":
        got.extend(p.feed(ch))
    assert len(events(got)) == 1


def test_manh_rong_giua_cr_va_lf_khong_tach_su_kien() -> None:
    p = SseParser()
    got = [*p.feed("data: a\r"), *p.feed(""), *p.feed("\ndata: b\r\n\r\n")]
    assert [e.data for e in events(got)] == ["a\nb"]


def test_manh_rong_dau_stream_khong_tieu_cho_cua_bom() -> None:
    p = SseParser()
    p.feed("")
    assert events(p.feed(f"{BOM}event: snapshot\ndata: x\n\n")) == [SseEvent("snapshot", "x", None)]


def test_dong_rat_dai_theo_nhieu_manh_la_tuyen_tinh() -> None:
    p = SseParser()
    piece = "x" * (64 * 1024)
    started = time.monotonic()
    p.feed("data: ")
    for _ in range(128):  # 8 MiB
        p.feed(piece)
    out = p.feed("\n\n")
    assert time.monotonic() - started < 2.0
    assert len(events(out)[0].data) == 8 * 1024 * 1024


def test_dong_tung_ky_tu_cung_tuyen_tinh() -> None:
    p = SseParser()
    started = time.monotonic()
    p.feed("data: ")
    for _ in range(200_000):
        p.feed("y")
    out = p.feed("\n\n")
    assert time.monotonic() - started < 3.0
    assert len(events(out)[0].data) == 200_000


def test_dong_vuot_tran_thi_nem() -> None:
    p = SseParser(16)
    p.feed("data: 0123456789")
    with pytest.raises(SseLineTooLong):
        p.feed("abcdef")


def test_id_chua_nul_bi_bo_qua() -> None:
    out = SseParser().feed("id: 1\ndata: a\n\nid: x\x00y\ndata: b\n\n")
    assert [e.id for e in events(out)] == ["1", "1"]
