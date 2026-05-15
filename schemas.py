"""FastAPI 请求与响应结构。"""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class UploadMeetingResponse(BaseModel):
    meeting_id: str
    status: Literal["processing"]


class MeetingStatusResponse(BaseModel):
    meeting_id: str
    status: str
    title: str
    transcript: list[dict[str, Any]] | None = None
    summary_markdown: str | None = None
    error: str | None = None


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=4000)


class ChatResponse(BaseModel):
    reply: str
