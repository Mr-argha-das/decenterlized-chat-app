import asyncio
import base64
import json
import os
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncGenerator

import pytest
import pytest_asyncio
import uvicorn
import websockets
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.hkdf import HKDF
from httpx import AsyncClient
from sqlalchemy import inspect, select, text as sql_text

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_phase1.db"
os.environ["APP_NAME"] = "RelayChat"
os.environ["APP_DOMAIN"] = "chatapp.in"
os.environ["NODE_KEY_PATH"] = "./.node_keys/test_node_ed25519.json"

from app.core.rate_limit import rate_limiter  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.session import AsyncSessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.entities import Message, MessageReceipt  # noqa: E402


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


class SimulatedE2eePeer:
    """Simulated browser client implementing ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM."""

    def __init__(self, username: str) -> None:
        self.username = username
        self.priv = ec.generate_private_key(ec.SECP256R1())
        nums = self.priv.private_numbers()
        pub = nums.public_numbers
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

    def _derive_aes_key(self, peer_pub_json: str) -> AESGCM:
        peer_jwk = json.loads(peer_pub_json)
        px = self._from_b64u(peer_jwk["x"])
        py = self._from_b64u(peer_jwk["y"])
        peer_pub_key = ec.EllipticCurvePublicNumbers(px, py, ec.SECP256R1()).public_key()

        shared_secret = self.priv.exchange(ec.ECDH(), peer_pub_key)
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

    def encrypt_for(self, peer_pub_json: str, plaintext: str) -> tuple[str, str]:
        aes = self._derive_aes_key(peer_pub_json)
        nonce = os.urandom(12)
        envelope = json.dumps({"v": 1, "text": plaintext}).encode("utf-8")
        ct = aes.encrypt(nonce, envelope, None)
        return (
            base64.b64encode(ct).decode("ascii"),
            base64.b64encode(nonce).decode("ascii"),
        )

    def decrypt_from(self, peer_pub_json: str, ciphertext_b64: str, nonce_b64: str) -> str:
        aes = self._derive_aes_key(peer_pub_json)
        ct = base64.b64decode(ciphertext_b64)
        nonce = base64.b64decode(nonce_b64)
        raw = aes.decrypt(nonce, ct, None)
        return str(json.loads(raw.decode("utf-8"))["text"])


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


