import asyncio
import json
import os
import socket
from typing import Any, AsyncGenerator

import pytest
import pytest_asyncio
import uvicorn
import websockets
from httpx import AsyncClient

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_phase1.db"
os.environ["APP_NAME"] = "RelayChat"
os.environ["APP_DOMAIN"] = "chatapp.in"
os.environ["NODE_KEY_PATH"] = "./.node_keys/test_node_ed25519.json"

from app.core.errors import AppError  # noqa: E402
from app.core.rate_limit import rate_limiter  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.session import engine  # noqa: E402
from app.main import app  # noqa: E402
from app.services.federation_hook import register_federation_resolver  # noqa: E402
from tests.test_phase3_realtime_e2ee_chat import SimulatedE2eePeer  # noqa: E402


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@pytest_asyncio.fixture()
async def live_node() -> AsyncGenerator[tuple[AsyncClient, str], None]:
    rate_limiter.reset()
    register_federation_resolver(None)
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

    register_federation_resolver(None)
    server.should_exit = True
    await task
    await engine.dispose()


async def _register_peer(
    client: AsyncClient, username: str, display_name: str
) -> SimulatedE2eePeer:
    peer = SimulatedE2eePeer(username)
    resp = await client.post(
        "/auth/signup",
        json={
            "username": username,
            "password": "StrongPassword123!",
            "display_name": display_name,
            "public_key": peer.public_key_str,
            "device_name": f"{display_name} Browser",
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    peer.access_token = body["access_token"]
    peer.user_id = body["user"]["id"]
    peer.global_id = body["user"]["global_id"]
    return peer


def _auth(peer: SimulatedE2eePeer) -> dict[str, str]:
    return {"Authorization": f"Bearer {peer.access_token}"}


async def _recv_until(ws: Any, target_event: str, timeout: float = 3.0) -> dict[str, Any]:
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = deadline - asyncio.get_event_loop().time()
        if remaining <= 0:
            raise TimeoutError(f"Did not receive WS event '{target_event}' within {timeout}s")
        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        pkt = json.loads(raw)
        if pkt.get("event") == target_event:
            return pkt


@pytest.mark.asyncio
async def test_contacts_add_by_full_id_qr_uri_and_federation_hook(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, _ = live_node
    alice = await _register_peer(client, "alice", "Alice Verma")
    bob = await _register_peer(client, "bob", "Bob Nair")
    carol = await _register_peer(client, "carol", "Carol Iyer")

    # 1. Add Bob by full ID (username@domain) with a custom nickname
    add_bob = await client.post(
        "/contacts",
        headers=_auth(alice),
        json={"identifier": "bob@chatapp.in", "nickname": "Bobby (Ops)"},
    )
    assert add_bob.status_code == 201, add_bob.text
    bob_contact = add_bob.json()
    assert bob_contact["contact_user_id"] == bob.user_id
    assert bob_contact["nickname"] == "Bobby (Ops)"
    assert bob_contact["user"]["effective_name"] == "Bobby (Ops)"
    assert bob_contact["user"]["is_contact"] is True

    # 2. Add Carol via scanned QR URI (`relaychat:carol@chatapp.in`)
    add_carol = await client.post(
        "/contacts",
        headers=_auth(alice),
        json={"identifier": "relaychat:carol@chatapp.in"},
    )
    assert add_carol.status_code == 201, add_carol.text
    assert add_carol.json()["contact_user_id"] == carol.user_id

    # 3. Verify GET /contacts returns both contacts sorted cleanly
    list_res = await client.get("/contacts", headers=_auth(alice))
    assert list_res.status_code == 200
    ids = {c["contact_user_id"] for c in list_res.json()}
    assert ids == {bob.user_id, carol.user_id}

    # 4. Update nickname & verify conversation peer reflects nickname
    conv_res = await client.post(
        "/conversations",
        headers=_auth(alice),
        json={"peer_id": bob.user_id},
    )
    assert conv_res.status_code == 201
    assert conv_res.json()["peer"]["display_name"] == "Bobby (Ops)"
    assert conv_res.json()["peer"]["raw_display_name"] == "Bob Nair"

    patch_nick = await client.patch(
        f"/contacts/{bob.user_id}",
        headers=_auth(alice),
        json={"nickname": "Bob Team Lead"},
    )
    assert patch_nick.status_code == 200
    assert patch_nick.json()["user"]["effective_name"] == "Bob Team Lead"

    # 5. Remote domain triggers Phase 8 federation lookup (unreachable .example -> 502/403, pluggable callback)
    remote_res = await client.post(
        "/contacts",
        headers=_auth(alice),
        json={"identifier": "vikram@remote-node.example"},
    )
    assert remote_res.status_code in (403, 502)

    hook_calls: list[tuple[str, str]] = []

    async def fake_federation_resolver(db: Any, u: str, d: str) -> Any:
        hook_calls.append((u, d))
        raise AppError("REMOTE_NOT_FOUND", "Remote user not found", status_code=404)

    register_federation_resolver(fake_federation_resolver)
    hooked_res = await client.post(
        "/contacts",
        headers=_auth(alice),
        json={"identifier": "vikram@remote-node.example"},
    )
    assert hooked_res.status_code == 404
    assert hook_calls == [("vikram", "remote-node.example")]

    # 6. Delete contact
    del_res = await client.delete(f"/contacts/{carol.user_id}", headers=_auth(alice))
    assert del_res.status_code == 200


@pytest.mark.asyncio
async def test_block_and_unblock_enforced_on_rest_ws_and_last_seen(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, base_ws = live_node
    alice = await _register_peer(client, "alice_blk", "Alice")
    bob = await _register_peer(client, "bob_blk", "Bob")

    # Open 1:1 conversation
    conv = (
        await client.post(
            "/conversations",
            headers=_auth(alice),
            json={"peer_id": bob.user_id},
        )
    ).json()
    conv_id = conv["id"]

    async with (
        websockets.connect(f"{base_ws}/ws?token={alice.access_token}") as ws_alice,
        websockets.connect(f"{base_ws}/ws?token={bob.access_token}") as ws_bob,
    ):
        await _recv_until(ws_alice, "session.ready")
        await _recv_until(ws_bob, "session.ready")

        # Before blocking: Bob CAN see Alice online + last_seen_at
        prof_before = await client.get(
            f"/users/profile/{alice.global_id}", headers=_auth(bob)
        )
        assert prof_before.status_code == 200
        assert prof_before.json()["is_online"] is True
        assert prof_before.json()["last_seen_at"] is not None

        # Alice blocks Bob
        blk_res = await client.post(
            "/blocks",
            headers=_auth(alice),
            json={"identifier": bob.global_id},
        )
        assert blk_res.status_code == 201, blk_res.text

        # Bob immediately receives `presence.offline` with `last_seen_at: None`!
        offline_pkt = await _recv_until(ws_bob, "presence.offline")
        assert offline_pkt["data"]["user_id"] == alice.user_id
        assert offline_pkt["data"]["last_seen_at"] is None

        # Server hides Alice's online status & last_seen_at from Bob on all profile/conversation endpoints
        prof_after = await client.get(
            f"/users/profile/{alice.global_id}", headers=_auth(bob)
        )
        assert prof_after.status_code == 200
        assert prof_after.json()["is_online"] is False
        assert prof_after.json()["last_seen_at"] is None

        bob_convs = (await client.get("/conversations", headers=_auth(bob))).json()
        assert bob_convs[0]["peer"]["is_online"] is False
        assert bob_convs[0]["peer"]["last_seen_at"] is None

        # Bob CANNOT send Alice a message via REST (`POST /messages` -> 403)
        ct, nonce = bob.encrypt_for(alice.public_key_str, "Are you there?")
        rest_send = await client.post(
            "/messages",
            headers=_auth(bob),
            json={
                "conversation_id": conv_id,
                "ciphertext": ct,
                "nonce": nonce,
                "type": "text",
            },
        )
        assert rest_send.status_code == 403

        # Bob CANNOT send Alice a message via WebSocket (`message.send` -> error frame `blocked`)
        await ws_bob.send(
            json.dumps(
                {
                    "event": "message.send",
                    "data": {
                        "conversation_id": conv_id,
                        "ciphertext": ct,
                        "nonce": nonce,
                        "type": "text",
                        "client_msg_id": "blocked-try-1",
                    },
                }
            )
        )
        err_pkt = await _recv_until(ws_bob, "error")
        assert err_pkt["data"]["code"] == "USER_BLOCKED"
        assert err_pkt["data"]["client_msg_id"] == "blocked-try-1"

        # Alice also cannot send while she has Bob blocked
        ct_a, nonce_a = alice.encrypt_for(bob.public_key_str, "Test while blocked")
        alice_send_blocked = await client.post(
            "/messages",
            headers=_auth(alice),
            json={
                "conversation_id": conv_id,
                "ciphertext": ct_a,
                "nonce": nonce_a,
                "type": "text",
            },
        )
        assert alice_send_blocked.status_code == 403

        # Unblock Bob -> messaging & last seen resume immediately
        unblk = await client.delete(f"/blocks/{bob.user_id}", headers=_auth(alice))
        assert unblk.status_code == 200

        prof_unblocked = await client.get(
            f"/users/profile/{alice.global_id}", headers=_auth(bob)
        )
        assert prof_unblocked.json()["is_online"] is True
        assert prof_unblocked.json()["last_seen_at"] is not None

        resumed_send = await client.post(
            "/messages",
            headers=_auth(bob),
            json={
                "conversation_id": conv_id,
                "ciphertext": ct,
                "nonce": nonce,
                "type": "text",
            },
        )
        assert resumed_send.status_code == 201


@pytest.mark.asyncio
async def test_server_enforces_privacy_last_seen_profile_photo_and_read_receipts(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, base_ws = live_node
    alice = await _register_peer(client, "alice_priv", "Alice Privacy")
    stranger = await _register_peer(client, "stranger_priv", "Stranger")
    friend = await _register_peer(client, "friend_priv", "Trusted Friend")

    # Alice saves `friend` in her contacts, but NOT `stranger`
    add_friend = await client.post(
        "/contacts",
        headers=_auth(alice),
        json={"identifier": friend.global_id},
    )
    assert add_friend.status_code == 201

    # Alice uploads a tiny PNG avatar
    tiny_png = (
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
        b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc`\x00\x00"
        b"\x00\x02\x00\x01\xe5'\xde\xfc\x00\x00\x00\x00IEND\xaeB`\x82"
    )
    av_res = await client.post(
        "/users/me/avatar",
        headers=_auth(alice),
        files={"file": ("avatar.png", tiny_png, "image/png")},
    )
    assert av_res.status_code == 200
    assert av_res.json()["avatar_url"] is not None

    # Open 1:1 chats with both Stranger and Friend
    conv_stranger = (
        await client.post(
            "/conversations",
            headers=_auth(stranger),
            json={"peer_id": alice.user_id},
        )
    ).json()["id"]
    conv_friend = (
        await client.post(
            "/conversations",
            headers=_auth(friend),
            json={"peer_id": alice.user_id},
        )
    ).json()["id"]

    async with (
        websockets.connect(f"{base_ws}/ws?token={alice.access_token}") as ws_alice,
        websockets.connect(f"{base_ws}/ws?token={stranger.access_token}") as ws_stranger,
        websockets.connect(f"{base_ws}/ws?token={friend.access_token}") as ws_friend,
    ):
        await _recv_until(ws_alice, "session.ready")
        await _recv_until(ws_stranger, "session.ready")
        await _recv_until(ws_friend, "session.ready")

        # ------------------------------------------------------------
        # A. PROFILE PHOTO PRIVACY (`contacts` vs `nobody`)
        # ------------------------------------------------------------
        await client.patch(
            "/users/me",
            headers=_auth(alice),
            json={"privacy_profile_photo": "contacts"},
        )
        p_friend = (
            await client.get(f"/users/profile/{alice.global_id}", headers=_auth(friend))
        ).json()
        p_stranger = (
            await client.get(f"/users/profile/{alice.global_id}", headers=_auth(stranger))
        ).json()
        wk_alice = (await client.get("/.well-known/user/alice_priv")).json()

        assert p_friend["avatar_url"] is not None
        assert p_stranger["avatar_url"] is None
        assert wk_alice["avatar_url"] is None

        await client.patch(
            "/users/me",
            headers=_auth(alice),
            json={"privacy_profile_photo": "nobody"},
        )
        p_friend_nobody = (
            await client.get(f"/users/profile/{alice.global_id}", headers=_auth(friend))
        ).json()
        assert p_friend_nobody["avatar_url"] is None

        # ------------------------------------------------------------
        # B. LAST SEEN & LIVE ONLINE PRIVACY (`contacts` vs `nobody`)
        # ------------------------------------------------------------
        await client.patch(
            "/users/me",
            headers=_auth(alice),
            json={"privacy_last_seen": "contacts"},
        )

        # Stranger immediately gets a live `presence.offline` hiding Alice's online state!
        hide_pkt = await _recv_until(ws_stranger, "presence.offline")
        assert hide_pkt["data"]["user_id"] == alice.user_id
        assert hide_pkt["data"]["last_seen_at"] is None

        ls_friend = (
            await client.get(f"/users/profile/{alice.global_id}", headers=_auth(friend))
        ).json()
        ls_stranger = (
            await client.get(f"/users/profile/{alice.global_id}", headers=_auth(stranger))
        ).json()
        assert ls_friend["is_online"] is True
        assert ls_friend["last_seen_at"] is not None
        assert ls_stranger["is_online"] is False
        assert ls_stranger["last_seen_at"] is None

        # Tighten to `nobody` -> even Friend loses Alice's last seen & online status
        await client.patch(
            "/users/me",
            headers=_auth(alice),
            json={"privacy_last_seen": "nobody"},
        )
        hide_friend_pkt = await _recv_until(ws_friend, "presence.offline")
        assert hide_friend_pkt["data"]["user_id"] == alice.user_id
        assert hide_friend_pkt["data"]["last_seen_at"] is None

        ls_friend_nobody = (
            await client.get(f"/users/profile/{alice.global_id}", headers=_auth(friend))
        ).json()
        assert ls_friend_nobody["is_online"] is False
        assert ls_friend_nobody["last_seen_at"] is None

        # ------------------------------------------------------------
        # C. READ RECEIPTS PRIVACY (`contacts` vs `nobody`)
        # ------------------------------------------------------------
        await client.patch(
            "/users/me",
            headers=_auth(alice),
            json={"privacy_read_receipts_visibility": "contacts"},
        )

        # 1) Stranger sends Alice a message; Alice acks "read" -> server clamps to "delivered"!
        ct_s, nonce_s = stranger.encrypt_for(alice.public_key_str, "Hello from stranger")
        msg_s = (
            await client.post(
                "/messages",
                headers=_auth(stranger),
                json={
                    "conversation_id": conv_stranger,
                    "ciphertext": ct_s,
                    "nonce": nonce_s,
                    "type": "text",
                },
            )
        ).json()

        ack_s = await client.post(
            f"/conversations/{conv_stranger}/ack",
            headers=_auth(alice),
            json={"status": "read", "message_ids": [msg_s["id"]]},
        )
        assert ack_s.status_code == 200
        assert ack_s.json()["acknowledged"] == 1

        ack_ws_s = await _recv_until(ws_stranger, "message.ack")
        assert ack_ws_s["data"]["message_id"] == msg_s["id"]
        assert ack_ws_s["data"]["status"] == "delivered"

        hist_stranger = (
            await client.get(
                f"/conversations/{conv_stranger}/messages",
                headers=_auth(stranger),
            )
        ).json()
        assert hist_stranger["items"][0]["status"] == "delivered"

        # 2) Trusted Friend (in Alice's contacts) sends Alice a message; Alice acks "read" -> Friend DOES get "read"!
        ct_f, nonce_f = friend.encrypt_for(alice.public_key_str, "Hello from contact")
        msg_f = (
            await client.post(
                "/messages",
                headers=_auth(friend),
                json={
                    "conversation_id": conv_friend,
                    "ciphertext": ct_f,
                    "nonce": nonce_f,
                    "type": "text",
                },
            )
        ).json()

        ack_f = await client.post(
            f"/conversations/{conv_friend}/ack",
            headers=_auth(alice),
            json={"status": "read", "message_ids": [msg_f["id"]]},
        )
        assert ack_f.status_code == 200
        assert ack_f.json()["acknowledged"] == 1

        ack_ws_f = await _recv_until(ws_friend, "message.ack")
        assert ack_ws_f["data"]["message_id"] == msg_f["id"]
        assert ack_ws_f["data"]["status"] == "read"

        # 3) Alice sets read receipts to `nobody` -> even Friend only receives "delivered"!
        await client.patch(
            "/users/me",
            headers=_auth(alice),
            json={"privacy_read_receipts_visibility": "nobody"},
        )
        ct_f2, nonce_f2 = friend.encrypt_for(alice.public_key_str, "Second message")
        msg_f2 = (
            await client.post(
                "/messages",
                headers=_auth(friend),
                json={
                    "conversation_id": conv_friend,
                    "ciphertext": ct_f2,
                    "nonce": nonce_f2,
                    "type": "text",
                },
            )
        ).json()

        ack_f2 = await client.post(
            f"/conversations/{conv_friend}/ack",
            headers=_auth(alice),
            json={"status": "read", "message_ids": [msg_f2["id"]]},
        )
        assert ack_f2.json()["acknowledged"] == 1

        hist_friend = (
            await client.get(
                f"/conversations/{conv_friend}/messages",
                headers=_auth(friend),
            )
        ).json()
        m2 = next(m for m in hist_friend["items"] if m["id"] == msg_f2["id"])
        assert m2["status"] == "delivered"


@pytest.mark.asyncio
async def test_linked_devices_logout_others_and_account_deletion(
    live_node: tuple[AsyncClient, str],
) -> None:
    client, base_ws = live_node
    dave = await _register_peer(client, "dave_dev", "Dave")

    # Log in from a second browser/device
    async with AsyncClient(base_url=str(client.base_url)) as second_browser:
        login2 = await second_browser.post(
            "/auth/login",
            json={
                "username": "dave_dev",
                "password": "StrongPassword123!",
                "device_name": "Dave Laptop #2",
            },
        )
        assert login2.status_code == 200
        token2 = login2.json()["access_token"]

        devices = (await client.get("/users/me/devices", headers=_auth(dave))).json()
        assert len(devices) == 2
        assert sum(1 for d in devices if d["is_current"]) == 1

        async with websockets.connect(f"{base_ws}/ws?token={token2}") as ws_dev2:
            await _recv_until(ws_dev2, "session.ready")

            # Log out all OTHER devices from Device #1
            revoke_res = await client.delete(
                "/users/me/devices",
                headers=_auth(dave),
            )
            assert revoke_res.status_code == 200
            assert revoke_res.json()["revoked_count"] == 1

            # Device #2's WebSocket closes with 4401 and refresh cookie fails!
            with pytest.raises(websockets.exceptions.ConnectionClosed) as exc_info:
                await asyncio.wait_for(ws_dev2.recv(), timeout=3.0)
            assert exc_info.value.rcvd is not None
            assert exc_info.value.rcvd.code == 4401

        refresh2 = await second_browser.post("/auth/refresh")
        assert refresh2.status_code == 401

    # Delete account: wrong password rejected (401), right password erases user
    bad_del = await client.request(
        "DELETE",
        "/users/me",
        headers=_auth(dave),
        json={"password": "WrongPassword!"},
    )
    assert bad_del.status_code == 401

    ok_del = await client.request(
        "DELETE",
        "/users/me",
        headers=_auth(dave),
        json={"password": "StrongPassword123!"},
    )
    assert ok_del.status_code == 200
    assert ok_del.json()["status"] == "deleted"
    assert ok_del.json()["global_id"] == dave.global_id

    gone = await client.get("/.well-known/user/dave_dev")
    assert gone.status_code == 404
