"""phase3_chat_and_receipts

Revision ID: 0002_phase3_chat_and_receipts
Revises: 0001_initial_schema
Create Date: 2026-11-26 10:05:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0002_phase3_chat_and_receipts"
down_revision: Union[str, None] = "0001_initial_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "conversation_members",
        sa.Column("is_pinned", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "conversation_members",
        sa.Column("is_muted", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    op.add_column(
        "messages",
        sa.Column("client_msg_id", sa.String(length=64), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(op.f("ix_messages_client_msg_id"), "messages", ["client_msg_id"], unique=False)
    op.create_index(op.f("ix_messages_updated_at"), "messages", ["updated_at"], unique=False)

    op.create_table(
        "message_receipts",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("message_id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["messages.id"],
            name=op.f("fk_message_receipts_message_id_messages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_message_receipts_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_message_receipts")),
        sa.UniqueConstraint("message_id", "user_id", name="uq_message_receipts_msg_user"),
    )
    op.create_index(
        op.f("ix_message_receipts_message_id"), "message_receipts", ["message_id"], unique=False
    )
    op.create_index(
        op.f("ix_message_receipts_user_id"), "message_receipts", ["user_id"], unique=False
    )
    op.create_index(
        "ix_message_receipts_user_read", "message_receipts", ["user_id", "read_at"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_message_receipts_user_read", table_name="message_receipts")
    op.drop_index(op.f("ix_message_receipts_user_id"), table_name="message_receipts")
    op.drop_index(op.f("ix_message_receipts_message_id"), table_name="message_receipts")
    op.drop_table("message_receipts")

    op.drop_index(op.f("ix_messages_updated_at"), table_name="messages")
    op.drop_index(op.f("ix_messages_client_msg_id"), table_name="messages")
    op.drop_column("messages", "updated_at")
    op.drop_column("messages", "deleted_at")
    op.drop_column("messages", "client_msg_id")

    op.drop_column("conversation_members", "is_muted")
    op.drop_column("conversation_members", "is_pinned")
