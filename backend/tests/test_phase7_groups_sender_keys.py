import asyncio
import base64
from contextlib import AsyncExitStack
import json
import os
import socket
from pathlib import Path
from typing import Any, AsyncGenerator

import pytest
import pytest_asyncio
import uvicorn
import websockets
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from httpx import AsyncClient
from sqlalchemy import select

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_phase1.db"
os.environ["APP_NAME"] = "RelayChat"
os.environ["APP_DOMAIN"] = "chatapp.in"
os.environ["NODE_KEY_PATH"] = "./.node_keys/test_node_ed25519.json"

from app.core.rate_limit import rate_limiter  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.session import AsyncSessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.entities import GroupKey, Message  # noqa: E402


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class SimulatedGroupPeer:
    """Simulated browser implementing Sender Keys + Pairwise ECDH P-256 Key Wrapping."""

    def __init__(self, username: str, display_name: str) -> None:
        self.username = username
        self.display_name = display_name
        self.priv = ec.generate_private_key(ec.SECP256R1())
        pub = self.priv.private_numbers().public_numbers
        self.x = self._b64u(pub.x)
        self.y = self._b64u(pub.y)
        self.public_jwk = {
            "kty": "EC",
            "crv": "P-256",
            "x": self.x,
            "y": self.y,
            "ext": True,
        }
        self.public_key_str = json.dumps(self.public_jwk, separators=(",", ":"))
        self.access_token = ""
        self.user_id = ""
        self.global_id = ""

    @staticmethod
    def _b64u(val: int) -> str:
        return base64.urlsafe_b64encode(val.to_bytes(32, "big")).rstrip(b"=").decode("ascii")

    @staticmethod
    def _from_b64u(val: str) -> int:
        padded = val + "=" * (-len(val) % 4)
        return int.from_bytes(base64.urlsafe_b64decode(padded), "big")

    def _derive_pairwise_aes(self, peer_pub_json: str) -> AESGCM:
        peer_jwk = json.loads(peer_pub_json)
        px = self._from_b64u(peer_jwk["x"])
        py = self._from_b64u(peer_jwk["y"])
        peer_pub = ec.EllipticCurvePublicNumbers(px, py, ec.SECP256R1()).public_key()
        shared_secret = self.priv.exchange(ec.ECDH(), peer_pub)

        my_coord = f"{self.x}:{self.y}"
        peer_coord = f"{peer_jwk['x']}:{peer_jwk['y']}"
        sorted_coords = "|".join(sorted([my_coord, peer_coord]))
        info = f"RelayChat-1to1-AES256GCM|{sorted_coords}".encode("utf-8")

        hkdf = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b"RelayChat-ECDH-HKDF-SHA256-v1",
            info=info,
        )
        return AESGCM(hkdf.derive(shared_secret))

    def wrap_sender_key_for(
        self, group_id: str, key_version: int, recipient_pub_json: str, sender_key_bytes: bytes
    ) -> tuple[str, str]:
        pairwise = self._derive_pairwise_aes(recipient_pub_json)
        nonce = os.urandom(12)
        aad = f"RelayChat-SenderKeyWrap-v1|{group_id}|v{key_version}".encode("utf-8")
        ct = pairwise.encrypt(nonce, sender_key_bytes, aad)
        return base64.b64encode(ct).decode("ascii"), base64.b64encode(nonce).decode("ascii")

    def unwrap_sender_key_from(
        self, group_id: str, key_version: int, sender_pub_json: str, wrapped_b64: str, nonce_b64: str
    ) -> bytes:
        pairwise = self._derive_pairwise_aes(sender_pub_json)
        aad = f"RelayChat-SenderKeyWrap-v1|{group_id}|v{key_version}".encode("utf-8")
        return pairwise.decrypt(
            base64.b64decode(nonce_b64), base64.b64decode(wrapped_b64), aad
        )

    @staticmethod
    def encrypt_group_msg(
        group_id: str, sender_id: str, key_version: int, sender_key_bytes: bytes, text: str
    ) -> tuple[str, str]:
        aes = AESGCM(sender_key_bytes)
        nonce = os.urandom(12)
        aad = f"RelayChat-GroupMsg-v1|{group_id}|{sender_id}|v{key_version}".encode("utf-8")
        payload = json.dumps({"v": 1, "text": text}).encode("utf-8")
        ct = aes.encrypt(nonce, payload, aad)
        return base64.b64encode(ct).decode("ascii"), base64.b64encode(nonce).decode("ascii")

    @staticmethod
    def decrypt_group_msg(
        group_id: str, sender_id: str, key_version: int, sender_key_bytes: bytes, ct_b64: str, nonce_b64: str
    ) -> str:
        aes = AESGCM(sender_key_bytes)
        aad = f"RelayChat-GroupMsg-v1|{group_id}|{sender_id}|v{key_version}".encode("utf-8")
        plain = aes.decrypt(base64.b64decode(nonce_b64), base64.b64decode(ct_b64), aad)
        return str(json.loads(plain.decode("utf-8"))["text"])


