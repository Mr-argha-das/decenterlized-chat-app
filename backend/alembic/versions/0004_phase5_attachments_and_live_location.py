"""phase5_attachments_and_live_location

Revision ID: 0004_phase5_attachments_and_live_location
Revises: 0003_phase4_contacts_blocks_privacy
Create Date: 2026-11-26 19:35:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0004_phase5_attachments_and_live_location"
down_revision: Union[str, None] = "0003_phase4_contacts_blocks_privacy"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "storage_quota_bytes",
            sa.BigInteger(),
            nullable=False,
            server_default="524288000",
        ),
    )

    op.add_column(
        "attachments",
        sa.Column("conversation_id", sa.String(length=36), nullable=True),
    )
    op.create_index(
        op.f("ix_attachments_conversation_id"),
        "attachments",
        ["conversation_id"],
        unique=False,
    )
    op.add_column(
        "attachments",
        sa.Column(
            "storage_backend",
            sa.String(length=16),
            nullable=False,
            server_default="local",
        ),
    )
    op.add_column(
        "attachments",
        sa.Column(
            "ciphertext_size",
            sa.BigInteger(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "attachments",
        sa.Column(
            "chunk_size",
            sa.Integer(),
            nullable=False,
            server_default="1048576",
        ),
    )
    op.add_column(
        "attachments",
        sa.Column("uploaded_chunk_map", sa.JSON(), nullable=True),
    )
    op.add_column(
        "attachments",
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE attachments SET uploaded_chunk_map = '[]' WHERE uploaded_chunk_map IS NULL")

    op.create_table(
        "live_location_sessions",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("message_id", sa.String(length=36), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("sender_id", sa.String(length=36), nullable=False),
        sa.Column("ciphertext", sa.Text(), nullable=False),
        sa.Column("nonce", sa.String(length=64), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["messages.id"],
            name=op.f("fk_live_location_sessions_message_id_messages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
            name=op.f("fk_live_location_sessions_conversation_id_conversations"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["sender_id"],
            ["users.id"],
            name=op.f("fk_live_location_sessions_sender_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_live_location_sessions")),
        sa.UniqueConstraint("message_id", name=op.f("uq_live_location_sessions_message_id")),
    )
    op.create_index(
        "ix_live_loc_conv_active",
        "live_location_sessions",
        ["conversation_id", "is_active"],
        unique=False,
    )
    op.create_index(
        op.f("ix_live_location_sessions_conversation_id"),
        "live_location_sessions",
        ["conversation_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_live_location_sessions_expires_at"),
        "live_location_sessions",
        ["expires_at"],
        unique=False,
    )
    op.create_index(
        op.f("ix_live_location_sessions_message_id"),
        "live_location_sessions",
        ["message_id"],
        unique=True,
    )
    op.create_index(
        op.f("ix_live_location_sessions_sender_id"),
        "live_location_sessions",
        ["sender_id"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_live_location_sessions_sender_id"), table_name="live_location_sessions")
    op.drop_index(op.f("ix_live_location_sessions_message_id"), table_name="live_location_sessions")
    op.drop_index(op.f("ix_live_location_sessions_expires_at"), table_name="live_location_sessions")
    op.drop_index(op.f("ix_live_location_sessions_conversation_id"), table_name="live_location_sessions")
    op.drop_index("ix_live_loc_conv_active", table_name="live_location_sessions")
    op.drop_table("live_location_sessions")

    op.drop_column("attachments", "completed_at")
    op.drop_column("attachments", "uploaded_chunk_map")
    op.drop_column("attachments", "chunk_size")
    op.drop_column("attachments", "ciphertext_size")
    op.drop_column("attachments", "storage_backend")
    op.drop_index(op.f("ix_attachments_conversation_id"), table_name="attachments")
    op.drop_column("attachments", "conversation_id")

    op.drop_column("users", "storage_quota_bytes")
