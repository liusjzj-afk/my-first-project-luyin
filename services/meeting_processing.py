"""Background processing for meeting ASR polling and LLM summarization.

Phase 1 keeps this as a small in-process runner so GET endpoints stay
read-only. The public enqueue/process functions are the seam that should be
replaced by Celery tasks in the commercial architecture phase.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from datetime import datetime, timezone
from typing import Any

from sqlalchemy.orm import Session

from config import get_settings
from models import ASRStatus, LLMStatus, Meeting, SessionLocal, Summary, Transcript, UsageLog, UsageService
from services.asr_service import ASRServiceError, AliyunASRService
from services.events import publish_meeting_event
from services.llm_service import LLMService


logger = logging.getLogger(__name__)

DEFAULT_POLL_INTERVAL_SECONDS = float(os.getenv("MEETING_PROCESS_POLL_SECONDS", "8"))
DEFAULT_MAX_POLLS = int(os.getenv("MEETING_PROCESS_MAX_POLLS", "900"))

_active_meeting_ids: set[str] = set()
_active_lock = threading.Lock()


def enqueue_meeting_processing(
    meeting_id: str,
    *,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    max_polls: int = DEFAULT_MAX_POLLS,
) -> bool:
    """Start one in-process worker thread for a meeting if none is active."""

    if get_settings().enable_celery:
        from tasks.meetings import process_meeting_task

        process_meeting_task.delay(meeting_id, poll_interval_seconds, max_polls)
        return True

    with _active_lock:
        if meeting_id in _active_meeting_ids:
            return False
        _active_meeting_ids.add(meeting_id)

    thread = threading.Thread(
        target=_run_meeting_processing,
        args=(meeting_id, poll_interval_seconds, max_polls),
        name=f"meeting-processing-{meeting_id}",
        daemon=True,
    )
    thread.start()
    return True


def resume_incomplete_meetings() -> int:
    """Resume locally incomplete tasks on process startup."""

    db = SessionLocal()
    try:
        meeting_ids = [
            row[0]
            for row in db.query(Meeting.id)
            .filter(
                (Meeting.asr_status == ASRStatus.PROCESSING)
                | (Meeting.llm_status.in_([LLMStatus.PENDING, LLMStatus.PROCESSING]))
            )
            .all()
        ]
    finally:
        db.close()

    for meeting_id in meeting_ids:
        enqueue_meeting_processing(meeting_id)
    return len(meeting_ids)


def process_meeting_once(db: Session, meeting_id: str) -> bool:
    """
    Advance one meeting by at most one state transition.

    Returns True when the meeting is terminal or no further polling is needed.
    Returns False when ASR is still processing and should be checked later.
    """

    meeting = db.get(Meeting, meeting_id)
    if not meeting:
        return True

    if meeting.asr_status == ASRStatus.PROCESSING and meeting.asr_task_id:
        return _process_asr_result(db, meeting)

    if meeting.asr_status == ASRStatus.COMPLETED and meeting.llm_status in {LLMStatus.PENDING, LLMStatus.PROCESSING}:
        return _process_summary(db, meeting)

    return meeting.asr_status == ASRStatus.FAILED or (
        meeting.asr_status == ASRStatus.COMPLETED
        and meeting.llm_status in {LLMStatus.COMPLETED, LLMStatus.FAILED}
    )


def enqueue_summary_retry(meeting_id: str) -> bool:
    """Retry only the LLM summary stage using the existing transcript."""

    return enqueue_meeting_processing(meeting_id, poll_interval_seconds=0.1, max_polls=1)


def extract_task_status(result: dict[str, Any]) -> str:
    """
    Map Aliyun task responses to this system's processing status.

    Aliyun response fields vary across examples and API versions, so this
    accepts TaskStatus, TaskStatusText, and StatusText.
    """

    raw_status = str(
        result.get("TaskStatus")
        or result.get("TaskStatusText")
        or result.get("StatusText")
        or ""
    ).upper()

    if raw_status in {"SUCCESS", "SUCCEEDED", "COMPLETED"} and result.get("Result"):
        return "COMPLETED"
    if raw_status in {"FAILED", "FAILURE", "ERROR", "SUCCESS_WITH_NO_VALID_FRAGMENT"}:
        return "FAILED"
    return "PROCESSING"


def extract_duration_seconds(result: dict[str, Any], transcript: list[dict[str, Any]]) -> int:
    """Extract audio duration from ASR response or transcript timestamps."""

    raw_duration = result.get("BizDuration") or result.get("Duration") or result.get("duration")
    if raw_duration:
        try:
            duration = int(float(raw_duration))
            return max(0, duration // 1000 if duration > 24 * 60 * 60 else duration)
        except (TypeError, ValueError):
            pass

    max_end_time = 0
    for item in transcript:
        end_time = item.get("end_time") or item.get("start_time") or 0
        try:
            max_end_time = max(max_end_time, int(end_time))
        except (TypeError, ValueError):
            continue

    return max(0, (max_end_time + 999) // 1000)


def generate_failure_summary(error: BaseException | str) -> str:
    """Return the user-visible summary shown when LLM generation fails."""

    return (
        "## 需求纪要生成失败\n\n"
        f"{str(error)}\n\n"
        "逐字稿已保存，可在修复 LLM 配置或额度后重新生成。"
    )


def estimate_eta_seconds(meeting: Meeting) -> int | None:
    """Estimate remaining ASR seconds for UI display."""

    if meeting.asr_status != ASRStatus.PROCESSING:
        return None
    audio_duration = meeting.audio_duration or meeting.duration_seconds or 0
    if audio_duration <= 0:
        return None

    upload_time = meeting.upload_time
    if upload_time.tzinfo is None:
        upload_time = upload_time.replace(tzinfo=timezone.utc)
    waited_seconds = max(0, int((datetime.now(timezone.utc) - upload_time).total_seconds()))
    estimated_total = max(1, int(audio_duration * 0.3))
    return max(1, estimated_total - waited_seconds)


def progress_percent(meeting: Meeting) -> int:
    """Return approximate UI progress; this is not Aliyun's real progress."""

    if meeting.asr_status == ASRStatus.COMPLETED and meeting.llm_status == LLMStatus.COMPLETED:
        return 100
    if meeting.asr_status == ASRStatus.FAILED:
        return 100
    if meeting.asr_status == ASRStatus.COMPLETED and meeting.llm_status in {LLMStatus.PENDING, LLMStatus.PROCESSING}:
        return 92
    if meeting.asr_status == ASRStatus.PENDING:
        return 5

    audio_duration = meeting.audio_duration or meeting.duration_seconds or 0
    if audio_duration <= 0:
        return 35
    upload_time = meeting.upload_time
    if upload_time.tzinfo is None:
        upload_time = upload_time.replace(tzinfo=timezone.utc)
    waited_seconds = max(0, int((datetime.now(timezone.utc) - upload_time).total_seconds()))
    estimated_total = max(1, int(audio_duration * 0.3))
    return min(90, max(10, int(waited_seconds / estimated_total * 90)))


