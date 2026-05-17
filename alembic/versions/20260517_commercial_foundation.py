"""commercial foundation

Revision ID: 20260517_commercial_foundation
Revises:
Create Date: 2026-05-17
"""

from __future__ import annotations

from alembic import op
import sqlalchemy as sa


revision = "20260517_commercial_foundation"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    with op.batch_alter_table("meetings") as batch_op:
        batch_op.add_column(sa.Column("tenant_id", sa.String(length=64), nullable=False, server_default="public"))
        batch_op.add_column(sa.Column("user_id", sa.String(length=64), nullable=False, server_default="local-user"))
        batch_op.add_column(sa.Column("meeting_type", sa.String(length=64), nullable=False, server_default="default"))
        batch_op.add_column(sa.Column("llm_status", sa.String(length=32), nullable=False, server_default="PENDING"))
        batch_op.add_column(sa.Column("llm_error", sa.Text(), nullable=True))
        batch_op.add_column(sa.Column("media_object_key", sa.String(length=1024), nullable=True))
        batch_op.add_column(sa.Column("media_bucket", sa.String(length=255), nullable=True))
        batch_op.add_column(sa.Column("media_size_bytes", sa.Integer(), nullable=True, server_default="0"))
        batch_op.add_column(sa.Column("media_content_type", sa.String(length=128), nullable=True))
        batch_op.create_index("ix_meetings_tenant_id", ["tenant_id"])
        batch_op.create_index("ix_meetings_user_id", ["user_id"])
        batch_op.create_index("ix_meetings_meeting_type", ["meeting_type"])
        batch_op.create_index("ix_meetings_media_object_key", ["media_object_key"])

    with op.batch_alter_table("chat_histories") as batch_op:
        batch_op.add_column(sa.Column("tenant_id", sa.String(length=64), nullable=False, server_default="public"))
        batch_op.add_column(sa.Column("user_id", sa.String(length=64), nullable=False, server_default="local-user"))
        batch_op.create_index("ix_chat_histories_tenant_id", ["tenant_id"])
        batch_op.create_index("ix_chat_histories_user_id", ["user_id"])

    op.create_table(
        "transcripts",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.String(length=64), nullable=False, server_default="public"),
        sa.Column("user_id", sa.String(length=64), nullable=False, server_default="local-user"),
        sa.Column("meeting_id", sa.String(length=36), nullable=False),
        sa.Column("content_json", sa.JSON(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_transcripts_tenant_id", "transcripts", ["tenant_id"])
    op.create_index("ix_transcripts_user_id", "transcripts", ["user_id"])
    op.create_index("ix_transcripts_meeting_id", "transcripts", ["meeting_id"])
    op.create_index("ix_transcripts_created_at", "transcripts", ["created_at"])

    op.create_table(
        "summaries",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.String(length=64), nullable=False, server_default="public"),
        sa.Column("user_id", sa.String(length=64), nullable=False, server_default="local-user"),
        sa.Column("meeting_id", sa.String(length=36), nullable=False),
        sa.Column("status", sa.String(length=32), nullable=False, server_default="PENDING"),
        sa.Column("summary_content", sa.Text(), nullable=True),
        sa.Column("ia_content", sa.Text(), nullable=True),
        sa.Column("raw_content", sa.Text(), nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="CASCADE"),
    )
    op.create_index("ix_summaries_tenant_id", "summaries", ["tenant_id"])
    op.create_index("ix_summaries_user_id", "summaries", ["user_id"])
    op.create_index("ix_summaries_meeting_id", "summaries", ["meeting_id"])
    op.create_index("ix_summaries_created_at", "summaries", ["created_at"])

    op.create_table(
        "usage_logs",
        sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
        sa.Column("tenant_id", sa.String(length=64), nullable=False, server_default="public"),
        sa.Column("user_id", sa.String(length=64), nullable=False, server_default="local-user"),
        sa.Column("meeting_id", sa.String(length=36), nullable=True),
        sa.Column("service", sa.String(length=32), nullable=False),
        sa.Column("provider", sa.String(length=64), nullable=True),
        sa.Column("model", sa.String(length=128), nullable=True),
        sa.Column("quantity_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("input_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("output_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("total_tokens", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("request_id", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(["meeting_id"], ["meetings.id"], ondelete="SET NULL"),
    )
    op.create_index("ix_usage_logs_tenant_id", "usage_logs", ["tenant_id"])
    op.create_index("ix_usage_logs_user_id", "usage_logs", ["user_id"])
    op.create_index("ix_usage_logs_meeting_id", "usage_logs", ["meeting_id"])
    op.create_index("ix_usage_logs_service", "usage_logs", ["service"])
    op.create_index("ix_usage_logs_created_at", "usage_logs", ["created_at"])


def downgrade() -> None:
    op.drop_table("usage_logs")
    op.drop_table("summaries")
    op.drop_table("transcripts")

    with op.batch_alter_table("chat_histories") as batch_op:
        batch_op.drop_index("ix_chat_histories_user_id")
        batch_op.drop_index("ix_chat_histories_tenant_id")
        batch_op.drop_column("user_id")
        batch_op.drop_column("tenant_id")

    with op.batch_alter_table("meetings") as batch_op:
        batch_op.drop_index("ix_meetings_media_object_key")
        batch_op.drop_index("ix_meetings_meeting_type")
        batch_op.drop_index("ix_meetings_user_id")
        batch_op.drop_index("ix_meetings_tenant_id")
        batch_op.drop_column("media_content_type")
        batch_op.drop_column("media_size_bytes")
        batch_op.drop_column("media_bucket")
        batch_op.drop_column("media_object_key")
        batch_op.drop_column("llm_error")
        batch_op.drop_column("llm_status")
        batch_op.drop_column("meeting_type")
        batch_op.drop_column("user_id")
        batch_op.drop_column("tenant_id")
