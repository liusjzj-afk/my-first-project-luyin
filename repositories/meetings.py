"""Tenant-scoped meeting repository helpers."""

from __future__ import annotations

from sqlalchemy.orm import Session

from auth import RequestContext
from models import Meeting


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
