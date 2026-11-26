from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

PolicyMode = Literal["open", "allowlist", "denylist"]
DomainRuleAction = Literal["allow", "block"]


class FederationInboxEnvelope(BaseModel):
    event_id: str = Field(..., min_length=4, max_length=128)
    event_type: str = Field(..., min_length=2, max_length=64)
    origin_domain: str = Field(..., min_length=3, max_length=128)
    timestamp: datetime
    data: dict[str, Any] = Field(default_factory=dict)


class FederationInboxAckOut(BaseModel):
    status: str = "accepted"
    event_id: str
    event_type: str
    domain: str


class FederationPeerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    domain: str
    node_url: str
    inbox_url: str | None = None
    public_key_ed25519: str
    status: str = "online"
    is_trusted: bool = True
    is_blocked: bool = False
    last_seen_at: datetime | None = None
    last_error: str | None = None
    failure_count: int = 0
    created_at: datetime
    updated_at: datetime


class FederationDomainRuleIn(BaseModel):
    domain: str = Field(..., min_length=3, max_length=128)
    rule: DomainRuleAction
    note: str | None = Field(default=None, max_length=255)


class FederationDomainRuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    domain: str
    rule: str
    note: str | None = None
    created_at: datetime


class FederationPolicyUpdateIn(BaseModel):
    mode: PolicyMode
    allow_domains: list[str] | None = None
    block_domains: list[str] | None = None


class FederationProbePeerIn(BaseModel):
    domain: str = Field(..., min_length=3, max_length=128)


class FederationOutboxItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    event_id: str | None = None
    target_domain: str
    target_inbox_url: str
    event_type: str
    status: str
    attempts: int
    max_attempts: int
    next_retry_at: datetime
    last_error: str | None = None
    dead_lettered_at: datetime | None = None
    created_at: datetime
    delivered_at: datetime | None = None


class FederationOutboxStatsOut(BaseModel):
    pending: int = 0
    processing: int = 0
    delivered: int = 0
    dead_letter: int = 0


class FederationStatusOut(BaseModel):
    domain: str
    app_name: str
    node_url: str
    public_key_ed25519: str
    federation_enabled: bool
    policy_mode: PolicyMode
    can_manage: bool
    rules: list[FederationDomainRuleOut]
    peers: list[FederationPeerOut]
    outbox_stats: FederationOutboxStatsOut
    recent_outbox: list[FederationOutboxItemOut] = Field(default_factory=list)
    cached_remote_users: int = 0
