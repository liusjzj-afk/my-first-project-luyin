"""会议上传、ASR 轮询、需求纪要和 Agent 对话 API。"""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path

from fastapi import APIRouter, Depends, File, Header, HTTPException, Query, UploadFile, status
from fastapi.responses import FileResponse, Response, StreamingResponse
from sqlalchemy.orm import Session

from auth import RequestContext, get_request_context
from config import get_settings
from media.audio import (
    content_disposition_header,
    get_audio_duration_seconds,
    iter_file_range,
    media_type_for_path,
    parse_byte_range,
)
from models import ASRStatus, ChatHistory, ChatRole, LLMStatus, Meeting, SessionLocal, utc_now
from repositories.meetings import get_meeting_for_context, query_meetings_for_context
from schemas import (
    ActionResponse,
    ChatRequest,
    ChatResponse,
    MeetingListItem,
    MeetingStatsResponse,
    MeetingStatusResponse,
    RetrySummaryResponse,
    UploadMeetingResponse,
)
from services.asr_service import ASRServiceError, AliyunASRService
from services.events import subscribe_meeting_events
from services.llm_service import LLMService, LLMServiceError, strip_model_thinking
from services.meeting_processing import (
    enqueue_meeting_processing,
    enqueue_summary_retry,
    estimate_eta_seconds,
    overall_status,
    progress_percent,
)
from services.object_storage import ObjectStorageService


router = APIRouter(prefix="/api/meetings", tags=["meetings"])

ALLOWED_AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".mp4", ".aac", ".opus"}


def get_db():
    """FastAPI 数据库会话依赖。"""

    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@router.get("", response_model=list[MeetingListItem])
def list_meetings(
    trash: bool = Query(default=False),
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> list[MeetingListItem]:
    """返回我的内容或回收站列表。"""

    query = query_meetings_for_context(db, context)
    if trash:
        query = query.filter(Meeting.deleted_at.is_not(None))
    else:
        query = query.filter(Meeting.deleted_at.is_(None))

    meetings = query.order_by(Meeting.upload_time.desc()).all()
    return [_meeting_list_item(meeting) for meeting in meetings]


@router.get("/stats", response_model=MeetingStatsResponse)
def get_meeting_stats(
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> MeetingStatsResponse:
    """返回列表页需要的已用分钟和记录统计。"""

    active_meetings = query_meetings_for_context(db, context).filter(Meeting.deleted_at.is_(None)).all()
    trash_count = query_meetings_for_context(db, context).filter(Meeting.deleted_at.is_not(None)).count()
    used_seconds = sum(max(0, meeting.audio_duration or meeting.duration_seconds or 0) for meeting in active_meetings)
    return MeetingStatsResponse(
        used_minutes=(used_seconds + 59) // 60,
        meeting_count=len(active_meetings),
        processing_count=sum(
            1
            for meeting in active_meetings
            if meeting.asr_status == ASRStatus.PROCESSING
            or (meeting.asr_status == ASRStatus.COMPLETED and meeting.llm_status in {LLMStatus.PENDING, LLMStatus.PROCESSING})
        ),
        trash_count=trash_count,
    )


@router.post("/upload", response_model=UploadMeetingResponse)
def upload_meeting_audio(
    file: UploadFile = File(...),
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> UploadMeetingResponse:
    """上传音频，保存本地文件，提交阿里云 ASR 任务并创建会议记录。"""

    settings = get_settings()
    if not settings.allow_legacy_upload:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="后端直传上传已禁用，请使用 OSS 直传上传",
        )

    suffix = Path(file.filename or "").suffix.lower()
    if suffix not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="仅支持 .mp3、.wav、.m4a、.mp4、.aac、.opus 音频文件",
        )

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

    audio_duration = get_audio_duration_seconds(audio_path)

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
        tenant_id=context.tenant_id,
        user_id=context.user_id,
        title=safe_filename,
        audio_file_path=str(audio_path),
        media_object_key=f"systemreq-copilot/{meeting_id}/{safe_filename}",
        media_size_bytes=audio_path.stat().st_size,
        media_content_type=file.content_type,
        asr_task_id=task_id,
        asr_status=ASRStatus.PROCESSING,
        llm_status=LLMStatus.PENDING,
        audio_duration=audio_duration,
        duration_seconds=audio_duration,
    )
    db.add(meeting)
    db.commit()
    enqueue_meeting_processing(meeting_id)

    return UploadMeetingResponse(meeting_id=meeting_id, status="processing")


