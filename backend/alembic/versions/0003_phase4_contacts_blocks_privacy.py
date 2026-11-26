"""phase4_contacts_blocks_privacy

Revision ID: 0003_phase4_contacts_blocks_privacy
Revises: 0002_phase3_chat_and_receipts
Create Date: 2026-11-26 11:00:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0003_phase4_contacts_blocks_privacy"
down_revision: Union[str, None] = "0002_phase3_chat_and_receipts"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column(
            "privacy_profile_photo",
            sa.String(length=16),
            nullable=False,
            server_default="everyone",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "privacy_read_receipts_visibility",
            sa.String(length=16),
            nullable=False,
            server_default="everyone",
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "notifications_enabled",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "notification_sound",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
    )
    op.add_column(
        "users",
        sa.Column(
            "chat_wallpaper",
            sa.String(length=32),
            nullable=False,
            server_default="default",
        ),
    )

    op.add_column(
        "contacts",
        sa.Column("nickname", sa.String(length=80), nullable=True),
    )
    op.add_column(
        "contacts",
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.execute("UPDATE contacts SET nickname = alias WHERE nickname IS NULL AND alias IS NOT NULL")
    op.execute("UPDATE contacts SET updated_at = created_at WHERE updated_at IS NULL")


def downgrade() -> None:
    op.drop_column("contacts", "updated_at")
    op.drop_column("contacts", "nickname")

    op.drop_column("users", "chat_wallpaper")
    op.drop_column("users", "notification_sound")
    op.drop_column("users", "notifications_enabled")
    op.drop_column("users", "privacy_read_receipts_visibility")
    op.drop_column("users", "privacy_profile_photo")
