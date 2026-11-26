"""phase9_status_push_polish

Revision ID: 0007_phase9_status_push_polish
Revises: 0006_phase8_federation
Create Date: 2026-11-26 21:55:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0007_phase9_status_push_polish"
down_revision: Union[str, None] = "0006_phase8_federation"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. User status privacy defaults
    op.add_column(
        "users",
        sa.Column(
            "status_privacy_mode",
            sa.String(length=16),
            nullable=False,
            server_default="contacts",
        ),
    )
    op.add_column(
        "users",
        sa.Column("status_privacy_exceptions", sa.JSON(), nullable=True),
    )
    op.add_column(
        "users",
        sa.Column("status_privacy_only_ids", sa.JSON(), nullable=True),
    )

    # 2. Conversation disappearing timer + member archive flag
    op.add_column(
        "conversations",
        sa.Column(
            "disappearing_timer_seconds",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "conversation_members",
        sa.Column(
            "is_archived",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )

    # 3. Statuses extensions (font, encrypted attachment ref, privacy mode & targets)
    op.add_column(
        "statuses",
        sa.Column("font_family", sa.String(length=32), nullable=True),
    )
    op.add_column(
        "statuses",
        sa.Column("attachment_id", sa.String(length=36), nullable=True),
    )
    op.create_index(
        op.f("ix_statuses_attachment_id"),
        "statuses",
        ["attachment_id"],
        unique=False,
    )
    op.add_column(
        "statuses",
        sa.Column(
            "privacy_mode",
            sa.String(length=16),
            nullable=False,
            server_default="contacts",
        ),
    )
    op.add_column(
        "statuses",
        sa.Column("target_user_ids", sa.JSON(), nullable=True),
    )

    # 4. Status views & Status mutes tables
    op.create_table(
        "status_views",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("status_id", sa.String(length=36), nullable=False),
        sa.Column("viewer_id", sa.String(length=36), nullable=False),
        sa.Column("viewed_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["status_id"],
            ["statuses.id"],
            name=op.f("fk_status_views_status_id_statuses"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["viewer_id"],
            ["users.id"],
            name=op.f("fk_status_views_viewer_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_status_views")),
        sa.UniqueConstraint(
            "status_id",
            "viewer_id",
            name="uq_status_views_status_viewer",
        ),
    )
    op.create_index(
        op.f("ix_status_views_status_id"),
        "status_views",
        ["status_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_status_views_viewer_id"),
        "status_views",
        ["viewer_id"],
        unique=False,
    )
    op.create_index(
        "ix_status_views_status_viewed",
        "status_views",
        ["status_id", "viewed_at"],
        unique=False,
    )

    op.create_table(
        "status_mutes",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("muter_id", sa.String(length=36), nullable=False),
        sa.Column("muted_user_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["muter_id"],
            ["users.id"],
            name=op.f("fk_status_mutes_muter_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["muted_user_id"],
            ["users.id"],
            name=op.f("fk_status_mutes_muted_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_status_mutes")),
        sa.UniqueConstraint(
            "muter_id",
            "muted_user_id",
            name="uq_status_mutes_muter_muted",
        ),
    )
    op.create_index(
        op.f("ix_status_mutes_muter_id"),
        "status_mutes",
        ["muter_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_status_mutes_muted_user_id"),
        "status_mutes",
        ["muted_user_id"],
        unique=False,
    )

    # 5. Push subscriptions extensions
    op.add_column(
        "push_subscriptions",
        sa.Column(
            "local_decrypt_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
    )
    op.add_column(
        "push_subscriptions",
        sa.Column("user_agent", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "push_subscriptions",
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )

    # 6. Starred messages table
    op.create_table(
        "starred_messages",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("message_id", sa.String(length=36), nullable=False),
        sa.Column("conversation_id", sa.String(length=36), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_starred_messages_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["message_id"],
            ["messages.id"],
            name=op.f("fk_starred_messages_message_id_messages"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["conversation_id"],
            ["conversations.id"],
            name=op.f("fk_starred_messages_conversation_id_conversations"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_starred_messages")),
        sa.UniqueConstraint(
            "user_id",
            "message_id",
            name="uq_starred_messages_user_msg",
        ),
    )
    op.create_index(
        op.f("ix_starred_messages_user_id"),
        "starred_messages",
        ["user_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_starred_messages_message_id"),
        "starred_messages",
        ["message_id"],
        unique=False,
    )
    op.create_index(
        op.f("ix_starred_messages_conversation_id"),
        "starred_messages",
        ["conversation_id"],
        unique=False,
    )
    op.create_index(
        "ix_starred_messages_user_created",
        "starred_messages",
        ["user_id", "created_at"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_starred_messages_user_created", table_name="starred_messages")
    op.drop_index(op.f("ix_starred_messages_conversation_id"), table_name="starred_messages")
    op.drop_index(op.f("ix_starred_messages_message_id"), table_name="starred_messages")
    op.drop_index(op.f("ix_starred_messages_user_id"), table_name="starred_messages")
    op.drop_table("starred_messages")

    op.drop_column("push_subscriptions", "updated_at")
    op.drop_column("push_subscriptions", "user_agent")
    op.drop_column("push_subscriptions", "local_decrypt_enabled")

    op.drop_index(op.f("ix_status_mutes_muted_user_id"), table_name="status_mutes")
    op.drop_index(op.f("ix_status_mutes_muter_id"), table_name="status_mutes")
    op.drop_table("status_mutes")

    op.drop_index("ix_status_views_status_viewed", table_name="status_views")
    op.drop_index(op.f("ix_status_views_viewer_id"), table_name="status_views")
    op.drop_index(op.f("ix_status_views_status_id"), table_name="status_views")
    op.drop_table("status_views")

    op.drop_column("statuses", "target_user_ids")
    op.drop_column("statuses", "privacy_mode")
    op.drop_index(op.f("ix_statuses_attachment_id"), table_name="statuses")
    op.drop_column("statuses", "attachment_id")
    op.drop_column("statuses", "font_family")

    op.drop_column("conversation_members", "is_archived")
    op.drop_column("conversations", "disappearing_timer_seconds")

    op.drop_column("users", "status_privacy_only_ids")
    op.drop_column("users", "status_privacy_exceptions")
    op.drop_column("users", "status_privacy_mode")