@router.get("/{meeting_id}/status", response_model=MeetingStatusResponse)
def get_meeting_status(
    meeting_id: str,
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> MeetingStatusResponse:
    """查询会议处理状态。该 GET 接口必须保持只读，不触发外部 API 调用。"""

    meeting = _get_meeting_or_404(db, meeting_id, context)
    return _status_response(meeting)


@router.get("/{meeting_id}/stream-events")
def stream_meeting_events(
    meeting_id: str,
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> StreamingResponse:
    """SSE stream for meeting status updates."""

    _get_meeting_or_404(db, meeting_id, context)
    return StreamingResponse(
        subscribe_meeting_events(meeting_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        },
    )


@router.get("/{meeting_id}/audio")
def get_meeting_audio(
    meeting_id: str,
    range_header: str | None = Header(default=None, alias="Range"),
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> Response:
    """返回会议本地录音文件，供详情页播放器使用。"""

    meeting = _get_meeting_or_404(db, meeting_id, context)
    settings = get_settings()
    if meeting.media_object_key:
        try:
            return Response(
                status_code=status.HTTP_307_TEMPORARY_REDIRECT,
                headers={"Location": ObjectStorageService().signed_get_url(meeting.media_object_key)},
            )
        except ASRServiceError as exc:
            if not settings.allow_local_audio_stream or not meeting.audio_file_path:
                raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    if not settings.allow_local_audio_stream:
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="本地录音流已禁用，请使用签名播放地址",
        )

    audio_path = Path(meeting.audio_file_path)
    if not audio_path.exists() or not audio_path.is_file():
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="录音文件不存在")

    media_type = media_type_for_path(audio_path)
    file_size = audio_path.stat().st_size
    base_headers = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": content_disposition_header(audio_path.name),
    }

    if range_header:
        try:
            start, end = parse_byte_range(range_header, file_size)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_416_REQUESTED_RANGE_NOT_SATISFIABLE,
                detail=str(exc),
                headers={
                    "Accept-Ranges": "bytes",
                    "Content-Range": f"bytes */{file_size}",
                },
            ) from exc

        content_length = end - start + 1
        return StreamingResponse(
            iter_file_range(audio_path, start, end),
            status_code=status.HTTP_206_PARTIAL_CONTENT,
            media_type=media_type,
            headers={
                **base_headers,
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Content-Length": str(content_length),
            },
        )

    return FileResponse(
        path=audio_path,
        media_type=media_type,
        headers=base_headers,
    )


