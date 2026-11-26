import asyncio
import base64
import json
import os
import shutil
import socket
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, AsyncGenerator

import pytest
import pytest_asyncio
import uvicorn
import websockets
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from httpx import AsyncClient
from sqlalchemy import select

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_phase1.db"
os.environ["APP_NAME"] = "RelayChat"
os.environ["APP_DOMAIN"] = "chatapp.in"
os.environ["NODE_KEY_PATH"] = "./.node_keys/test_node_ed25519.json"

from app.core.config import get_settings  # noqa: E402
from app.core.rate_limit import rate_limiter  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.session import AsyncSessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models.entities import Message, StatusPost  # noqa: E402
from app.services.file_scanner import QUARANTINE_TEST_TOKEN  # noqa: E402
from app.services.push_service import set_push_transport_override  # noqa: E402
from app.services.status_service import run_expiry_cleanup_once  # noqa: E402
from tests.test_phase3_realtime_e2ee_chat import SimulatedE2eePeer  # noqa: E402
from tests.test_phase5_media_voice_location import (  # noqa: E402
    client_decrypt_file_chunks,
    client_encrypt_file_chunks,
    client_encrypt_meta_bytes,
)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _headers(peer: SimulatedE2eePeer) -> dict[str, str]:
    return {"Authorization": f"Bearer {peer.access_token}"}


def _encrypt_status_for_recipients(
    author: SimulatedE2eePeer,
    payload_obj: dict[str, Any],
    recipients: list[SimulatedE2eePeer],
) -> tuple[str, str, dict[str, dict[str, Any]]]:
    """Client-side E2EE status encryption: random 256-bit content key wrapped per chosen contact."""
    content_key = os.urandom(32)
    content_iv = os.urandom(12)
    plaintext = json.dumps(payload_obj, separators=(",", ":")).encode("utf-8")
    ct = AESGCM(content_key).encrypt(
        content_iv, plaintext, b"RelayChat-StatusPayload-v1"
    )

    envelopes: dict[str, dict[str, Any]] = {}
    all_targets = {author.user_id: author}
    for r in recipients:
        all_targets[r.user_id] = r

    for uid, peer in all_targets.items():
        shared_aes = author._derive_aes_key(peer.public_key_str)
        wrap_iv = os.urandom(12)
        wrapped = shared_aes.encrypt(
            wrap_iv, content_key, f"RelayChat-StatusKey-v1|{uid}".encode("utf-8")
        )
        envelopes[uid] = {
            "wrapped_key": base64.b64encode(wrapped).decode("ascii"),
            "wrap_nonce": base64.b64encode(wrap_iv).decode("ascii"),
        }

    return (
        base64.b64encode(ct).decode("ascii"),
        base64.b64encode(content_iv).decode("ascii"),
        envelopes,
    )


def _decrypt_status_as_viewer(
    viewer: SimulatedE2eePeer,
    author_public_key_str: str,
    ciphertext_b64: str,
    nonce_b64: str,
    my_envelope: dict[str, Any],
) -> dict[str, Any]:
    shared_aes = viewer._derive_aes_key(author_public_key_str)
    content_key = shared_aes.decrypt(
        base64.b64decode(my_envelope["wrap_nonce"]),
        base64.b64decode(my_envelope["wrapped_key"]),
        f"RelayChat-StatusKey-v1|{viewer.user_id}".encode("utf-8"),
    )
    plain = AESGCM(content_key).decrypt(
        base64.b64decode(nonce_b64),
        base64.b64decode(ciphertext_b64),
        b"RelayChat-StatusPayload-v1",
    )
    return json.loads(plain.decode("utf-8"))


@pytest_asyncio.fixture
async def phase9_server(tmp_path: Path) -> AsyncGenerator[dict[str, Any], None]:
    rate_limiter.reset()
    settings = get_settings()
    orig_storage = settings.STORAGE_DIR
    orig_vapid_path = settings.VAPID_KEY_PATH
    settings.STORAGE_DIR = str(tmp_path / "storage")
    settings.VAPID_KEY_PATH = str(tmp_path / "vapid_keys.json")

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)

    port = _free_port()
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="error")
    server = uvicorn.Server(config)
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.03)

    base_url = f"http://127.0.0.1:{port}"
    ws_url = f"ws://127.0.0.1:{port}/ws"
    try:
        yield {"base_url": base_url, "ws_url": ws_url, "storage_dir": tmp_path / "storage"}
    finally:
        set_push_transport_override(None)
        server.should_exit = True
        await task
        settings.STORAGE_DIR = orig_storage
        settings.VAPID_KEY_PATH = orig_vapid_path
        shutil.rmtree(tmp_path / "storage", ignore_errors=True)


