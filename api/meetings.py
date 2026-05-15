"""会议上传、ASR 轮询、需求纪要和 Agent 对话 API。"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile, status
from sqlalchemy.orm import Session

from config import get_settings
from models import ASRStatus, ChatHistory, ChatRole, Meeting, SessionLocal
from schemas import ChatRequest, ChatResponse, MeetingStatusResponse, UploadMeetingResponse
from services.asr_service import ASRServiceError, AliyunASRService
from services.llm_service import LLMService, LLMServiceError


router = APIRouter(prefix="/api/meetings", tags=["meetings"])

ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a"}


def get_db():
    """FastAPI 数据库会话依赖。"""

    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.post("/upload", response_model=UploadMeetingResponse)
def upload_meeting_audio(
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
) -> UploadMeetingResponse:
    """上传音频，保存本地文件，提交阿里云 ASR 任务并创建会议记录。"""

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="仅支持 .mp3、.wav、.m4a 音频文件",
        )

    settings = get_settings()
    meeting_id = str(uuid.uuid4())
    safe_filename = Path(file.filename or f"meeting{suffix}").name
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    audio_path = (settings.upload_dir / f"{meeting_id}_{safe_filename}").resolve()

    try:
        with audio_path.open("wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
    finally:
        file.file.close()

    if audio_path.stat().st_size > settings.max_upload_size_mb * 1024 * 1024:
        audio_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"音频文件不能超过 {settings.max_upload_size_mb} MB",
        )

    try:
        asr_service = AliyunASRService()
        audio_url = asr_service.upload_audio_to_oss(
            str(audio_path),
            object_key=f"systemreq-copilot/{meeting_id}/{safe_filename}",
        )
        task_id = asr_service.submit_task(audio_url, enable_diarization=True)
    except ASRServiceError as exc:
        audio_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=str(exc),
        ) from exc

    meeting = Meeting(
        id=meeting_id,
        title=safe_filename,
        audio_file_path=str(audio_path),
        asr_task_id=task_id,
        asr_status=ASRStatus.PROCESSING,
    )
    db.add(meeting)
    db.commit()

    return UploadMeetingResponse(meeting_id=meeting_id, status="processing")


@router.get("/{meeting_id}/status", response_model=MeetingStatusResponse)
def get_meeting_status(
    meeting_id: str,
    db: Session = Depends(get_db),
) -> MeetingStatusResponse:
    """查询会议处理状态；ASR 成功后自动生成需求纪要。"""

    meeting = _get_meeting_or_404(db, meeting_id)

    if meeting.asr_status == ASRStatus.PROCESSING and meeting.asr_task_id:
        try:
            asr_service = AliyunASRService()
            result = asr_service.get_task_result(meeting.asr_task_id)
            task_status = _extract_task_status(result)

            if task_status == "COMPLETED":
                transcript = asr_service.normalize_transcript(result)
                meeting.transcript_json = transcript
                meeting.summary_markdown = _generate_summary_safely(transcript)
                meeting.asr_status = ASRStatus.COMPLETED
                db.commit()
                db.refresh(meeting)
            elif task_status == "FAILED":
                meeting.asr_status = ASRStatus.FAILED
                db.commit()
                db.refresh(meeting)
                return _status_response(
                    meeting,
                    error=str(result.get("StatusText") or result.get("StatusCode") or "ASR 任务失败"),
                )
        except (ASRServiceError, LLMServiceError) as exc:
            meeting.asr_status = ASRStatus.FAILED
            db.commit()
            db.refresh(meeting)
            return _status_response(meeting, error=str(exc))

    return _status_response(meeting)


@router.post("/{meeting_id}/chat", response_model=ChatResponse)
def chat_with_meeting_agent(
    meeting_id: str,
    payload: ChatRequest,
    db: Session = Depends(get_db),
) -> ChatResponse:
    """基于会议逐字稿和纪要进行连续问答。"""

    meeting = _get_meeting_or_404(db, meeting_id)
    if meeting.asr_status != ASRStatus.COMPLETED or not meeting.transcript_json:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="会议尚未完成识别和需求提取，请稍后再问",
        )

    recent_messages = (
        db.query(ChatHistory)
        .filter(ChatHistory.meeting_id == meeting_id)
        .order_by(ChatHistory.created_at.desc(), ChatHistory.id.desc())
        .limit(10)
        .all()
    )
    history = [
        {"role": item.role.value, "content": item.content}
        for item in reversed(recent_messages)
    ]

    try:
        llm_service = LLMService()
        reply = llm_service.answer_meeting_question(
            transcript=meeting.transcript_json,
            summary_markdown=meeting.summary_markdown,
            history=history,
            user_message=payload.message,
        )
    except LLMServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    db.add_all(
        [
            ChatHistory(meeting_id=meeting_id, role=ChatRole.USER, content=payload.message),
            ChatHistory(meeting_id=meeting_id, role=ChatRole.ASSISTANT, content=reply),
        ]
    )
    db.commit()

    return ChatResponse(reply=reply)


def _get_meeting_or_404(db: Session, meeting_id: str) -> Meeting:
    meeting = db.get(Meeting, meeting_id)
    if not meeting:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会议不存在")
    return meeting


def _extract_task_status(result: dict[str, Any]) -> str:
    """
    将阿里云任务状态映射为本系统状态。

    不同版本响应字段略有差异，这里兼容 TaskStatus、StatusText 以及常见状态值。
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


def _generate_summary_safely(transcript: list[dict[str, Any]]) -> str:
    """ASR 完成后立即触发 LLM 总结。"""

    llm_service = LLMService()
    return llm_service.summarize_requirements(transcript)


def _status_response(meeting: Meeting, error: str | None = None) -> MeetingStatusResponse:
    return MeetingStatusResponse(
        meeting_id=meeting.id,
        status=meeting.asr_status.value,
        title=meeting.title,
        transcript=meeting.transcript_json,
        summary_markdown=meeting.summary_markdown,
        error=error,
    )