@router.delete("/{meeting_id}", response_model=ActionResponse)
def delete_meeting(
    meeting_id: str,
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> ActionResponse:
    """软删除会议，移入回收站。"""

    meeting = _get_meeting_or_404(db, meeting_id, context)
    meeting.deleted_at = utc_now()
    db.commit()
    return ActionResponse(ok=True)


@router.post("/{meeting_id}/restore", response_model=ActionResponse)
def restore_meeting(
    meeting_id: str,
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> ActionResponse:
    """从回收站恢复会议。"""

    meeting = _get_meeting_or_404(db, meeting_id, context)
    meeting.deleted_at = None
    db.commit()
    return ActionResponse(ok=True)


@router.delete("/{meeting_id}/purge", response_model=ActionResponse)
def purge_meeting(
    meeting_id: str,
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> ActionResponse:
    """永久删除会议记录和本地音频文件。"""

    meeting = _get_meeting_or_404(db, meeting_id, context)
    audio_file_path = meeting.audio_file_path
    db.delete(meeting)
    db.commit()

    if audio_file_path:
        Path(audio_file_path).unlink(missing_ok=True)

    return ActionResponse(ok=True)


@router.post("/{meeting_id}/chat", response_model=ChatResponse)
def chat_with_meeting_agent(
    meeting_id: str,
    payload: ChatRequest,
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> ChatResponse:
    """基于会议逐字稿和纪要进行连续问答。"""

    meeting = _get_meeting_or_404(db, meeting_id, context)
    if meeting.asr_status != ASRStatus.COMPLETED or not meeting.transcript_json:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="会议尚未完成识别和需求提取，请稍后再问",
        )

    recent_messages = (
        db.query(ChatHistory)
        .filter(
            ChatHistory.meeting_id == meeting_id,
            ChatHistory.tenant_id == context.tenant_id,
            ChatHistory.user_id == context.user_id,
        )
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
            summary_markdown=strip_model_thinking(
                meeting.summary_content or meeting.summary_markdown or ""
            ),
            history=history,
            user_message=payload.message,
        )
    except LLMServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    db.add_all(
        [
            ChatHistory(meeting_id=meeting_id, tenant_id=context.tenant_id, user_id=context.user_id, role=ChatRole.USER, content=payload.message),
            ChatHistory(meeting_id=meeting_id, tenant_id=context.tenant_id, user_id=context.user_id, role=ChatRole.ASSISTANT, content=reply),
        ]
    )
    db.commit()

    return ChatResponse(reply=reply)


@router.post("/{meeting_id}/retry-summary", response_model=RetrySummaryResponse)
def retry_summary(
    meeting_id: str,
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> RetrySummaryResponse:
    """Retry LLM summary only, reusing the existing ASR transcript."""

    meeting = _get_meeting_or_404(db, meeting_id, context)
    if meeting.asr_status != ASRStatus.COMPLETED or not meeting.transcript_json:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="ASR 未完成，不能单独重试需求纪要",
        )
    if meeting.llm_status not in {LLMStatus.FAILED, LLMStatus.COMPLETED}:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="需求纪要正在处理中，请勿重复触发",
        )

    meeting.llm_status = LLMStatus.PENDING
    meeting.llm_error = None
    meeting.summary_content = None
    meeting.ia_content = None
    meeting.summary_markdown = None
    db.commit()
    enqueue_summary_retry(meeting.id)
    return RetrySummaryResponse(ok=True, llm_status=meeting.llm_status.value)


def _get_meeting_or_404(db: Session, meeting_id: str, context: RequestContext) -> Meeting:
    meeting = get_meeting_for_context(db, meeting_id, context)
    if not meeting:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="会议不存在")
    return meeting


def _status_response(meeting: Meeting, error: str | None = None) -> MeetingStatusResponse:
    return MeetingStatusResponse(
        meeting_id=meeting.id,
        status=overall_status(meeting),
        asr_status=meeting.asr_status.value,
        llm_status=meeting.llm_status.value,
        title=meeting.title,
        upload_time=meeting.upload_time,
        duration_seconds=meeting.duration_seconds or 0,
        audio_duration=meeting.audio_duration or meeting.duration_seconds or 0,
        eta_seconds=estimate_eta_seconds(meeting),
        progress_percent=progress_percent(meeting),
        audio_url=_audio_url(meeting),
        transcript=meeting.transcript_json,
        summary_markdown=strip_model_thinking(meeting.summary_markdown or "") or None,
        summary_content=strip_model_thinking(
            meeting.summary_content or meeting.summary_markdown or ""
        ) or None,
        ia_content=strip_model_thinking(meeting.ia_content or "") or None,
        error=error,
    )


def _meeting_list_item(meeting: Meeting) -> MeetingListItem:
    return MeetingListItem(
        id=meeting.id,
        title=meeting.title,
        upload_time=meeting.upload_time,
        asr_status=overall_status(meeting),
        llm_status=meeting.llm_status.value,
        duration_seconds=meeting.duration_seconds or 0,
        audio_duration=meeting.audio_duration or meeting.duration_seconds or 0,
        eta_seconds=estimate_eta_seconds(meeting),
        progress_percent=progress_percent(meeting),
        deleted_at=meeting.deleted_at,
    )


def _audio_url(meeting: Meeting) -> str | None:
    settings = get_settings()
    if meeting.media_object_key:
        try:
            return ObjectStorageService().signed_get_url(meeting.media_object_key)
        except ASRServiceError:
            if settings.allow_local_audio_stream and meeting.audio_file_path:
                return f"/api/meetings/{meeting.id}/audio"
            return None
    if meeting.audio_file_path and settings.allow_local_audio_stream:
        return f"/api/meetings/{meeting.id}/audio"
    return None
