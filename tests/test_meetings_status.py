from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker
from sqlalchemy.pool import StaticPool

from api.meetings import get_db, router
from models import ASRStatus, Base, LLMStatus, Meeting


@pytest.fixture()
def db_session() -> Iterator[Session]:
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    Base.metadata.create_all(bind=engine)
    testing_session = sessionmaker(bind=engine, autoflush=False, autocommit=False)
    db = testing_session()
    try:
        yield db
    finally:
        db.close()


@pytest.fixture()
def client(db_session: Session) -> Iterator[TestClient]:
    app = FastAPI()
    app.include_router(router)

    def override_get_db() -> Iterator[Session]:
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client


def test_get_status_is_read_only(
    client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    meeting = Meeting(
        id="meeting-read-only",
        title="read-only.wav",
        audio_file_path="/tmp/read-only.wav",
        upload_time=datetime.now(timezone.utc),
        asr_task_id="aliyun-task-id",
        asr_status=ASRStatus.PROCESSING,
        duration_seconds=60,
        audio_duration=60,
    )
    db_session.add(meeting)
    db_session.commit()

    class ForbiddenASRService:
        def __init__(self, *args: object, **kwargs: object) -> None:
            raise AssertionError("GET status must not instantiate ASR service")

    class ForbiddenLLMService:
        def __init__(self, *args: object, **kwargs: object) -> None:
            raise AssertionError("GET status must not instantiate LLM service")

    monkeypatch.setattr("api.meetings.AliyunASRService", ForbiddenASRService)
    monkeypatch.setattr("api.meetings.LLMService", ForbiddenLLMService)

    response = client.get("/api/meetings/meeting-read-only/status")

    assert response.status_code == 200
    body = response.json()
    assert body["meeting_id"] == "meeting-read-only"
    assert body["status"] == "PROCESSING"

    db_session.expire_all()
    persisted = db_session.get(Meeting, "meeting-read-only")
    assert persisted is not None
    assert persisted.asr_status == ASRStatus.PROCESSING
    assert persisted.transcript_json is None
    assert persisted.summary_content is None


def test_get_status_is_tenant_scoped(
    client: TestClient,
    db_session: Session,
) -> None:
    meeting = Meeting(
        id="tenant-private",
        tenant_id="tenant-a",
        user_id="user-a",
        title="private.wav",
        audio_file_path="/tmp/private.wav",
        upload_time=datetime.now(timezone.utc),
        asr_status=ASRStatus.COMPLETED,
        llm_status=LLMStatus.COMPLETED,
        duration_seconds=60,
        audio_duration=60,
    )
    db_session.add(meeting)
    db_session.commit()

    denied = client.get(
        "/api/meetings/tenant-private/status",
        headers={"X-Tenant-Id": "tenant-b", "X-User-Id": "user-a"},
    )
    allowed = client.get(
        "/api/meetings/tenant-private/status",
        headers={"X-Tenant-Id": "tenant-a", "X-User-Id": "user-a"},
    )

    assert denied.status_code == 404
    assert allowed.status_code == 200


def test_retry_summary_only_resets_llm_state(
    client: TestClient,
    db_session: Session,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    meeting = Meeting(
        id="retry-summary",
        title="retry.wav",
        audio_file_path="/tmp/retry.wav",
        upload_time=datetime.now(timezone.utc),
        asr_task_id="existing-asr-task",
        asr_status=ASRStatus.COMPLETED,
        llm_status=LLMStatus.FAILED,
        llm_error="quota",
        transcript_json=[{"speaker": "spk_1", "start_time": 0, "end_time": 1000, "text": "hello"}],
        summary_content="failed",
        ia_content="",
        summary_markdown="failed",
    )
    db_session.add(meeting)
    db_session.commit()

    enqueued: list[str] = []
    monkeypatch.setattr("api.meetings.enqueue_summary_retry", lambda meeting_id: enqueued.append(meeting_id) or True)

    response = client.post("/api/meetings/retry-summary/retry-summary")

    assert response.status_code == 200
    assert enqueued == ["retry-summary"]
    db_session.expire_all()
    persisted = db_session.get(Meeting, "retry-summary")
    assert persisted is not None
    assert persisted.asr_status == ASRStatus.COMPLETED
    assert persisted.asr_task_id == "existing-asr-task"
    assert persisted.llm_status == LLMStatus.PENDING
    assert persisted.summary_content is None


def test_legacy_upload_is_disabled_by_default(client: TestClient) -> None:
    response = client.post(
        "/api/meetings/upload",
        files={"file": ("meeting.wav", b"audio", "audio/wav")},
    )

    assert response.status_code == 410
    assert "OSS" in response.json()["detail"]


def test_local_audio_stream_is_disabled_by_default(
    client: TestClient,
    db_session: Session,
    tmp_path,
) -> None:
    audio_path = tmp_path / "private.wav"
    audio_path.write_bytes(b"audio")
    meeting = Meeting(
        id="local-audio-disabled",
        title="private.wav",
        audio_file_path=str(audio_path),
        upload_time=datetime.now(timezone.utc),
        asr_status=ASRStatus.COMPLETED,
        llm_status=LLMStatus.COMPLETED,
        duration_seconds=1,
        audio_duration=1,
    )
    db_session.add(meeting)
    db_session.commit()

    response = client.get("/api/meetings/local-audio-disabled/audio")

    assert response.status_code == 410


def test_trusted_header_auth_requires_identity(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import auth

    monkeypatch.setattr(
        auth,
        "get_settings",
        lambda: SimpleNamespace(
            auth_mode="trusted_headers",
            default_tenant_id="public",
            default_user_id="local-user",
        ),
    )

    response = client.get("/api/meetings/stats")

    assert response.status_code == 401
