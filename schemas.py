"""FastAPI 请求与响应结构。"""

from __future__ import annotations

from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field


class UploadMeetingResponse(BaseModel):
    meeting_id: str
    status: Literal["processing"]


class MeetingStatusResponse(BaseModel):
    meeting_id: str
    status: str
    asr_status: str | None = None
    llm_status: str | None = None
    title: str
    upload_time: datetime | None = None
    duration_seconds: int | None = None
    audio_duration: int | None = None
    eta_seconds: int | None = None
    progress_percent: int | None = None
    audio_url: str | None = None
    transcript: list[dict[str, Any]] | None = None
    summary_markdown: str | None = None
    summary_content: str | None = None
    ia_content: str | None = None
    error: str | None = None


class MeetingListItem(BaseModel):
    id: str
    title: str
    upload_time: datetime
    asr_status: str
    llm_status: str | None = None
    duration_seconds: int
    audio_duration: int
    eta_seconds: int | None = None
    progress_percent: int | None = None
    deleted_at: datetime | None = None


class MeetingStatsResponse(BaseModel):
    used_minutes: int
    meeting_count: int
    processing_count: int
    trash_count: int


class ActionResponse(BaseModel):
    ok: bool


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)


class ChatResponse(BaseModel):
    reply: str


class RetrySummaryResponse(BaseModel):
    ok: bool
    llm_status: str


class PresignedUploadResponse(BaseModel):
    meeting_id: str
    object_key: str
    upload_url: str
    method: str = "PUT"
    expires_in: int
    headers: dict[str, str] = {}


class PresignedUploadCompleteRequest(BaseModel):
    object_key: str
    title: str
    meeting_type: str = Field(default="default", max_length=64)
    size_bytes: int = Field(default=0, ge=0)
    content_type: str | None = None
    audio_duration: int | None = Field(default=0, ge=0)


class PresignedUploadCompleteResponse(BaseModel):
    meeting_id: str
    status: str
    object_key: str
