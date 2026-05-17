"""Tenant-scoped meeting repository helpers."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header
from sqlalchemy.orm import Session

from config import get_settings
from models import Meeting


@dataclass(frozen=True)
class RequestContext:
    tenant_id: str
    user_id: str


def get_request_context(
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> RequestContext:
    settings = get_settings()
    return RequestContext(
        tenant_id=(x_tenant_id or settings.default_tenant_id).strip() or settings.default_tenant_id,
        user_id=(x_user_id or settings.default_user_id).strip() or settings.default_user_id,
    )


def get_meeting_for_context(db: Session, meeting_id: str, context: RequestContext) -> Meeting | None:
    return (
        db.query(Meeting)
        .filter(
            Meeting.id == meeting_id,
            Meeting.tenant_id == context.tenant_id,
            Meeting.user_id == context.user_id,
        )
        .first()
    )


def query_meetings_for_context(db: Session, context: RequestContext):
    return db.query(Meeting).filter(
        Meeting.tenant_id == context.tenant_id,
        Meeting.user_id == context.user_id,
    )
