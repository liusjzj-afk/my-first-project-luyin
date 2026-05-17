"""Object storage signing helpers for direct upload and signed playback."""

from __future__ import annotations

import mimetypes
import uuid
from dataclasses import dataclass
from pathlib import Path

import oss2

from services.asr_service import ASRSettings, ASRServiceError


UPLOAD_URL_TTL_SECONDS = 900
PLAYBACK_URL_TTL_SECONDS = 3600


@dataclass(frozen=True)
class SignedUpload:
    meeting_id: str
    object_key: str
    upload_url: str
    expires_in: int
    headers: dict[str, str]


class ObjectStorageService:
    """Aliyun OSS URL signer.

    Phase 2 uses signed URLs instead of backend media IO. The same interface can
    be implemented by S3 later without touching the router contract.
    """

    def __init__(self, settings: ASRSettings | None = None) -> None:
        self.settings = settings or ASRSettings.from_env()
        if not self.settings.oss_endpoint or not self.settings.oss_bucket:
            raise ASRServiceError(
                "缺少 OSS 配置，请填写 ALIYUN_OSS_ENDPOINT 和 ALIYUN_OSS_BUCKET"
            )
        auth = oss2.Auth(self.settings.aliyun_ak, self.settings.aliyun_sk)
        self.bucket = oss2.Bucket(auth, self.settings.oss_endpoint, self.settings.oss_bucket)

    @property
    def bucket_name(self) -> str:
        return self.settings.oss_bucket or ""

    def create_presigned_upload(
        self,
        *,
        tenant_id: str,
        filename: str,
        content_type: str | None,
        expires_in: int = UPLOAD_URL_TTL_SECONDS,
    ) -> SignedUpload:
        meeting_id = str(uuid.uuid4())
        safe_filename = Path(filename or "meeting-audio").name
        object_key = f"tenants/{tenant_id}/meetings/{meeting_id}/{safe_filename}"
        headers = {}
        if content_type:
            headers["Content-Type"] = content_type

        upload_url = self.bucket.sign_url(
            "PUT",
            object_key,
            expires_in,
            headers=headers or None,
        )
        return SignedUpload(
            meeting_id=meeting_id,
            object_key=object_key,
            upload_url=upload_url,
            expires_in=expires_in,
            headers=headers,
        )

    def signed_get_url(self, object_key: str, *, expires_in: int = PLAYBACK_URL_TTL_SECONDS) -> str:
        if self.settings.oss_public_base_url:
            return f"{self.settings.oss_public_base_url.rstrip('/')}/{object_key}"
        return self.bucket.sign_url("GET", object_key, expires_in)


def infer_content_type(filename: str) -> str:
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"
