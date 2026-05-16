"""SystemReq-Copilot FastAPI 应用入口。"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from api.meetings import router as meetings_router
from config import get_settings
from models import ensure_schema


app = FastAPI(
    title="SystemReq-Copilot",
    description="会议需求智能提取系统：音频上传、ASR、需求纪要和上下文 Agent。",
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(meetings_router)


@app.on_event("startup")
def on_startup() -> None:
    """启动时确保上传目录与数据库表存在。"""

    settings = get_settings()
    settings.upload_dir.mkdir(parents=True, exist_ok=True)
    ensure_schema()


@app.get("/api/health")
def health_check() -> dict[str, str]:
    """健康检查接口。"""

    return {"status": "ok"}
