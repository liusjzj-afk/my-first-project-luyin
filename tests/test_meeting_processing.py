from __future__ import annotations

from services.meeting_processing import (
    extract_duration_seconds,
    extract_task_status,
    generate_failure_summary,
)


def test_extract_task_status_requires_result_for_success() -> None:
    assert extract_task_status({"StatusText": "SUCCESS"}) == "PROCESSING"
    assert extract_task_status({"StatusText": "SUCCESS", "Result": "{}"}) == "COMPLETED"


def test_extract_task_status_handles_failure_aliases() -> None:
    assert extract_task_status({"TaskStatus": "FAILED"}) == "FAILED"
    assert extract_task_status({"StatusText": "SUCCESS_WITH_NO_VALID_FRAGMENT"}) == "FAILED"


def test_extract_duration_prefers_response_duration_seconds() -> None:
    assert extract_duration_seconds({"Duration": "120"}, []) == 120


def test_extract_duration_converts_large_millisecond_duration() -> None:
    assert extract_duration_seconds({"BizDuration": "125000"}, []) == 125


def test_extract_duration_falls_back_to_transcript_end_time() -> None:
    transcript = [
        {"start_time": 0, "end_time": 1200},
        {"start_time": 1200, "end_time": 61100},
    ]

    assert extract_duration_seconds({}, transcript) == 62


def test_generate_failure_summary_keeps_transcript_retry_guidance() -> None:
    summary = generate_failure_summary("LLM quota exceeded")

    assert "需求纪要生成失败" in summary
    assert "LLM quota exceeded" in summary
    assert "逐字稿已保存" in summary
