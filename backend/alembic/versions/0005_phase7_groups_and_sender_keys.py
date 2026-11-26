"""phase7_groups_and_sender_keys

Revision ID: 0005_phase7_groups_and_sender_keys
Revises: 0004_phase5_attachments_and_live_location
Create Date: 2026-11-26 20:15:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0005_phase7_groups_and_sender_keys"
down_revision: Union[str, None] = "0004_phase5_attachments_and_live_location"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "groups",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("name", sa.String(length=100), nullable=False),
        sa.Column("icon_url", sa.String(length=512), nullable=True),
        sa.Column("description", sa.String(length=500), nullable=False, server_default=""),
        sa.Column("created_by_id", sa.String(length=36), nullable=True),
        sa.Column(
            "only_admins_can_send",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column(
            "only_admins_can_edit_info",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column("invite_code", sa.String(length=64), nullable=True),
        sa.Column("invite_revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "key_version",
            sa.Integer(),
            nullable=False,
            server_default="1",
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["id"],
            ["conversations.id"],
            name=op.f("fk_groups_id_conversations"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by_id"],
            ["users.id"],
            name=op.f("fk_groups_created_by_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_groups")),
    )
    op.create_index(op.f("ix_groups_created_by_id"), "groups", ["created_by_id"], unique=False)
    op.create_index(op.f("ix_groups_invite_code"), "groups", ["invite_code"], unique=True)

    op.add_column(
        "conversation_members",
        sa.Column("added_by_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "conversation_members",
        sa.Column("sender_color", sa.String(length=16), nullable=True),
    )

    op.add_column(
        "group_keys",
        sa.Column("key_version", sa.Integer(), nullable=False, server_default="1"),
    )
    op.create_index(
        "ix_group_keys_conv_version",
        "group_keys",
        ["conversation_id", "key_version"],
        unique=False,
    )

    op.add_column(
        "messages",
        sa.Column("sender_key_version", sa.Integer(), nullable=True),
    )
    op.create_index(
        op.f("ix_messages_sender_key_version"),
        "messages",
        ["sender_key_version"],
        unique=False,
    )
    op.add_column(
        "messages",
        sa.Column("mentions", sa.JSON(), nullable=True),
    )
    op.add_column(
        "messages",
        sa.Column("system_event", sa.JSON(), nullable=True),
    )
    op.execute("UPDATE messages SET mentions = '[]' WHERE mentions IS NULL")


def downgrade() -> None:
    op.drop_column("messages", "system_event")
    op.drop_column("messages", "mentions")
    op.drop_index(op.f("ix_messages_sender_key_version"), table_name="messages")
    op.drop_column("messages", "sender_key_version")

    op.drop_index("ix_group_keys_conv_version", table_name="group_keys")
    op.drop_column("group_keys", "key_version")

    op.drop_column("conversation_members", "sender_color")
    op.drop_column("conversation_members", "added_by_id")

    op.drop_index(op.f("ix_groups_invite_code"), table_name="groups")
    op.drop_index(op.f("ix_groups_created_by_id"), table_name="groups")
    op.drop_table("groups")