async def _signup_peer(client: AsyncClient, peer: SimulatedE2eePeer) -> None:
    resp = await client.post(
        "/auth/signup",
        json={
            "username": peer.username,
            "password": "StrongPassword123!",
            "display_name": peer.username.capitalize(),
            "public_key": peer.public_key_str,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    peer.access_token = body["access_token"]
    peer.user_id = body["user"]["id"]
    peer.global_id = body["user"]["global_id"]


async def _recv_json(ws: Any) -> dict[str, Any]:
    raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
    return dict(json.loads(raw))


async def _recv_until(ws: Any, target_event: str, max_frames: int = 8) -> dict[str, Any]:
    for _ in range(max_frames):
        pkt = await _recv_json(ws)
        if pkt.get("event") == target_event:
            return pkt
    raise AssertionError(f"Did not receive expected event '{target_event}'")


async def _send_json(ws: Any, payload: dict[str, Any]) -> None:
    await ws.send(json.dumps(payload))


@pytest.mark.asyncio
async def test_two_simulated_clients_realtime_ws_e2ee_ticks_typing_and_db_ciphertext_only(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, ws_base = live_node
    alice = SimulatedE2eePeer("alice_p3")
    bob = SimulatedE2eePeer("bob_p3")
    await _signup_peer(client, alice)
    await _signup_peer(client, bob)

    # Alice opens a 1:1 conversation with Bob
    conv_resp = await client.post(
        "/conversations",
        headers={"X-RelayChat-Token": alice.access_token},
        json={"peer_username": "bob_p3"},
    )
    assert conv_resp.status_code == 201, conv_resp.text
    conv_id = conv_resp.json()["id"]
    bob_pub_from_server = conv_resp.json()["peer"]["public_key"]
    assert bob_pub_from_server == bob.public_key_str

    secret_text = "Top-Secret Rendezvous at Nahargarh Fort 19:45 — Eyes Only!"

    async with websockets.connect(f"{ws_base}/ws?token={alice.access_token}") as ws_alice:
        ready_a = await _recv_json(ws_alice)
        assert ready_a["event"] == "session.ready"

        async with websockets.connect(f"{ws_base}/ws?token={bob.access_token}") as ws_bob:
            ready_b = await _recv_json(ws_bob)
            assert ready_b["event"] == "session.ready"

            # Alice receives live presence.online when Bob connects
            pres_on = await _recv_until(ws_alice, "presence.online")
            assert pres_on["data"]["user_id"] == bob.user_id
            assert pres_on["data"]["is_online"] is True

            # Bob starts typing -> Alice receives typing.start and typing.stop
            await _send_json(
                ws_bob, {"event": "typing.start", "data": {"conversation_id": conv_id}}
            )
            t_start = await _recv_until(ws_alice, "typing.start")
            assert t_start["data"]["conversation_id"] == conv_id
            assert t_start["data"]["user_id"] == bob.user_id

            await _send_json(
                ws_bob, {"event": "typing.stop", "data": {"conversation_id": conv_id}}
            )
            t_stop = await _recv_until(ws_alice, "typing.stop")
            assert t_stop["data"]["conversation_id"] == conv_id

            # Alice encrypts message client-side and sends over WebSocket
            ciphertext, nonce = alice.encrypt_for(bob_pub_from_server, secret_text)
            await _send_json(
                ws_alice,
                {
                    "event": "message.send",
                    "data": {
                        "conversation_id": conv_id,
                        "ciphertext": ciphertext,
                        "nonce": nonce,
                        "type": "text",
                        "client_msg_id": "client-optimistic-1",
                    },
                },
            )

            # 1. Alice gets immediate `sent` ack matching her optimistic `client_msg_id`
            sent_ack = await _recv_until(ws_alice, "message.ack")
            assert sent_ack["data"]["status"] == "sent"
            assert sent_ack["data"]["client_msg_id"] == "client-optimistic-1"
            msg_id = sent_ack["data"]["message_id"]

            # 2. Bob receives `message.new` in realtime and decrypts with his private key
            incoming = await _recv_until(ws_bob, "message.new")
            assert incoming["data"]["id"] == msg_id
            decrypted = bob.decrypt_from(
                alice.public_key_str,
                incoming["data"]["ciphertext"],
                incoming["data"]["nonce"],
            )
            assert decrypted == secret_text

            # 3. Bob acknowledges `delivered` -> Alice's tick upgrades to `delivered`
            await _send_json(
                ws_bob,
                {
                    "event": "message.ack",
                    "data": {
                        "conversation_id": conv_id,
                        "message_ids": [msg_id],
                        "status": "delivered",
                    },
                },
            )
            deliv_ack = await _recv_until(ws_alice, "message.ack")
            assert deliv_ack["data"]["message_id"] == msg_id
            assert deliv_ack["data"]["status"] == "delivered"

            # 4. Bob opens chat & acknowledges `read` -> Alice's tick upgrades to `read`
            await _send_json(
                ws_bob,
                {
                    "event": "message.ack",
                    "data": {
                        "conversation_id": conv_id,
                        "message_ids": [msg_id],
                        "status": "read",
                    },
                },
            )
            read_ack = await _recv_until(ws_alice, "message.ack")
            assert read_ack["data"]["message_id"] == msg_id
            assert read_ack["data"]["status"] == "read"
            assert read_ack["data"]["read_at"] is not None

        # When Bob's WebSocket closes, Alice receives `presence.offline`
        pres_off = await _recv_until(ws_alice, "presence.offline")
        assert pres_off["data"]["user_id"] == bob.user_id
        assert pres_off["data"]["is_online"] is False

    # 5. Direct SQL inspection: verify DB contains ONLY ciphertext and zero plaintext!
    async with engine.connect() as conn:
        cols = await conn.run_sync(
            lambda sync_conn: [c["name"] for c in inspect(sync_conn).get_columns("messages")]
        )
        assert "plaintext" not in cols
        assert "text" not in cols
        assert "body" not in cols

        row = (
            await conn.execute(
                sql_text("SELECT ciphertext, nonce, status FROM messages WHERE id = :mid"),
                {"mid": msg_id},
            )
        ).one()
        stored_ct, stored_nonce, stored_status = row
        assert stored_status == "read"
        assert "Nahargarh" not in stored_ct
        assert "Top-Secret" not in stored_ct
        assert len(base64.b64decode(stored_nonce)) == 12

    async with AsyncSessionLocal() as db:
        rcpt = (
            await db.execute(
                select(MessageReceipt).where(
                    MessageReceipt.message_id == msg_id,
                    MessageReceipt.user_id == bob.user_id,
                )
            )
        ).scalar_one()
        assert rcpt.delivered_at is not None
        assert rcpt.read_at is not None


@pytest.mark.asyncio
async def test_offline_message_queue_and_delivery_on_reconnect(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, ws_base = live_node
    alice = SimulatedE2eePeer("alice_off")
    bob = SimulatedE2eePeer("bob_off")
    await _signup_peer(client, alice)
    await _signup_peer(client, bob)

    conv_resp = await client.post(
        "/conversations",
        headers={"Authorization": f"Bearer {alice.access_token}"},
        json={"peer_username": "bob_off"},
    )
    conv_id = conv_resp.json()["id"]

    offline_plaintexts = [
        "Offline message #1 while Bob is away",
        "Offline message #2 queued in DB",
        "Offline message #3 awaiting reconnect",
    ]

    async with websockets.connect(f"{ws_base}/ws?token={alice.access_token}") as ws_alice:
        assert (await _recv_json(ws_alice))["event"] == "session.ready"

        sent_ids: list[str] = []
        for idx, pt in enumerate(offline_plaintexts):
            ct, nonce = alice.encrypt_for(bob.public_key_str, pt)
            if idx == 0:
                # Test REST POST /messages fallback for message #1
                r = await client.post(
                    "/messages",
                    headers={"X-RelayChat-Token": alice.access_token},
                    json={
                        "conversation_id": conv_id,
                        "ciphertext": ct,
                        "nonce": nonce,
                        "type": "text",
                    },
                )
                assert r.status_code == 201
                sent_ids.append(r.json()["id"])
                await _recv_until(ws_alice, "message.new")
            else:
                await _send_json(
                    ws_alice,
                    {
                        "event": "message.send",
                        "data": {
                            "conversation_id": conv_id,
                            "ciphertext": ct,
                            "nonce": nonce,
                            "type": "text",
                        },
                    },
                )
                ack = await _recv_until(ws_alice, "message.ack")
                assert ack["data"]["status"] == "sent"
                sent_ids.append(ack["data"]["message_id"])

        # Verify Bob's unread count is 3 while still offline
        bob_convs = (
            await client.get(
                "/conversations",
                headers={"X-RelayChat-Token": bob.access_token},
            )
        ).json()
        assert bob_convs[0]["unread_count"] == 3
        assert bob_convs[0]["last_message"]["status"] == "sent"

        # Now Bob connects to /ws -> queued messages flush immediately & Alice gets `delivered` acks!
        async with websockets.connect(f"{ws_base}/ws?token={bob.access_token}") as ws_bob:
            assert (await _recv_json(ws_bob))["event"] == "session.ready"
            delivered_texts: list[str] = []
            for expected_id in sent_ids:
                pkt = await _recv_until(ws_bob, "message.new")
                assert pkt["data"]["id"] == expected_id
                assert pkt["data"]["status"] == "delivered"
                delivered_texts.append(
                    bob.decrypt_from(
                        alice.public_key_str,
                        pkt["data"]["ciphertext"],
                        pkt["data"]["nonce"],
                    )
                )
            assert delivered_texts == offline_plaintexts

            alice_delivered_ids: set[str] = set()
            while len(alice_delivered_ids) < 3:
                pkt = await _recv_json(ws_alice)
                if pkt.get("event") == "message.ack" and pkt["data"].get("status") == "delivered":
                    alice_delivered_ids.add(pkt["data"]["message_id"])
            assert alice_delivered_ids == set(sent_ids)


@pytest.mark.asyncio
async def test_cursor_pagination_edit_15min_window_and_delete_scopes(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, _ = live_node
    alice = SimulatedE2eePeer("alice_rest")
    bob = SimulatedE2eePeer("bob_rest")
    await _signup_peer(client, alice)
    await _signup_peer(client, bob)

    conv_id = (
        await client.post(
            "/conversations",
            headers={"X-RelayChat-Token": alice.access_token},
            json={"peer_username": "bob_rest"},
        )
    ).json()["id"]

    created_ids: list[str] = []
    for i in range(12):
        ct, nonce = alice.encrypt_for(bob.public_key_str, f"Message #{i:02d}")
        res = await client.post(
            "/messages",
            headers={"X-RelayChat-Token": alice.access_token},
            json={
                "conversation_id": conv_id,
                "ciphertext": ct,
                "nonce": nonce,
                "type": "text",
                "reply_to_id": created_ids[-1] if created_ids else None,
            },
        )
        assert res.status_code == 201
        created_ids.append(res.json()["id"])

    # 1. Walk cursor pagination backwards (5 + 5 + 2 = 12 messages)
    collected: list[str] = []
    cursor: str | None = None
    pages = 0
    while True:
        url = f"/conversations/{conv_id}/messages?limit=5"
        if cursor:
            url += f"&cursor={cursor}"
        page = (
            await client.get(url, headers={"X-RelayChat-Token": bob.access_token})
        ).json()
        pages += 1
        page_ids = [m["id"] for m in page["items"]]
        collected = page_ids + collected
        if not page["has_more"]:
            break
        cursor = page["next_cursor"]

    assert pages == 3
    assert collected == created_ids

    # 2. Edit within 15 minutes succeeds
    target_edit_id = created_ids[-1]
    new_ct, new_nonce = alice.encrypt_for(bob.public_key_str, "Edited Message #11")
    edit_ok = await client.patch(
        f"/messages/{target_edit_id}",
        headers={"X-RelayChat-Token": alice.access_token},
        json={"ciphertext": new_ct, "nonce": new_nonce},
    )
    assert edit_ok.status_code == 200
    assert edit_ok.json()["edited_at"] is not None
    assert (
        bob.decrypt_from(
            alice.public_key_str,
            edit_ok.json()["ciphertext"],
            edit_ok.json()["nonce"],
        )
        == "Edited Message #11"
    )

    # 3. Edit after 15 minutes fails with 400 EDIT_WINDOW_EXPIRED
    expired_id = created_ids[0]
    async with AsyncSessionLocal() as db:
        m = (await db.execute(select(Message).where(Message.id == expired_id))).scalar_one()
        m.created_at = datetime.now(timezone.utc) - timedelta(minutes=16)
        await db.commit()

    edit_expired = await client.patch(
        f"/messages/{expired_id}",
        headers={"X-RelayChat-Token": alice.access_token},
        json={"ciphertext": new_ct, "nonce": new_nonce},
    )
    assert edit_expired.status_code == 400
    assert edit_expired.json()["error"]["code"] == "EDIT_WINDOW_EXPIRED"

    # 4. Delete for me -> hidden for Alice, still returned for Bob
    del_me_id = created_ids[1]
    del_me = await client.delete(
        f"/messages/{del_me_id}?scope=me",
        headers={"X-RelayChat-Token": alice.access_token},
    )
    assert del_me.status_code == 200

    alice_msgs = (
        await client.get(
            f"/conversations/{conv_id}/messages?limit=20",
            headers={"X-RelayChat-Token": alice.access_token},
        )
    ).json()["items"]
    bob_msgs = (
        await client.get(
            f"/conversations/{conv_id}/messages?limit=20",
            headers={"X-RelayChat-Token": bob.access_token},
        )
    ).json()["items"]
    assert all(m["id"] != del_me_id for m in alice_msgs)
    assert any(m["id"] == del_me_id for m in bob_msgs)

    # 5. Delete for everyone -> wipes ciphertext & sets deleted_for_everyone + deleted_at
    del_all_id = created_ids[2]
    del_all = await client.delete(
        f"/messages/{del_all_id}?scope=everyone",
        headers={"X-RelayChat-Token": alice.access_token},
    )
    assert del_all.status_code == 200
    assert del_all.json()["deleted_for_everyone"] is True
    assert del_all.json()["deleted_at"] is not None
    assert del_all.json()["ciphertext"] == ""