@pytest_asyncio.fixture()
async def live_node() -> AsyncGenerator[tuple[AsyncClient, str], None]:
    rate_limiter.reset()
    await engine.dispose()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)

    base_http = f"http://127.0.0.1:{port}"
    base_ws = f"ws://127.0.0.1:{port}"
    async with AsyncClient(base_url=base_http) as client:
        yield client, base_ws

    server.should_exit = True
    await task
    await engine.dispose()
    for p in (Path("./test_phase1.db"), Path("./.node_keys/test_node_ed25519.json")):
        if p.exists():
            p.unlink()


async def _signup(client: AsyncClient, peer: SimulatedGroupPeer) -> None:
    resp = await client.post(
        "/auth/signup",
        json={
            "username": peer.username,
            "password": "StrongPassword123!",
            "display_name": peer.display_name,
            "public_key": peer.public_key_str,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    peer.access_token = body["access_token"]
    peer.user_id = body["user"]["id"]
    peer.global_id = body["user"]["global_id"]


def _headers(peer: SimulatedGroupPeer) -> dict[str, str]:
    return {"Authorization": f"Bearer {peer.access_token}"}


async def _distribute_sender_key(
    client: AsyncClient,
    sender: SimulatedGroupPeer,
    group_id: str,
    key_version: int,
    roster: list[SimulatedGroupPeer],
) -> bytes:
    sender_key = os.urandom(32)
    envelopes = []
    for member in roster:
        wrapped, nonce = sender.wrap_sender_key_for(
            group_id, key_version, member.public_key_str, sender_key
        )
        envelopes.append(
            {
                "recipient_id": member.user_id,
                "wrapped_key": wrapped,
                "nonce": nonce,
            }
        )
    resp = await client.post(
        f"/groups/{group_id}/keys",
        headers=_headers(sender),
        json={"key_version": key_version, "keys": envelopes},
    )
    assert resp.status_code == 200, resp.text
    return sender_key


async def _recv_frames_until(
    ws: Any, predicate: Any, max_frames: int = 30, timeout: float = 4.0
) -> list[dict[str, Any]]:
    collected: list[dict[str, Any]] = []
    for _ in range(max_frames):
        raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
        pkt = dict(json.loads(raw))
        collected.append(pkt)
        if predicate(collected, pkt):
            return collected
    raise AssertionError(f"Predicate not satisfied within {max_frames} frames: {collected}")


@pytest.mark.asyncio
async def test_three_plus_users_group_e2ee_ws_fanout_mentions_and_read_by_list(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, ws_base = live_node
    rahul = SimulatedGroupPeer("rahul", "Rahul")
    priya = SimulatedGroupPeer("priya", "Priya")
    amit = SimulatedGroupPeer("amit", "Amit")
    for p in (rahul, priya, amit):
        await _signup(client, p)

    async with AsyncExitStack() as stack:
        ws_rahul = await stack.enter_async_context(
            websockets.connect(f"{ws_base}/ws?token={rahul.access_token}")
        )
        await _recv_frames_until(ws_rahul, lambda _, p: p.get("event") == "session.ready")

        ws_priya = await stack.enter_async_context(
            websockets.connect(f"{ws_base}/ws?token={priya.access_token}")
        )
        await _recv_frames_until(ws_priya, lambda _, p: p.get("event") == "session.ready")

        ws_amit = await stack.enter_async_context(
            websockets.connect(f"{ws_base}/ws?token={amit.access_token}")
        )
        await _recv_frames_until(ws_amit, lambda _, p: p.get("event") == "session.ready")

        # 1. Rahul creates a group with Priya, then adds Amit via POST /groups/{id}/members
        create_res = await client.post(
            "/groups",
            headers=_headers(rahul),
            json={
                "name": "Jaipur Builders",
                "description": "Decentralized RelayChat builders",
                "member_ids": [priya.user_id],
            },
        )
        assert create_res.status_code == 201, create_res.text
        group = create_res.json()
        group_id = group["id"]
        assert group["key_version"] == 1
        assert group["member_count"] == 2
        assert group["my_role"] == "admin"

        # Rahul adds Amit -> key_version rotates to 2 and emits "Rahul added Amit"!
        add_res = await client.post(
            f"/groups/{group_id}/members",
            headers=_headers(rahul),
            json={"member_ids": [amit.user_id]},
        )
        assert add_res.status_code == 200, add_res.text
        group = add_res.json()
        assert group["key_version"] == 2
        assert group["member_count"] == 3

        # Upload a 1x1 PNG group icon
        png_1x1 = base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        )
        icon_res = await client.post(
            f"/groups/{group_id}/icon",
            headers=_headers(rahul),
            files={"file": ("icon.png", png_1x1, "image/png")},
        )
        assert icon_res.status_code == 200, icon_res.text
        assert icon_res.json()["icon_url"].startswith("/api/v1/media/avatars/grp_")

        # Verify system messages ("Rahul created group...", "Rahul added Amit")
        hist = await client.get(
            f"/conversations/{group_id}/messages", headers=_headers(priya)
        )
        assert hist.status_code == 200
        sys_texts = [
            m["system_event"]["text"]
            for m in hist.json()["items"]
            if m["type"] == "system" and m.get("system_event")
        ]
        assert any("Rahul created group" in t for t in sys_texts)
        assert any("Rahul added Amit" in t for t in sys_texts)

        # 2. Rahul distributes his v2 Sender Key wrapped via pairwise ECDH for all 3 members
        rahul_sk_v2 = await _distribute_sender_key(
            client, rahul, group_id, 2, [rahul, priya, amit]
        )

        # 3. Rahul sends an E2EE group message over WebSocket mentioning @priya
        secret_text = "Hey @priya and team, launch is live at 18:00 IST!"
        ct_b64, nonce_b64 = rahul.encrypt_group_msg(
            group_id, rahul.user_id, 2, rahul_sk_v2, secret_text
        )
        await ws_rahul.send(
            json.dumps(
                {
                    "event": "message.send",
                    "data": {
                        "conversation_id": group_id,
                        "ciphertext": ct_b64,
                        "nonce": nonce_b64,
                        "type": "text",
                        "sender_key_version": 2,
                        "mentions": [priya.user_id],
                        "client_msg_id": "cmsg-grp-001",
                    },
                }
            )
        )

        # Priya receives BOTH message.new (with sender_display_name + sender_color) AND group.mention!
        priya_frames = await _recv_frames_until(
            ws_priya,
            lambda all_f, _: (
                any(
                    f.get("event") == "message.new"
                    and f.get("data", {}).get("client_msg_id") == "cmsg-grp-001"
                    for f in all_f
                )
                and any(f.get("event") == "group.mention" for f in all_f)
            ),
        )
        priya_msg = next(
            f["data"]
            for f in priya_frames
            if f.get("event") == "message.new"
            and f.get("data", {}).get("client_msg_id") == "cmsg-grp-001"
        )
        assert priya_msg["sender_display_name"] == "Rahul"
        assert priya_msg["sender_color"].startswith("#")
        assert priya_msg["mentions"] == [priya.user_id]
        msg_id = priya_msg["id"]

        # Amit also receives message.new over WS fan-out
        amit_frames = await _recv_frames_until(
            ws_amit,
            lambda _, p: p.get("event") == "message.new"
            and p.get("data", {}).get("id") == msg_id,
        )
        amit_msg = amit_frames[-1]["data"]

        # Both Priya and Amit fetch & unwrap Rahul's v2 Sender Key and decrypt the message
        for member, wire_msg in ((priya, priya_msg), (amit, amit_msg)):
            keys_res = await client.get(
                f"/groups/{group_id}/keys?key_version=2&sender_id={rahul.user_id}",
                headers=_headers(member),
            )
            assert keys_res.status_code == 200
            wrapped_row = keys_res.json()[0]
            unwrapped_sk = member.unwrap_sender_key_from(
                group_id,
                2,
                wrapped_row["sender_public_key"],
                wrapped_row["wrapped_key"],
                wrapped_row["nonce"],
            )
            assert unwrapped_sk == rahul_sk_v2
            decrypted_text = member.decrypt_group_msg(
                group_id,
                rahul.user_id,
                2,
                unwrapped_sk,
                wire_msg["ciphertext"],
                wire_msg["nonce"],
            )
            assert decrypted_text == secret_text

        # Verify DB stores ciphertext ONLY (zero plaintext or raw sender key in DB)
        async with AsyncSessionLocal() as db:
            db_msg = (await db.execute(select(Message).where(Message.id == msg_id))).scalar_one()
            assert "launch is live" not in db_msg.ciphertext

        # 4. Per-member delivery & read receipts + Read-By list per message!
        # Priya marks delivered, Amit marks read -> aggregate status is still 'delivered' until ALL read
        await ws_priya.send(
            json.dumps(
                {
                    "event": "message.ack",
                    "data": {
                        "conversation_id": group_id,
                        "message_ids": [msg_id],
                        "status": "delivered",
                    },
                }
            )
        )
        await ws_amit.send(
            json.dumps(
                {
                    "event": "message.ack",
                    "data": {
                        "conversation_id": group_id,
                        "message_ids": [msg_id],
                        "status": "read",
                    },
                }
            )
        )
        await _recv_frames_until(
            ws_rahul,
            lambda _, p: p.get("event") == "message.ack"
            and len(p.get("data", {}).get("read_by", [])) == 1,
        )

        # Now Priya also reads -> aggregate status transitions to 'read' and read_by has BOTH Priya & Amit!
        await ws_priya.send(
            json.dumps(
                {
                    "event": "message.ack",
                    "data": {
                        "conversation_id": group_id,
                        "message_ids": [msg_id],
                        "status": "read",
                    },
                }
            )
        )
        final_ack_frames = await _recv_frames_until(
            ws_rahul,
            lambda _, p: p.get("event") == "message.ack"
            and p.get("data", {}).get("status") == "read"
            and len(p.get("data", {}).get("read_by", [])) == 2,
        )
        assert final_ack_frames[-1]["data"]["status"] == "read"

        receipts_res = await client.get(
            f"/messages/{msg_id}/receipts", headers=_headers(rahul)
        )
        assert receipts_res.status_code == 200
        receipt_body = receipts_res.json()
        read_ids = {r["user_id"] for r in receipt_body["read_by"]}
        assert read_ids == {priya.user_id, amit.user_id}


@pytest.mark.asyncio
async def test_key_rotation_after_member_removal_blocks_removed_user_completely(
    live_node: tuple[AsyncClient, str],
) -> None:
    """Acceptance test: Removed member CANNOT read or decrypt new group messages after key rotation."""
    client, ws_base = live_node
    rahul = SimulatedGroupPeer("rahul2", "Rahul")
    priya = SimulatedGroupPeer("priya2", "Priya")
    amit = SimulatedGroupPeer("amit2", "Amit")
    for p in (rahul, priya, amit):
        await _signup(client, p)

    # Create 3-member group at key_version 1
    grp_res = await client.post(
        "/groups",
        headers=_headers(rahul),
        json={"name": "Core Security Team", "member_ids": [priya.user_id, amit.user_id]},
    )
    assert grp_res.status_code == 201
    group_id = grp_res.json()["id"]

    # Distribute v1 Sender Key to all 3 members & verify Amit CAN decrypt v1 message
    rahul_sk_v1 = await _distribute_sender_key(
        client, rahul, group_id, 1, [rahul, priya, amit]
    )
    amit_v1_rows = (
        await client.get(f"/groups/{group_id}/keys?key_version=1", headers=_headers(amit))
    ).json()
    amit_cached_sk_v1 = amit.unwrap_sender_key_from(
        group_id,
        1,
        amit_v1_rows[0]["sender_public_key"],
        amit_v1_rows[0]["wrapped_key"],
        amit_v1_rows[0]["nonce"],
    )

    ct1, n1 = rahul.encrypt_group_msg(group_id, rahul.user_id, 1, rahul_sk_v1, "Hello in v1")
    m1_res = await client.post(
        "/messages",
        headers=_headers(rahul),
        json={
            "conversation_id": group_id,
            "ciphertext": ct1,
            "nonce": n1,
            "type": "text",
            "sender_key_version": 1,
        },
    )
    assert m1_res.status_code == 201
    assert (
        amit.decrypt_group_msg(group_id, rahul.user_id, 1, amit_cached_sk_v1, ct1, n1)
        == "Hello in v1"
    )

    # --- REMOVE AMIT FROM THE GROUP ---
    rem_res = await client.delete(
        f"/groups/{group_id}/members/{amit.user_id}", headers=_headers(rahul)
    )
    assert rem_res.status_code == 200, rem_res.text
    rotated_grp = rem_res.json()
    assert rotated_grp["key_version"] == 2
    assert rotated_grp["member_count"] == 2
    assert all(m["user_id"] != amit.user_id for m in rotated_grp["members"])

    # Server MUST reject any attempt by Rahul to send a new message with stale v1 key_version!
    stale_ct, stale_n = rahul.encrypt_group_msg(
        group_id, rahul.user_id, 1, rahul_sk_v1, "Stale v1 attempt"
    )
    stale_send = await client.post(
        "/messages",
        headers=_headers(rahul),
        json={
            "conversation_id": group_id,
            "ciphertext": stale_ct,
            "nonce": stale_n,
            "type": "text",
            "sender_key_version": 1,
        },
    )
    assert stale_send.status_code == 409
    assert stale_send.json()["error"]["code"] == "STALE_GROUP_KEY_VERSION"

    # Server MUST also reject wrapping a v2 key for removed Amit!
    bad_wrap, bad_nonce = rahul.wrap_sender_key_for(
        group_id, 2, amit.public_key_str, os.urandom(32)
    )
    bad_dist = await client.post(
        f"/groups/{group_id}/keys",
        headers=_headers(rahul),
        json={
            "key_version": 2,
            "keys": [{"recipient_id": amit.user_id, "wrapped_key": bad_wrap, "nonce": bad_nonce}],
        },
    )
    assert bad_dist.status_code == 400

    # Rahul rotates & distributes a brand-new v2 Sender Key ONLY for Rahul and Priya
    rahul_sk_v2 = await _distribute_sender_key(
        client, rahul, group_id, 2, [rahul, priya]
    )
    assert rahul_sk_v2 != rahul_sk_v1

    # Rahul sends a new v2 confidential message
    secret_v2_plain = "Post-removal v2 launch credentials: TOP-SECRET-99"
    ct2, n2 = rahul.encrypt_group_msg(
        group_id, rahul.user_id, 2, rahul_sk_v2, secret_v2_plain
    )
    m2_res = await client.post(
        "/messages",
        headers=_headers(rahul),
        json={
            "conversation_id": group_id,
            "ciphertext": ct2,
            "nonce": n2,
            "type": "text",
            "sender_key_version": 2,
        },
    )
    assert m2_res.status_code == 201

    # Remaining member Priya unwraps v2 and decrypts cleanly
    priya_v2_rows = (
        await client.get(f"/groups/{group_id}/keys?key_version=2", headers=_headers(priya))
    ).json()
    assert len(priya_v2_rows) == 1
    priya_sk_v2 = priya.unwrap_sender_key_from(
        group_id,
        2,
        priya_v2_rows[0]["sender_public_key"],
        priya_v2_rows[0]["wrapped_key"],
        priya_v2_rows[0]["nonce"],
    )
    assert (
        priya.decrypt_group_msg(group_id, rahul.user_id, 2, priya_sk_v2, ct2, n2)
        == secret_v2_plain
    )

    # Removed member Amit is blocked at EVERY API boundary...
    assert (
        await client.get(f"/groups/{group_id}/keys?key_version=2", headers=_headers(amit))
    ).status_code == 403
    assert (
        await client.get(f"/conversations/{group_id}/messages", headers=_headers(amit))
    ).status_code == 403
    assert (
        await client.post(
            "/messages",
            headers=_headers(amit),
            json={
                "conversation_id": group_id,
                "ciphertext": ct2,
                "nonce": n2,
                "type": "text",
                "sender_key_version": 2,
            },
        )
    ).status_code == 403

    # ...AND even if Amit intercepts raw network/DB packets, he CANNOT decrypt ct2 with v1 OR unwrap Priya's v2 key!
    with pytest.raises(InvalidTag):
        amit.decrypt_group_msg(group_id, rahul.user_id, 2, amit_cached_sk_v1, ct2, n2)

    async with AsyncSessionLocal() as db:
        priya_db_key = (
            await db.execute(
                select(GroupKey).where(
                    GroupKey.conversation_id == group_id,
                    GroupKey.key_version == 2,
                    GroupKey.recipient_id == priya.user_id,
                )
            )
        ).scalar_one()
        with pytest.raises(InvalidTag):
            amit.unwrap_sender_key_from(
                group_id,
                2,
                rahul.public_key_str,
                priya_db_key.wrapped_key,
                priya_db_key.nonce,
            )


@pytest.mark.asyncio
async def test_admin_roles_only_admins_can_send_edit_info_mute_and_leave(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, _ = live_node
    rahul = SimulatedGroupPeer("rahul3", "Rahul")
    priya = SimulatedGroupPeer("priya3", "Priya")
    neha = SimulatedGroupPeer("neha3", "Neha")
    for p in (rahul, priya, neha):
        await _signup(client, p)

    grp_res = await client.post(
        "/groups",
        headers=_headers(rahul),
        json={
            "name": "Announcements",
            "member_ids": [priya.user_id, neha.user_id],
            "only_admins_can_edit_info": True,
            "only_admins_can_send": False,
        },
    )
    group_id = grp_res.json()["id"]

    # Non-admin Priya cannot edit group info when only_admins_can_edit_info=True
    denied_edit = await client.patch(
        f"/groups/{group_id}",
        headers=_headers(priya),
        json={"name": "Unauthorized Rename"},
    )
    assert denied_edit.status_code == 403

    # Rahul promotes Priya to admin
    promo = await client.patch(
        f"/groups/{group_id}/members/{priya.user_id}/role",
        headers=_headers(rahul),
        json={"role": "admin"},
    )
    assert promo.status_code == 200

    # Promoted admin Priya renames group AND enables "only_admins_can_send"
    ok_edit = await client.patch(
        f"/groups/{group_id}",
        headers=_headers(priya),
        json={"name": "Official Announcements", "only_admins_can_send": True},
    )
    assert ok_edit.status_code == 200
    assert ok_edit.json()["only_admins_can_send"] is True

    # Non-admin Neha is blocked from sending messages (403 ADMIN_ONLY_MESSAGES)
    neha_sk = await _distribute_sender_key(client, neha, group_id, 1, [rahul, priya, neha])
    n_ct, n_nonce = neha.encrypt_group_msg(group_id, neha.user_id, 1, neha_sk, "Can I post?")
    denied_send = await client.post(
        "/messages",
        headers=_headers(neha),
        json={
            "conversation_id": group_id,
            "ciphertext": n_ct,
            "nonce": n_nonce,
            "type": "text",
            "sender_key_version": 1,
        },
    )
    assert denied_send.status_code == 403
    assert denied_send.json()["error"]["code"] == "ADMIN_ONLY_MESSAGES"

    # Admin Priya CAN send!
    priya_sk = await _distribute_sender_key(
        client, priya, group_id, 1, [rahul, priya, neha]
    )
    p_ct, p_nonce = priya.encrypt_group_msg(
        group_id, priya.user_id, 1, priya_sk, "Admin broadcast!"
    )
    ok_send = await client.post(
        "/messages",
        headers=_headers(priya),
        json={
            "conversation_id": group_id,
            "ciphertext": p_ct,
            "nonce": p_nonce,
            "type": "text",
            "sender_key_version": 1,
        },
    )
    assert ok_send.status_code == 201

    # Mute group for Neha
    mute_res = await client.patch(
        f"/conversations/{group_id}",
        headers=_headers(neha),
        json={"is_muted": True},
    )
    assert mute_res.status_code == 200
    assert mute_res.json()["is_muted"] is True

    # Rahul demotes Priya back to member, then Rahul leaves -> Priya or Neha auto-promoted so group isn't adminless!
    await client.patch(
        f"/groups/{group_id}/members/{priya.user_id}/role",
        headers=_headers(rahul),
        json={"role": "member"},
    )
    leave_res = await client.post(f"/groups/{group_id}/leave", headers=_headers(rahul))
    assert leave_res.status_code == 200
    assert leave_res.json()["key_version"] == 2

    after_leave = (
        await client.get(f"/groups/{group_id}", headers=_headers(priya))
    ).json()
    assert after_leave["key_version"] == 2
    assert any(m["role"] == "admin" for m in after_leave["members"])


@pytest.mark.asyncio
async def test_group_invite_link_preview_join_key_rotation_and_revoke(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, _ = live_node
    rahul = SimulatedGroupPeer("rahul4", "Rahul")
    neha = SimulatedGroupPeer("neha4", "Neha")
    vikram = SimulatedGroupPeer("vikram4", "Vikram")
    for p in (rahul, neha, vikram):
        await _signup(client, p)

    grp = (
        await client.post(
            "/groups",
            headers=_headers(rahul),
            json={"name": "Open Rust + Crypto Guild", "member_ids": []},
        )
    ).json()
    group_id = grp["id"]
    first_code = grp["invite_code"]
    assert first_code

    # Neha previews invite link and joins -> key_version rotates from 1 to 2
    preview = await client.get(f"/groups/invite/{first_code}", headers=_headers(neha))
    assert preview.status_code == 200
    assert preview.json()["name"] == "Open Rust + Crypto Guild"
    assert preview.json()["already_member"] is False

    joined = await client.post(f"/groups/join/{first_code}", headers=_headers(neha))
    assert joined.status_code == 200
    assert joined.json()["key_version"] == 2
    assert joined.json()["member_count"] == 2

    # Admin Rahul revokes the invite link
    revoked = await client.post(
        f"/groups/{group_id}/invite/revoke", headers=_headers(rahul)
    )
    assert revoked.status_code == 200
    new_code = revoked.json()["invite_code"]
    assert new_code != first_code

    # Vikram CANNOT join using the revoked invite link (404 INVITE_INVALID_OR_REVOKED)
    fail_join = await client.post(f"/groups/join/{first_code}", headers=_headers(vikram))
    assert fail_join.status_code == 404
    assert fail_join.json()["error"]["code"] == "INVITE_INVALID_OR_REVOKED"

    # Vikram CAN join using the freshly rotated invite code -> key_version becomes 3
    ok_join = await client.post(f"/groups/join/{new_code}", headers=_headers(vikram))
    assert ok_join.status_code == 200
    assert ok_join.json()["key_version"] == 3
    assert ok_join.json()["member_count"] == 3
