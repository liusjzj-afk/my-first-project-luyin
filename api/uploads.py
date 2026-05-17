"""Direct-to-object-storage upload API."""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.orm import Session

from api.meetings import ALLOWED_AUDIO_EXTENSIONS, get_db
from models import ASRStatus, LLMStatus, Meeting
from repositories.meetings import RequestContext, get_request_context
from schemas import (
    PresignedUploadCompleteRequest,
    PresignedUploadCompleteResponse,
    PresignedUploadResponse,
)
from services.asr_service import ASRServiceError, AliyunASRService
from services.meeting_processing import enqueue_meeting_processing
from services.object_storage import ObjectStorageService, infer_content_type


router = APIRouter(prefix="/api/upload", tags=["upload"])


@router.get("/presigned-url", response_model=PresignedUploadResponse)
def get_presigned_upload_url(
    filename: str = Query(..., min_length=1),
    content_type: str | None = Query(default=None),
    context: RequestContext = Depends(get_request_context),
) -> PresignedUploadResponse:
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="仅支持 .mp3、.wav、.m4a、.mp4、.aac、.opus 音频文件",
        )

    try:
        signed_upload = ObjectStorageService().create_presigned_upload(
            tenant_id=context.tenant_id,
            filename=filename,
            content_type=content_type or infer_content_type(filename),
        )
    except ASRServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    return PresignedUploadResponse(
        meeting_id=signed_upload.meeting_id,
        object_key=signed_upload.object_key,
        upload_url=signed_upload.upload_url,
        expires_in=signed_upload.expires_in,
        headers=signed_upload.headers,
    )


@router.post("/complete", response_model=PresignedUploadCompleteResponse)
def complete_direct_upload(
    payload: PresignedUploadCompleteRequest,
    context: RequestContext = Depends(get_request_context),
    db: Session = Depends(get_db),
) -> PresignedUploadCompleteResponse:
    suffix = Path(payload.title or payload.object_key).suffix.lower()
    if suffix not in ALLOWED_AUDIO_EXTENSIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="仅支持 .mp3、.wav、.m4a、.mp4、.aac、.opus 音频文件",
        )

    try:
        storage = ObjectStorageService()
        audio_url = storage.signed_get_url(payload.object_key)
        task_id = AliyunASRService().submit_task(audio_url, enable_diarization=True)
    except ASRServiceError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc

    meeting_id = payload.object_key.split("/meetings/", 1)[-1].split("/", 1)[0]
    meeting = Meeting(
        id=meeting_id,
        tenant_id=context.tenant_id,
        user_id=context.user_id,
        title=Path(payload.title).name,
        meeting_type=payload.meeting_type,
        audio_file_path="",
        media_object_key=payload.object_key,
        media_bucket=storage.bucket_name,
        media_size_bytes=payload.size_bytes,
        media_content_type=payload.content_type or infer_content_type(payload.title),
        asr_task_id=task_id,
        asr_status=ASRStatus.PROCESSING,
        llm_status=LLMStatus.PENDING,
        audio_duration=payload.audio_duration or 0,
        duration_seconds=payload.audio_duration or 0,
    )
    db.add(meeting)
    db.commit()
    enqueue_meeting_processing(meeting.id)

    return PresignedUploadCompleteResponse(
        meeting_id=meeting.id,
        status="processing",
        object_key=payload.object_key,
    )
