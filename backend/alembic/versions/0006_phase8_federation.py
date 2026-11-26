"""phase8_federation

Revision ID: 0006_phase8_federation
Revises: 0005_phase7_groups_and_sender_keys
Create Date: 2026-11-26 21:05:00.000000
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "0006_phase8_federation"
down_revision: Union[str, None] = "0005_phase7_groups_and_sender_keys"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "users",
        sa.Column("is_admin", sa.Boolean(), nullable=False, server_default=sa.false()),
    )

    op.add_column(
        "attachments",
        sa.Column("origin_domain", sa.String(length=128), nullable=True),
    )
    op.add_column(
        "attachments",
        sa.Column("remote_attachment_id", sa.String(length=36), nullable=True),
    )
    op.add_column(
        "attachments",
        sa.Column("remote_download_url", sa.String(length=512), nullable=True),
    )

    op.add_column(
        "federation_peers",
        sa.Column("inbox_url", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "federation_peers",
        sa.Column(
            "status",
            sa.String(length=24),
            nullable=False,
            server_default="online",
        ),
    )
    op.add_column(
        "federation_peers",
        sa.Column("last_error", sa.Text(), nullable=True),
    )

    op.add_column(
        "federation_outbox",
        sa.Column("event_id", sa.String(length=64), nullable=True),
    )
    op.create_index(
        op.f("ix_federation_outbox_event_id"),
        "federation_outbox",
        ["event_id"],
        unique=False,
    )
    op.add_column(
        "federation_outbox",
        sa.Column("dead_lettered_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "remote_users",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("user_id", sa.String(length=36), nullable=False),
        sa.Column("global_id", sa.String(length=160), nullable=False),
        sa.Column("username", sa.String(length=20), nullable=False),
        sa.Column("domain", sa.String(length=128), nullable=False),
        sa.Column("display_name", sa.String(length=80), nullable=False),
        sa.Column("about", sa.String(length=255), nullable=False, server_default=""),
        sa.Column("avatar_url", sa.String(length=512), nullable=True),
        sa.Column("public_key", sa.Text(), nullable=False),
        sa.Column("node_url", sa.String(length=255), nullable=False),
        sa.Column("inbox_url", sa.String(length=255), nullable=False),
        sa.Column("fetched_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name=op.f("fk_remote_users_user_id_users"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_remote_users")),
        sa.UniqueConstraint("username", "domain", name="uq_remote_users_username_domain"),
    )
    op.create_index(op.f("ix_remote_users_user_id"), "remote_users", ["user_id"], unique=True)
    op.create_index(op.f("ix_remote_users_global_id"), "remote_users", ["global_id"], unique=True)
    op.create_index(op.f("ix_remote_users_domain"), "remote_users", ["domain"], unique=False)
    op.create_index(op.f("ix_remote_users_expires_at"), "remote_users", ["expires_at"], unique=False)
    op.create_index(
        "ix_remote_users_domain_expires",
        "remote_users",
        ["domain", "expires_at"],
        unique=False,
    )

    op.create_table(
        "federation_nonces",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("origin_domain", sa.String(length=128), nullable=False),
        sa.Column("nonce", sa.String(length=128), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_federation_nonces")),
        sa.UniqueConstraint("origin_domain", "nonce", name="uq_fed_nonces_domain_nonce"),
    )
    op.create_index(
        op.f("ix_federation_nonces_origin_domain"),
        "federation_nonces",
        ["origin_domain"],
        unique=False,
    )
    op.create_index(
        op.f("ix_federation_nonces_expires_at"),
        "federation_nonces",
        ["expires_at"],
        unique=False,
    )

    op.create_table(
        "federation_settings",
        sa.Column("key", sa.String(length=64), nullable=False),
        sa.Column("value", sa.Text(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("key", name=op.f("pk_federation_settings")),
    )

    op.create_table(
        "federation_domain_rules",
        sa.Column("id", sa.String(length=36), nullable=False),
        sa.Column("domain", sa.String(length=128), nullable=False),
        sa.Column("rule", sa.String(length=16), nullable=False),
        sa.Column("note", sa.String(length=255), nullable=True),
        sa.Column("created_by_id", sa.String(length=36), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["created_by_id"],
            ["users.id"],
            name=op.f("fk_federation_domain_rules_created_by_id_users"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_federation_domain_rules")),
    )
    op.create_index(
        op.f("ix_federation_domain_rules_domain"),
        "federation_domain_rules",
        ["domain"],
        unique=True,
    )
    op.create_index(
        op.f("ix_federation_domain_rules_rule"),
        "federation_domain_rules",
        ["rule"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index(op.f("ix_federation_domain_rules_rule"), table_name="federation_domain_rules")
    op.drop_index(op.f("ix_federation_domain_rules_domain"), table_name="federation_domain_rules")
    op.drop_table("federation_domain_rules")

    op.drop_table("federation_settings")

    op.drop_index(op.f("ix_federation_nonces_expires_at"), table_name="federation_nonces")
    op.drop_index(op.f("ix_federation_nonces_origin_domain"), table_name="federation_nonces")
    op.drop_table("federation_nonces")

    op.drop_index("ix_remote_users_domain_expires", table_name="remote_users")
    op.drop_index(op.f("ix_remote_users_expires_at"), table_name="remote_users")
    op.drop_index(op.f("ix_remote_users_domain"), table_name="remote_users")
    op.drop_index(op.f("ix_remote_users_global_id"), table_name="remote_users")
    op.drop_index(op.f("ix_remote_users_user_id"), table_name="remote_users")
    op.drop_table("remote_users")

    op.drop_column("federation_outbox", "dead_lettered_at")
    op.drop_index(op.f("ix_federation_outbox_event_id"), table_name="federation_outbox")
    op.drop_column("federation_outbox", "event_id")

    op.drop_column("federation_peers", "last_error")
    op.drop_column("federation_peers", "status")
    op.drop_column("federation_peers", "inbox_url")

    op.drop_column("attachments", "remote_download_url")
    op.drop_column("attachments", "remote_attachment_id")
    op.drop_column("attachments", "origin_domain")

    op.drop_column("users", "is_admin")