async def _signup_peer(http: AsyncClient, username: str, display_name: str) -> SimulatedE2eePeer:
    peer = SimulatedE2eePeer(username)
    resp = await http.post(
        "/auth/signup",
        json={
            "username": username,
            "password": "StrongPassword123!",
            "display_name": display_name,
            "public_key": peer.public_key_str,
        },
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    peer.access_token = body["access_token"]
    peer.user_id = body["user"]["id"]
    peer.global_id = body["user"]["global_id"]
    return peer


@pytest.mark.asyncio
async def test_24hr_statuses_privacy_views_mute_reply_and_expiry_cleanup(
    phase9_server: dict[str, Any],
) -> None:
    base_url = phase9_server["base_url"]
    ws_url = phase9_server["ws_url"]

    async with AsyncClient(base_url=base_url) as http:
        alice = await _signup_peer(http, "alice_st", "Alice Stories")
        bob = await _signup_peer(http, "bob_st", "Bob Viewer")
        carol = await _signup_peer(http, "carol_st", "Carol Excluded")

        # Alice adds Bob and Carol as contacts
        for target in (bob, carol):
            r = await http.post(
                "/contacts",
                headers=_headers(alice),
                json={"identifier": target.global_id},
            )
            assert r.status_code == 201

        # Verify recipient candidates endpoint returns Bob & Carol with P-256 public keys
        rcpt_resp = await http.get("/statuses/recipients", headers=_headers(alice))
        assert rcpt_resp.status_code == 200
        rcpt_ids = {item["user_id"] for item in rcpt_resp.json()}
        assert rcpt_ids == {bob.user_id, carol.user_id}

        # 1. Alice sets default privacy to `except` Carol, then posts a styled Text Status
        priv_resp = await http.put(
            "/statuses/privacy",
            headers=_headers(alice),
            json={
                "mode": "except",
                "except_user_ids": [carol.user_id],
                "only_user_ids": [],
            },
        )
        assert priv_resp.status_code == 200
        assert priv_resp.json()["mode"] == "except"

        ct_b64, iv_b64, envelopes = _encrypt_status_for_recipients(
            alice,
            {
                "kind": "text",
                "text": "Launching federated E2EE stories from Jaipur!",
                "fontFamily": "serif",
                "backgroundStyle": "linear-gradient(135deg, #00a884 0%, #0f172a 100%)",
            },
            [bob],
        )

        async with websockets.connect(f"{ws_url}?token={alice.access_token}") as ws_alice:
            ready_a = json.loads(await ws_alice.recv())
            assert ready_a["event"] == "session.ready"

            async with websockets.connect(f"{ws_url}?token={bob.access_token}") as ws_bob:
                ready_b = json.loads(await ws_bob.recv())
                assert ready_b["event"] == "session.ready"

                post_resp = await http.post(
                    "/statuses",
                    headers=_headers(alice),
                    json={
                        "media_type": "text",
                        "ciphertext": ct_b64,
                        "nonce": iv_b64,
                        "key_envelopes": envelopes,
                        "background_style": "linear-gradient(135deg, #00a884 0%, #0f172a 100%)",
                        "font_family": "serif",
                    },
                )
                assert post_resp.status_code == 201, post_resp.text
                text_status_id = post_resp.json()["id"]

                # Bob receives live `status.new` WS notification
                ev_b = json.loads(await asyncio.wait_for(ws_bob.recv(), timeout=3.0))
                assert ev_b["event"] == "status.new"
                assert ev_b["data"]["status_id"] == text_status_id

                # Carol (excluded via `except`) sees empty status feed and gets 403 on view
                carol_feed = await http.get("/statuses", headers=_headers(carol))
                assert carol_feed.status_code == 200
                assert carol_feed.json()["recent_updates"] == []
                carol_view = await http.post(
                    f"/statuses/{text_status_id}/view", headers=_headers(carol)
                )
                assert carol_view.status_code == 403

                # Bob fetches feed, decrypts status locally, and marks viewed
                bob_feed = await http.get("/statuses", headers=_headers(bob))
                assert bob_feed.status_code == 200
                bundles = bob_feed.json()["recent_updates"]
                assert len(bundles) == 1
                st_item = bundles[0]["statuses"][0]
                decrypted = _decrypt_status_as_viewer(
                    bob,
                    alice.public_key_str,
                    st_item["ciphertext"],
                    st_item["nonce"],
                    st_item["my_key_envelope"],
                )
                assert decrypted["text"] == "Launching federated E2EE stories from Jaipur!"

                view_resp = await http.post(
                    f"/statuses/{text_status_id}/view", headers=_headers(bob)
                )
                assert view_resp.status_code == 200

                # Alice receives live `status.viewed` WS event + sees Bob in viewer list
                ev_a = json.loads(await asyncio.wait_for(ws_alice.recv(), timeout=3.0))
                assert ev_a["event"] == "status.viewed"
                assert ev_a["data"]["viewer"]["user_id"] == bob.user_id

        viewers_resp = await http.get(
            f"/statuses/{text_status_id}/viewers", headers=_headers(alice)
        )
        assert viewers_resp.status_code == 200
        assert [v["user_id"] for v in viewers_resp.json()] == [bob.user_id]

        # 2. Alice uploads an encrypted Image Status (`conversation_id=None`) shared `only` with Bob
        raw_img = b"\x89PNG\r\n\x1a\nSTATUS_ENCRYPTED_STORY_IMAGE_BYTES" * 20
        enc_img = client_encrypt_file_chunks(raw_img)
        enc_name, _ = client_encrypt_meta_bytes(enc_img["file_key_b64"], b"sunset.png")
        init_att = await http.post(
            "/attachments/init",
            headers=_headers(alice),
            json={
                "mime_type": "image/png",
                "total_size": len(raw_img),
                "chunk_size": enc_img["chunk_size"],
                "chunk_count": enc_img["chunk_count"],
                "file_nonce": enc_img["base_nonce_b64"],
                "encrypted_filename": enc_name,
            },
        )
        assert init_att.status_code == 201, init_att.text
        att_id = init_att.json()["attachment_id"]
        slot_url = init_att.json()["upload_urls"][0]["upload_url"]
        put_res = await http.put(slot_url, content=enc_img["encrypted_chunks"][0])
        assert put_res.status_code == 200
        comp_res = await http.post(
            f"/attachments/{att_id}/complete", headers=_headers(alice)
        )
        assert comp_res.status_code == 200

        img_ct, img_iv, img_envs = _encrypt_status_for_recipients(
            alice,
            {
                "kind": "image",
                "caption": "Sunset over Nahargarh Fort",
                "encryptedRef": {
                    "attachmentId": att_id,
                    "fileKeyB64": enc_img["file_key_b64"],
                    "baseNonceB64": enc_img["base_nonce_b64"],
                    "chunkSize": enc_img["chunk_size"],
                    "chunkCount": enc_img["chunk_count"],
                    "encryptedChunkLengths": enc_img["encrypted_chunk_lengths"],
                    "totalSizeBytes": len(raw_img),
                    "mimeType": "image/png",
                },
            },
            [bob],
        )
        img_post = await http.post(
            "/statuses",
            headers=_headers(alice),
            json={
                "media_type": "image",
                "ciphertext": img_ct,
                "nonce": img_iv,
                "key_envelopes": img_envs,
                "attachment_id": att_id,
                "privacy_mode": "only",
                "target_user_ids": [bob.user_id],
            },
        )
        assert img_post.status_code == 201
        img_status_id = img_post.json()["id"]

        # Bob can download & decrypt the status image; Carol gets 403 FORBIDDEN!
        carol_dl = await http.get(
            f"/attachments/{att_id}/download", headers=_headers(carol)
        )
        assert carol_dl.status_code == 403

        bob_dl = await http.get(
            f"/attachments/{att_id}/download", headers=_headers(bob)
        )
        assert bob_dl.status_code == 200
        recovered_img = client_decrypt_file_chunks(
            bob_dl.content,
            enc_img["file_key_b64"],
            enc_img["base_nonce_b64"],
            enc_img["chunk_size"],
            enc_img["chunk_count"],
            enc_img["encrypted_chunk_lengths"],
        )
        assert recovered_img == raw_img

        # 3. Mute / Unmute Alice's statuses as Bob
        mute_res = await http.post(
            f"/statuses/mute/{alice.user_id}", headers=_headers(bob)
        )
        assert mute_res.status_code == 200
        muted_feed = await http.get("/statuses", headers=_headers(bob))
        assert muted_feed.json()["recent_updates"] == []
        assert len(muted_feed.json()["muted_updates"]) == 1

        unmute_res = await http.delete(
            f"/statuses/mute/{alice.user_id}", headers=_headers(bob)
        )
        assert unmute_res.status_code == 200

        # 4. Bob replies to Alice's status in 1:1 E2EE chat
        conv_res = await http.post(
            "/conversations",
            headers=_headers(bob),
            json={"peer_id": alice.user_id},
        )
        assert conv_res.status_code == 201
        conv_id = conv_res.json()["id"]
        reply_ct, reply_iv = bob.encrypt_for(
            alice.public_key_str,
            json.dumps(
                {
                    "v": 1,
                    "type": "text",
                    "text": "Amazing sunset shot!",
                    "statusReply": {
                        "statusId": img_status_id,
                        "mediaType": "image",
                        "previewText": "Sunset over Nahargarh Fort",
                    },
                }
            ),
        )
        msg_res = await http.post(
            "/messages",
            headers=_headers(bob),
            json={"conversation_id": conv_id, "ciphertext": reply_ct, "nonce": reply_iv},
        )
        assert msg_res.status_code == 201

        # 5. Simulate 24-hour expiration and run cleanup job -> purges statuses & orphaned encrypted blob
        async with AsyncSessionLocal() as db:
            posts = (await db.execute(select(StatusPost))).scalars().all()
            for p in posts:
                p.expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)
            await db.commit()
            stats = await run_expiry_cleanup_once(db)
            assert stats["expired_statuses_removed"] == 2

        after_feed = await http.get("/statuses", headers=_headers(alice))
        assert after_feed.json()["my_statuses"] == []
        gone_dl = await http.get(
            f"/attachments/{att_id}/download", headers=_headers(alice)
        )
        assert gone_dl.status_code == 404