def overall_status(meeting: Meeting) -> str:
    """Return the legacy single status value expected by the current frontend."""

    if meeting.asr_status == ASRStatus.FAILED:
        return ASRStatus.FAILED.value
    if meeting.asr_status == ASRStatus.PROCESSING:
        return ASRStatus.PROCESSING.value
    if meeting.asr_status == ASRStatus.PENDING:
        return ASRStatus.PENDING.value
    if meeting.asr_status == ASRStatus.COMPLETED and meeting.llm_status in {LLMStatus.PENDING, LLMStatus.PROCESSING}:
        return "SUMMARIZING"
    return ASRStatus.COMPLETED.value


def _run_meeting_processing(
    meeting_id: str,
    poll_interval_seconds: float,
    max_polls: int,
) -> None:
    try:
        for _ in range(max_polls):
            db = SessionLocal()
            try:
                is_terminal = process_meeting_once(db, meeting_id)
            except Exception:
                logger.exception("Failed to process meeting %s", meeting_id)
                is_terminal = False
            finally:
                db.close()

            if is_terminal:
                return
            time.sleep(poll_interval_seconds)
    finally:
        with _active_lock:
            _active_meeting_ids.discard(meeting_id)


def _process_asr_result(db: Session, meeting: Meeting) -> bool:
    asr_service = AliyunASRService()
    try:
        result = asr_service.get_task_result(meeting.asr_task_id or "")
    except ASRServiceError:
        logger.exception("ASR polling failed for meeting %s", meeting.id)
        return False

    task_status = extract_task_status(result)
    if task_status == "PROCESSING":
        return False

    if task_status == "FAILED":
        meeting.asr_status = ASRStatus.FAILED
        meeting.llm_status = LLMStatus.FAILED
        meeting.llm_error = "ASR 失败，未触发 LLM 总结"
        detected_duration = extract_duration_seconds(result, meeting.transcript_json or [])
        meeting.duration_seconds = detected_duration or meeting.audio_duration or 0
        db.commit()
        _publish_status(meeting)
        return True

    try:
        transcript = asr_service.normalize_transcript(result)
    except ASRServiceError:
        logger.exception("ASR transcript normalization failed for meeting %s", meeting.id)
        meeting.asr_status = ASRStatus.FAILED
        db.commit()
        return True

    meeting.transcript_json = transcript
    detected_duration = extract_duration_seconds(result, transcript)
    meeting.duration_seconds = detected_duration or meeting.audio_duration or 0
    meeting.audio_duration = meeting.audio_duration or detected_duration
    meeting.asr_status = ASRStatus.COMPLETED
    meeting.llm_status = LLMStatus.PROCESSING
    db.add(
        Transcript(
            tenant_id=meeting.tenant_id,
            user_id=meeting.user_id,
            meeting_id=meeting.id,
            content_json=transcript,
        )
    )
    db.add(
        UsageLog(
            tenant_id=meeting.tenant_id,
            user_id=meeting.user_id,
            meeting_id=meeting.id,
            service=UsageService.ASR,
            provider="aliyun",
            quantity_seconds=meeting.duration_seconds or 0,
            request_id=meeting.asr_task_id,
        )
    )
    db.commit()
    db.refresh(meeting)
    _publish_status(meeting)
    return _process_summary(db, meeting)


