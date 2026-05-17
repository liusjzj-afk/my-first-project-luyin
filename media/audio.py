"""Local audio helpers used by the current MVP media flow."""

from __future__ import annotations

from collections.abc import Iterator
from mimetypes import guess_type
from pathlib import Path
from urllib.parse import quote

from mutagen import File as MutagenFile


AUDIO_STREAM_CHUNK_SIZE = 1024 * 1024


def parse_byte_range(range_header: str, file_size: int) -> tuple[int, int]:
    if file_size <= 0 or not range_header.startswith("bytes="):
        raise ValueError("Range 请求无效")

    raw_range = range_header.removeprefix("bytes=").split(",", 1)[0].strip()
    if "-" not in raw_range:
        raise ValueError("Range 请求无效")

    start_text, end_text = raw_range.split("-", 1)
    try:
        if not start_text:
            suffix_length = int(end_text)
            if suffix_length <= 0:
                raise ValueError
            start = max(file_size - suffix_length, 0)
            end = file_size - 1
        else:
            start = int(start_text)
            end = int(end_text) if end_text else file_size - 1
    except ValueError as exc:
        raise ValueError("Range 请求无效") from exc

    if start < 0 or start >= file_size or end < start:
        raise ValueError("Range 超出音频文件范围")

    return start, min(end, file_size - 1)


def content_disposition_header(filename: str) -> str:
    suffix = Path(filename).suffix
    fallback_name = f"meeting-audio{suffix}" if suffix.isascii() else "meeting-audio"
    encoded_name = quote(filename, safe="")
    return f"inline; filename=\"{fallback_name}\"; filename*=UTF-8''{encoded_name}"


def iter_file_range(audio_path: Path, start: int, end: int) -> Iterator[bytes]:
    with audio_path.open("rb") as audio_file:
        audio_file.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = audio_file.read(min(AUDIO_STREAM_CHUNK_SIZE, remaining))
            if not chunk:
                break
            remaining -= len(chunk)
            yield chunk


def media_type_for_path(audio_path: Path) -> str:
    return guess_type(audio_path.name)[0] or "application/octet-stream"


def get_audio_duration_seconds(audio_path: Path) -> int:
    """Read local audio duration with mutagen; return 0 when unavailable."""

    try:
        audio = MutagenFile(str(audio_path))
        if audio and audio.info and audio.info.length:
            return max(1, int(round(float(audio.info.length))))
    except Exception:
        return 0
    return 0