@pytest.mark.asyncio
async def test_web_push_vapid_privacy_modes_mute_starred_archive_and_disappearing(
    phase9_server: dict[str, Any],
) -> None:
    base_url = phase9_server["base_url"]
    captured_pushes: list[tuple[str, dict[str, Any]]] = []
    set_push_transport_override(
        lambda sub, payload: captured_pushes.append((sub.endpoint, payload))
    )

    async with AsyncClient(base_url=base_url) as http:
        alice = await _signup_peer(http, "alice_push", "Alice Sender")
        bob = await _signup_peer(http, "bob_push", "Bob Push Receiver")

        # 1. VAPID public key discovery (65-byte uncompressed P-256 point in base64url)
        vapid_resp = await http.get("/push/vapid-public-key")
        assert vapid_resp.status_code == 200
        pub_key_b64 = vapid_resp.json()["public_key"]
        padded = pub_key_b64 + "=" * (-len(pub_key_b64) % 4)
        raw_point = base64.urlsafe_b64decode(padded)
        assert len(raw_point) == 65 and raw_point[0] == 0x04

        # 2. Bob subscribes with `local_decrypt_enabled=False` (strict privacy mode: "New message" only)
        sub_resp = await http.post(
            "/push/subscribe",
            headers=_headers(bob),
            json={
                "endpoint": "https://push.example.org/send/bob-device-1",
                "keys": {
                    "p256dh": "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM",
                    "auth": "tBHItJI5svbpez7KI4CCXg",
                },
                "local_decrypt_enabled": False,
            },
        )
        assert sub_resp.status_code == 201, sub_resp.text
        sub_id = sub_resp.json()["id"]

        conv_res = await http.post(
            "/conversations",
            headers=_headers(alice),
            json={"peer_id": bob.user_id},
        )
        conv_id = conv_res.json()["id"]

        ct1, iv1 = alice.encrypt_for(bob.public_key_str, "Top secret launch code 9941")
        m1 = await http.post(
            "/messages",
            headers=_headers(alice),
            json={"conversation_id": conv_id, "ciphertext": ct1, "nonce": iv1},
        )
        assert m1.status_code == 201
        msg1_id = m1.json()["id"]

        assert len(captured_pushes) == 1
        _, payload_priv = captured_pushes[-1]
        assert payload_priv["body"] == "New message"
        assert payload_priv["local_decrypt"] is False
        assert "ciphertext" not in payload_priv
        assert "9941" not in json.dumps(payload_priv)

        # 3. Bob enables `local_decrypt_enabled=True` -> push carries ciphertext + sender key (still zero plaintext!)
        patch_sub = await http.patch(
            f"/push/subscriptions/{sub_id}",
            headers=_headers(bob),
            json={"local_decrypt_enabled": True},
        )
        assert patch_sub.status_code == 200

        ct2, iv2 = alice.encrypt_for(bob.public_key_str, "Local SW decryptable message")
        m2 = await http.post(
            "/messages",
            headers=_headers(alice),
            json={"conversation_id": conv_id, "ciphertext": ct2, "nonce": iv2},
        )
        assert m2.status_code == 201
        assert len(captured_pushes) == 2
        _, payload_sw = captured_pushes[-1]
        assert payload_sw["local_decrypt"] is True
        assert payload_sw["ciphertext"] == ct2
        assert "Local SW decryptable" not in json.dumps(payload_sw)
        # Bob's Service Worker can decrypt `payload_sw` locally!
        sw_decrypted = bob.decrypt_from(
            payload_sw["sender_public_key"],
            payload_sw["ciphertext"],
            payload_sw["nonce"],
        )
        assert sw_decrypted == "Local SW decryptable message"

        # 4. Mute + Archive conversation -> muted chat suppresses push notifications!
        patch_conv = await http.patch(
            f"/conversations/{conv_id}",
            headers=_headers(bob),
            json={"is_muted": True, "is_archived": True},
        )
        assert patch_conv.status_code == 200
        assert patch_conv.json()["is_muted"] is True
        assert patch_conv.json()["is_archived"] is True

        ct3, iv3 = alice.encrypt_for(bob.public_key_str, "Silent while muted")
        await http.post(
            "/messages",
            headers=_headers(alice),
            json={"conversation_id": conv_id, "ciphertext": ct3, "nonce": iv3},
        )
        assert len(captured_pushes) == 2  # No push sent while muted!

        # 5. Starred messages CRUD
        star_res = await http.post(f"/messages/{msg1_id}/star", headers=_headers(bob))
        assert star_res.status_code == 200
        starred_list = await http.get("/messages/starred", headers=_headers(bob))
        assert starred_list.status_code == 200
        assert len(starred_list.json()) == 1
        assert starred_list.json()[0]["message"]["id"] == msg1_id

        unstar_res = await http.delete(f"/messages/{msg1_id}/star", headers=_headers(bob))
        assert unstar_res.status_code == 200
        assert (await http.get("/messages/starred", headers=_headers(bob))).json() == []

        # 6. Disappearing messages timer -> sets `expires_at` automatically & cleanup purges expired messages
        timer_res = await http.patch(
            f"/conversations/{conv_id}",
            headers=_headers(alice),
            json={"disappearing_timer_seconds": 3600},
        )
        assert timer_res.status_code == 200
        assert timer_res.json()["disappearing_timer_seconds"] == 3600

        ct4, iv4 = alice.encrypt_for(bob.public_key_str, "Ephemeral 1hr message")
        m4 = await http.post(
            "/messages",
            headers=_headers(alice),
            json={"conversation_id": conv_id, "ciphertext": ct4, "nonce": iv4},
        )
        assert m4.status_code == 201
        ephemeral_id = m4.json()["id"]
        assert m4.json()["expires_at"] is not None

        # Backdate `expires_at` and verify immediate read hiding + cleanup deletion
        async with AsyncSessionLocal() as db:
            row = (
                await db.execute(select(Message).where(Message.id == ephemeral_id))
            ).scalar_one()
            row.expires_at = datetime.now(timezone.utc) - timedelta(seconds=10)
            await db.commit()

        msgs_before_sweep = await http.get(
            f"/conversations/{conv_id}/messages", headers=_headers(bob)
        )
        visible_ids = {item["id"] for item in msgs_before_sweep.json()["items"]}
        assert ephemeral_id not in visible_ids

        async with AsyncSessionLocal() as db:
            stats = await run_expiry_cleanup_once(db)
            assert stats["expired_messages_removed"] == 1


