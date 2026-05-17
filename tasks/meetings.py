"""Celery tasks for meeting processing."""

from __future__ import annotations

import time

from celery_app import celery_app
from models import SessionLocal
from services.meeting_processing import DEFAULT_MAX_POLLS, DEFAULT_POLL_INTERVAL_SECONDS, process_meeting_once


@celery_app.task(name="meetings.process", autoretry_for=(Exception,), retry_backoff=True, max_retries=3)
def process_meeting_task(
    meeting_id: str,
    poll_interval_seconds: float = DEFAULT_POLL_INTERVAL_SECONDS,
    max_polls: int = DEFAULT_MAX_POLLS,
) -> None:
    for _ in range(max_polls):
        db = SessionLocal()
        try:
            is_terminal = process_meeting_once(db, meeting_id)
        finally:
            db.close()
        if is_terminal:
            return
        time.sleep(poll_interval_seconds)
