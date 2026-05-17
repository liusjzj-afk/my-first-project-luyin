from __future__ import annotations

import pytest

from media.audio import content_disposition_header, parse_byte_range


def test_parse_byte_range_with_explicit_end() -> None:
    assert parse_byte_range("bytes=10-19", 100) == (10, 19)


def test_parse_byte_range_with_open_end() -> None:
    assert parse_byte_range("bytes=90-", 100) == (90, 99)


def test_parse_byte_range_with_suffix_length() -> None:
    assert parse_byte_range("bytes=-12", 100) == (88, 99)


def test_parse_byte_range_rejects_out_of_bounds() -> None:
    with pytest.raises(ValueError, match="Range 超出音频文件范围"):
        parse_byte_range("bytes=100-101", 100)


def test_content_disposition_header_uses_ascii_fallback_for_chinese_filename() -> None:
    header = content_disposition_header("项目会议角色与讨论重点.m4a")

    assert 'filename="meeting-audio.m4a"' in header
    assert "filename*=UTF-8''" in header
    assert "%E9%A1%B9" in header
