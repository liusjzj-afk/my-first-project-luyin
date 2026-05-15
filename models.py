"""
SystemReq-Copilot 数据库实体模型。

当前阶段只定义数据结构；后续 FastAPI 入口可以直接复用 Base、engine、
SessionLocal 和 init_db() 初始化 SQLite 数据库。
"""

from __future__ import annotations

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.dialects.sqlite import JSON
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship, sessionmaker

from config import get_settings

# 需要用户填写或按需覆盖的环境变量：
# DATABASE_URL=sqlite:///./systemreq_copilot.db
DATABASE_URL = get_settings().database_url


def utc_now() -> datetime:
    """生成带 UTC 时区的当前时间，避免本地时区导致记录不一致。"""

    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    """SQLAlchemy 2.x 声明式基类。"""


class ASRStatus(str, enum.Enum):
    """会议 ASR 处理状态。"""

    PENDING = "PENDING"
    PROCESSING = "PROCESSING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"


class ChatRole(str, enum.Enum):
    """Agent 对话角色。"""

    USER = "user"
    ASSISTANT = "assistant"


class Meeting(Base):
    """会议主表，保存音频、ASR 任务、逐字稿和需求纪要。"""

    __tablename__ = "meetings"

    id: Mapped[str] = mapped_column(
        String(36),
        primary_key=True,
        default=lambda: str(uuid.uuid4()),
        comment="会议 UUID",
    )
    title: Mapped[str] = mapped_column(
        String(255),
        nullable=False,
        comment="会议标题，默认使用上传文件名",
    )
    audio_file_path: Mapped[str] = mapped_column(
        String(1024),
        nullable=False,
        comment="本地音频文件绝对路径",
    )
    upload_time: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        comment="上传时间，UTC",
    )
    asr_task_id: Mapped[str | None] = mapped_column(
        String(128),
        nullable=True,
        comment="阿里云 ASR 异步任务 ID",
    )
    asr_status: Mapped[ASRStatus] = mapped_column(
        Enum(ASRStatus, native_enum=False, length=32),
        nullable=False,
        default=ASRStatus.PENDING,
        comment="ASR 任务状态",
    )
    transcript_json: Mapped[list[dict] | None] = mapped_column(
        JSON,
        nullable=True,
        comment="标准化后的逐字稿数组，含 speaker/start_time/text 等字段",
    )
    summary_markdown: Mapped[str | None] = mapped_column(
        Text,
        nullable=True,
        comment="LLM 生成的系统需求 Markdown 纪要",
    )

    chat_histories: Mapped[list["ChatHistory"]] = relationship(
        back_populates="meeting",
        cascade="all, delete-orphan",
        passive_deletes=True,
    )


class ChatHistory(Base):
    """会议上下文 Agent 对话记录。"""

    __tablename__ = "chat_histories"

    id: Mapped[int] = mapped_column(
        Integer,
        primary_key=True,
        autoincrement=True,
        comment="自增主键",
    )
    meeting_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("meetings.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
        comment="关联会议 ID",
    )
    role: Mapped[ChatRole] = mapped_column(
        Enum(ChatRole, native_enum=False, length=32),
        nullable=False,
        comment="对话角色：user 或 assistant",
    )
    content: Mapped[str] = mapped_column(
        Text,
        nullable=False,
        comment="对话内容",
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=utc_now,
        index=True,
        comment="创建时间，UTC",
    )

    meeting: Mapped[Meeting] = relationship(back_populates="chat_histories")


engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
)

SessionLocal = sessionmaker(
    bind=engine,
    autoflush=False,
    autocommit=False,
)


def init_db() -> None:
    """创建数据库表。后续可在 FastAPI 启动事件中调用。"""

    Base.metadata.create_all(bind=engine)