def _process_summary(db: Session, meeting: Meeting) -> bool:
    if not meeting.transcript_json:
        return False

    if meeting.summary_content and meeting.llm_status == LLMStatus.COMPLETED:
        db.commit()
        return True

    meeting.llm_status = LLMStatus.PROCESSING
    meeting.llm_error = None
    db.commit()
    db.refresh(meeting)
    _publish_status(meeting)

    try:
        llm_service = LLMService()
        summary_sections = llm_service.summarize_requirements(
            meeting.transcript_json,
            meeting_type=meeting.meeting_type,
        )
        meeting.summary_content = summary_sections["summary_content"]
        meeting.ia_content = summary_sections["ia_content"]
        meeting.summary_markdown = summary_sections["raw_content"]
        meeting.llm_status = LLMStatus.COMPLETED
        meeting.llm_error = None
        db.add(
            Summary(
                tenant_id=meeting.tenant_id,
                user_id=meeting.user_id,
                meeting_id=meeting.id,
                status=LLMStatus.COMPLETED,
                summary_content=meeting.summary_content,
                ia_content=meeting.ia_content,
                raw_content=meeting.summary_markdown,
            )
        )
        db.add(
            UsageLog(
                tenant_id=meeting.tenant_id,
                user_id=meeting.user_id,
                meeting_id=meeting.id,
                service=UsageService.LLM,
                provider="openai-compatible",
                model=llm_service.model,
                input_tokens=int(summary_sections.get("input_tokens", "0") or 0),
                output_tokens=int(summary_sections.get("output_tokens", "0") or 0),
                total_tokens=int(summary_sections.get("total_tokens", "0") or 0),
            )
        )
    except Exception as exc:
        failure_summary = generate_failure_summary(exc)
        meeting.summary_content = failure_summary
        meeting.ia_content = ""
        meeting.summary_markdown = failure_summary
        meeting.llm_status = LLMStatus.FAILED
        meeting.llm_error = str(exc)
        db.add(
            Summary(
                tenant_id=meeting.tenant_id,
                user_id=meeting.user_id,
                meeting_id=meeting.id,
                status=LLMStatus.FAILED,
                summary_content=failure_summary,
                ia_content="",
                raw_content=failure_summary,
                error=str(exc),
            )
        )
    db.commit()
    db.refresh(meeting)
    _publish_status(meeting)
    return True


def _publish_status(meeting: Meeting) -> None:
    publish_meeting_event(
        meeting.id,
        "meeting_status",
        {
            "meeting_id": meeting.id,
            "status": overall_status(meeting),
            "asr_status": meeting.asr_status.value,
            "llm_status": meeting.llm_status.value,
            "progress_percent": progress_percent(meeting),
        },
    )