@pytest.mark.asyncio
async def test_hardening_csp_headers_sanitization_scanner_metrics_and_rate_limit(
    phase9_server: dict[str, Any],
) -> None:
    base_url = phase9_server["base_url"]

    async with AsyncClient(base_url=base_url) as http:
        # 1. Security headers & CSP present on responses
        health_resp = await http.get("/health")
        assert health_resp.status_code == 200
        assert health_resp.headers.get("x-content-type-options") == "nosniff"
        assert "default-src 'self'" in (
            health_resp.headers.get("content-security-policy") or ""
        )
        assert health_resp.headers.get("referrer-policy") == "strict-origin-when-cross-origin"

        # 2. Input sanitization strips `<script>` and angle brackets from profile & group fields
        alice = await _signup_peer(
            http,
            "alice_sec",
            "Alice <script>alert(1)</script> Admin",
        )
        me_resp = await http.get("/users/me", headers=_headers(alice))
        assert "<script>" not in me_resp.json()["display_name"]
        assert "<" not in me_resp.json()["display_name"]

        patch_me = await http.patch(
            "/users/me",
            headers=_headers(alice),
            json={"about": "Security bio <iframe src='evil'></iframe>\x00clean"},
        )
        assert patch_me.status_code == 200
        assert "<iframe" not in patch_me.json()["about"]
        assert "\x00" not in patch_me.json()["about"]

        # 3. File scanner quarantine hook blocks flagged uploads and removes blob from disk
        raw_bytes = b"test_quarantine_payload_bytes" * 8
        enc_blob = client_encrypt_file_chunks(raw_bytes)
        init_res = await http.post(
            "/attachments/init",
            headers=_headers(alice),
            json={
                "mime_type": "text/plain",
                "total_size": len(raw_bytes),
                "chunk_size": enc_blob["chunk_size"],
                "chunk_count": enc_blob["chunk_count"],
                "file_nonce": enc_blob["base_nonce_b64"],
                "encrypted_filename": f"cipher_{QUARANTINE_TEST_TOKEN}",
            },
        )
        assert init_res.status_code == 201
        q_att_id = init_res.json()["attachment_id"]
        q_slot = init_res.json()["upload_urls"][0]["upload_url"]
        await http.put(q_slot, content=enc_blob["encrypted_chunks"][0])
        comp_res = await http.post(
            f"/attachments/{q_att_id}/complete", headers=_headers(alice)
        )
        assert comp_res.status_code == 422
        assert comp_res.json()["error"]["code"] == "FILE_QUARANTINED"

        # 4. Prometheus `/metrics` endpoint exposes counters, histograms, and gauges
        metrics_resp = await http.get("/metrics")
        assert metrics_resp.status_code == 200
        m_text = metrics_resp.text
        assert "relaychat_http_requests_total" in m_text
        assert "relaychat_http_request_duration_seconds_bucket" in m_text
        assert "relaychat_file_scans_total" in m_text
        assert "relaychat_local_users_count" in m_text

        # 5. Auth rate limiter returns 429 + `Retry-After` header when threshold exceeded
        settings = get_settings()
        orig_limit = settings.AUTH_RATE_LIMIT_PER_MINUTE
        settings.AUTH_RATE_LIMIT_PER_MINUTE = 3
        rate_limiter.reset()
        try:
            codes: list[int] = []
            retry_hdr: str | None = None
            for _ in range(4):
                r = await http.post(
                    "/auth/login",
                    json={"username": "nonexistent_u", "password": "wrongpassword"},
                )
                codes.append(r.status_code)
                if r.status_code == 429:
                    retry_hdr = r.headers.get("retry-after")
            assert 429 in codes
            assert retry_hdr is not None and int(retry_hdr) >= 1
        finally:
            settings.AUTH_RATE_LIMIT_PER_MINUTE = orig_limit
            rate_limiter.reset()
