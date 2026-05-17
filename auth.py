"""Request identity and tenant context dependencies."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Header, HTTPException, status

from config import get_settings


@dataclass(frozen=True)
class RequestContext:
    tenant_id: str
    user_id: str


def get_request_context(
    x_tenant_id: str | None = Header(default=None, alias="X-Tenant-Id"),
    x_user_id: str | None = Header(default=None, alias="X-User-Id"),
) -> RequestContext:
    """Resolve the request tenant/user boundary.

    ``development`` mode preserves the local single-user fallback. In
    ``trusted_headers`` mode, an upstream gateway or auth proxy must inject
    identity headers; missing headers are rejected instead of falling back to a
    shared tenant.
    """

    settings = get_settings()
    auth_mode = settings.auth_mode.strip().lower()

    if auth_mode == "development":
        return RequestContext(
            tenant_id=_clean_or_default(x_tenant_id, settings.default_tenant_id),
            user_id=_clean_or_default(x_user_id, settings.default_user_id),
        )

    if auth_mode == "trusted_headers":
        tenant_id = (x_tenant_id or "").strip()
        user_id = (x_user_id or "").strip()
        if not tenant_id or not user_id:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="缺少认证上下文",
            )
        return RequestContext(tenant_id=tenant_id, user_id=user_id)

    raise HTTPException(
        status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
        detail=f"不支持的认证模式：{settings.auth_mode}",
    )


def _clean_or_default(value: str | None, default: str) -> str:
    cleaned = (value or default).strip()
    return cleaned or default
