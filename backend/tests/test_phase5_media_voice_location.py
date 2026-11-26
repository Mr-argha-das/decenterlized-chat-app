import asyncio
import base64
import hashlib
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
from app.models.entities import Attachment, Message, User  # noqa: E402
from app.services.federation_hook import register_federation_resolver  # noqa: E402
from tests.test_phase3_realtime_e2ee_chat import SimulatedE2eePeer  # noqa: E402


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _derive_chunk_iv(base_nonce: bytes, chunk_index: int) -> bytes:
    iv = bytearray(base_nonce)
    iv[8] ^= (chunk_index >> 24) & 0xFF
    iv[9] ^= (chunk_index >> 16) & 0xFF
    iv[10] ^= (chunk_index >> 8) & 0xFF
    iv[11] ^= chunk_index & 0xFF
    return bytes(iv)


def _chunk_aad(chunk_index: int, chunk_count: int) -> bytes:
    return f"RelayChat-FileChunk-v1|{chunk_index}/{chunk_count}".encode("utf-8")


def client_encrypt_file_chunks(
    plain_bytes: bytes, chunk_size: int = 1_048_576
) -> dict[str, Any]:
    file_key = os.urandom(32)
    base_nonce = os.urandom(12)
    aes = AESGCM(file_key)

    total_len = len(plain_bytes)
    chunk_count = max(1, (total_len + chunk_size - 1) // chunk_size)
    encrypted_chunks: list[bytes] = []
    chunk_lengths: list[int] = []

    for idx in range(chunk_count):
        part = plain_bytes[idx * chunk_size : min(total_len, (idx + 1) * chunk_size)]
        iv = _derive_chunk_iv(base_nonce, idx)
        ct = aes.encrypt(iv, part, _chunk_aad(idx, chunk_count))
        encrypted_chunks.append(ct)
        chunk_lengths.append(len(ct))

    return {
        "file_key_b64": base64.b64encode(file_key).decode("ascii"),
        "base_nonce_b64": base64.b64encode(base_nonce).decode("ascii"),
        "chunk_size": chunk_size,
        "chunk_count": chunk_count,
        "encrypted_chunks": encrypted_chunks,
        "encrypted_chunk_lengths": chunk_lengths,
    }


def client_decrypt_file_chunks(
    assembled_cipher: bytes,
    file_key_b64: str,
    base_nonce_b64: str,
    chunk_size: int,
    chunk_count: int,
    encrypted_chunk_lengths: list[int] | None = None,
) -> bytes:
    aes = AESGCM(base64.b64decode(file_key_b64))
    base_nonce = base64.b64decode(base_nonce_b64)
    out = bytearray()
    offset = 0
    for idx in range(chunk_count):
        if encrypted_chunk_lengths and len(encrypted_chunk_lengths) == chunk_count:
            ct_len = encrypted_chunk_lengths[idx]
        elif idx < chunk_count - 1:
            ct_len = chunk_size + 16
        else:
            ct_len = len(assembled_cipher) - offset
        ct_slice = assembled_cipher[offset : offset + ct_len]
        offset += ct_len
        iv = _derive_chunk_iv(base_nonce, idx)
        out.extend(aes.decrypt(iv, ct_slice, _chunk_aad(idx, chunk_count)))
    assert offset == len(assembled_cipher)
    return bytes(out)


def client_encrypt_meta_bytes(file_key_b64: str, plain: bytes) -> tuple[str, str]:
    aes = AESGCM(base64.b64decode(file_key_b64))
    iv = os.urandom(12)
    ct = aes.encrypt(iv, plain, None)
    return base64.b64encode(ct).decode("ascii"), base64.b64encode(iv).decode("ascii")


def client_decrypt_meta_bytes(file_key_b64: str, ct_b64: str, iv_b64: str) -> bytes:
    aes = AESGCM(base64.b64decode(file_key_b64))
    return aes.decrypt(base64.b64decode(iv_b64), base64.b64decode(ct_b64), None)


def _headers(peer: SimulatedE2eePeer) -> dict[str, str]:
    return {"Authorization": f"Bearer {peer.access_token}"}


def _encrypt_envelope(
    sender: SimulatedE2eePeer, peer_pub_json: str, payload: dict[str, Any]
) -> tuple[str, str]:
    aes = sender._derive_aes_key(peer_pub_json)
    nonce = os.urandom(12)
    raw = json.dumps({"v": 1, **payload}).encode("utf-8")
    ct = aes.encrypt(nonce, raw, None)
    return (
        base64.b64encode(ct).decode("ascii"),
        base64.b64encode(nonce).decode("ascii"),
    )


def _decrypt_envelope(
    receiver: SimulatedE2eePeer,
    peer_pub_json: str,
    ciphertext_b64: str,
    nonce_b64: str,
) -> dict[str, Any]:
    aes = receiver._derive_aes_key(peer_pub_json)
    raw = aes.decrypt(
        base64.b64decode(nonce_b64), base64.b64decode(ciphertext_b64), None
    )
    return json.loads(raw.decode("utf-8"))


@pytest_asyncio.fixture()
async def live_node(tmp_path: Path) -> AsyncGenerator[tuple[AsyncClient, str, Path], None]:
    settings = get_settings()
    orig_storage_dir = settings.STORAGE_DIR
    test_storage_dir = tmp_path / "storage_root"
    settings.STORAGE_DIR = str(test_storage_dir)
    test_blob_dir = test_storage_dir / "encrypted_blobs"

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
        yield client, base_ws, test_blob_dir

    register_federation_resolver(None)
    server.should_exit = True
    await task
    await engine.dispose()
    settings.STORAGE_DIR = orig_storage_dir
    shutil.rmtree(test_storage_dir, ignore_errors=True)


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
    data = resp.json()
    peer.user_id = data["user"]["id"]
    peer.global_id = data["user"]["global_id"]
    peer.access_token = data["access_token"]
    return peer


async def _recv_until_event(
    ws: Any, target_event: str, timeout: float = 5.0
) -> dict[str, Any]:
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = max(0.1, deadline - asyncio.get_event_loop().time())
        raw = await asyncio.wait_for(ws.recv(), timeout=remaining)
        pkt = json.loads(raw)
        if pkt.get("event") == target_event:
            return pkt


@pytest.mark.asyncio
async def test_phase5_e2ee_image_video_pdf_voice_and_zero_plaintext_storage(
    live_node: tuple[AsyncClient, str, Path],
) -> None:
    """
    Acceptance criteria verification:
    - Alice sends encrypted Image, Video, multi-chunk PDF (1.45 MB across 2 x 1 MB chunks),
      and Voice note to Bob using per-file AES-256-GCM keys + signed upload URLs.
    - Bob receives each E2EE message over WebSocket, downloads the ciphertext blob,
      and decrypts exact original bytes, thumbnail, and waveform.
    - Server storage (`objects/*.enc`) and database tables contain ONLY encrypted bytes.
    """
    client, base_ws, blob_root = live_node
    alice = await _register_peer(client, "alice_p5", "Alice P5")
    bob = await _register_peer(client, "bob_p5", "Bob P5")

    conv_resp = await client.post(
        "/conversations",
        headers=_headers(alice),
        json={"peer_id": bob.user_id},
    )
    assert conv_resp.status_code == 201, conv_resp.text
    conv_id = conv_resp.json()["id"]

    # Prepare 4 distinct media/file payloads with unmistakable plaintext markers
    image_plain = b"\xff\xd8\xff\xe0JFIF-SECRET-IMAGE-JAIPUR-FORT-" + os.urandom(4096)
    video_plain = b"\x00\x00\x00\x18ftypmp42-MP4-SECRET-VIDEO-STREAM-" + os.urandom(8192)
    pdf_plain = (
        b"%PDF-1.7-SECRET-CONTRACT-CONFIDENTIAL-DO-NOT-LEAK-"
        + os.urandom(1_450_000)  # 1.45 MB -> 2 chunks of 1 MB!
    )
    voice_plain = b"OggS-OPUS-VOICE-SECRET-MEMO-HELLO-BOB-" + os.urandom(6000)
    thumb_plain = b"\xff\xd8\xff\xe0CLIENT-GENERATED-THUMBNAIL-JPEG\xff\xd9"

    cases = [
        ("sunset-jaipur.jpg", "image/jpeg", "image", image_plain, True, None),
        ("demo-clip.mp4", "video/mp4", "video", video_plain, True, None),
        ("RelayChat-Whitepaper.pdf", "application/pdf", "document", pdf_plain, False, None),
        ("voice-note-01.ogg", "audio/ogg;codecs=opus", "voice", voice_plain, False, [0.2, 0.8, 0.95, 0.4]),
    ]

    async with websockets.connect(f"{base_ws}/ws?token={bob.access_token}") as bob_ws:
        ready = await _recv_until_event(bob_ws, "session.ready")
        assert ready["data"]["global_id"] == bob.global_id

        for fname, mime, msg_type, plain_data, with_thumb, waveform in cases:
            enc = client_encrypt_file_chunks(plain_data, chunk_size=1_048_576)
            enc_fname_ct, _ = client_encrypt_meta_bytes(
                enc["file_key_b64"], fname.encode("utf-8")
            )
            thumb_ct, thumb_nonce = (
                client_encrypt_meta_bytes(enc["file_key_b64"], thumb_plain)
                if with_thumb
                else (None, None)
            )

            # 1. Init attachment -> obtain HMAC-signed chunk upload URLs
            init_r = await client.post(
                "/attachments/init",
                headers=_headers(alice),
                json={
                    "conversation_id": conv_id,
                    "mime_type": mime,
                    "total_size": len(plain_data),
                    "chunk_size": enc["chunk_size"],
                    "chunk_count": enc["chunk_count"],
                    "file_nonce": enc["base_nonce_b64"],
                    "encrypted_filename": enc_fname_ct,
                    "thumbnail_ciphertext": thumb_ct,
                    "thumbnail_nonce": thumb_nonce,
                },
            )
            assert init_r.status_code == 201, init_r.text
            init_body = init_r.json()
            att_id = init_body["attachment_id"]
            assert len(init_body["upload_urls"]) == enc["chunk_count"]

            # 2. Upload each encrypted chunk directly to its signed URL (NO auth header needed!)
            for slot in init_body["upload_urls"]:
                idx = slot["chunk_index"]
                put_r = await client.put(
                    slot["upload_url"],
                    content=enc["encrypted_chunks"][idx],
                    headers={"Content-Type": "application/octet-stream"},
                )
                assert put_r.status_code == 200, put_r.text

            # 3. Complete upload -> server verifies count & SHA-256 and returns signed download URL
            comp_r = await client.post(
                f"/attachments/{att_id}/complete",
                headers=_headers(alice),
            )
            assert comp_r.status_code == 200, comp_r.text
            comp_body = comp_r.json()
            expected_sha = hashlib.sha256(b"".join(enc["encrypted_chunks"])).hexdigest()
            assert comp_body["sha256_ciphertext"] == expected_sha

            # 4. Alice encrypts file key + metadata inside the E2EE message to Bob
            e2ee_payload: dict[str, Any] = {
                "text": fname,
                "attachmentId": att_id,
                "fileKeyB64": enc["file_key_b64"],
                "baseNonceB64": enc["base_nonce_b64"],
                "chunkSize": enc["chunk_size"],
                "chunkCount": enc["chunk_count"],
                "encryptedChunkLengths": enc["encrypted_chunk_lengths"],
                "totalSizeBytes": len(plain_data),
                "downloadUrl": comp_body["download_url"],
                "fileName": fname,
                "mimeType": comp_body["mime_type"],
            }
            if thumb_ct and thumb_nonce:
                e2ee_payload["thumbCiphertext"] = thumb_ct
                e2ee_payload["thumbNonce"] = thumb_nonce
            if waveform:
                e2ee_payload["waveform"] = waveform
                e2ee_payload["durationSec"] = 4

            ciphertext_b64, nonce_b64 = _encrypt_envelope(
                alice, bob.public_key_str, e2ee_payload
            )

            msg_r = await client.post(
                "/messages",
                headers=_headers(alice),
                json={
                    "conversation_id": conv_id,
                    "ciphertext": ciphertext_b64,
                    "nonce": nonce_b64,
                    "type": msg_type,
                    "attachment_id": att_id,
                },
            )
            assert msg_r.status_code == 201, msg_r.text

            # 5. Bob receives real-time WS `message.new`, decrypts envelope, downloads & decrypts blob!
            ws_pkt = await _recv_until_event(bob_ws, "message.new")
            wire_msg = ws_pkt["data"]
            assert wire_msg["attachment_id"] == att_id
            assert wire_msg["type"] == msg_type

            bob_env = _decrypt_envelope(
                bob, alice.public_key_str, wire_msg["ciphertext"], wire_msg["nonce"]
            )
            assert bob_env["fileName"] == fname

            if with_thumb:
                recovered_thumb = client_decrypt_meta_bytes(
                    bob_env["fileKeyB64"],
                    bob_env["thumbCiphertext"],
                    bob_env["thumbNonce"],
                )
                assert recovered_thumb == thumb_plain

            dl_r = await client.get(bob_env["downloadUrl"])
            assert dl_r.status_code == 200
            recovered_plain = client_decrypt_file_chunks(
                dl_r.content,
                file_key_b64=bob_env["fileKeyB64"],
                base_nonce_b64=bob_env["baseNonceB64"],
                chunk_size=bob_env["chunkSize"],
                chunk_count=bob_env["chunkCount"],
                encrypted_chunk_lengths=bob_env["encryptedChunkLengths"],
            )
            assert recovered_plain == plain_data

    # 6. Verify server disk storage (`objects/*.enc`) contains ONLY encrypted bytes (zero plaintext markers)
    stored_files = list((blob_root / "objects").glob("*.enc"))
    assert len(stored_files) == 4
    forbidden_markers = [
        b"JFIF-SECRET-IMAGE",
        b"MP4-SECRET-VIDEO",
        b"%PDF-1.7-SECRET-CONTRACT",
        b"OPUS-VOICE-SECRET",
        b"CLIENT-GENERATED-THUMBNAIL",
        b"sunset-jaipur.jpg",
        b"RelayChat-Whitepaper.pdf",
    ]
    for enc_file in stored_files:
        raw_disk_bytes = enc_file.read_bytes()
        for marker in forbidden_markers:
            assert marker not in raw_disk_bytes, f"Plaintext marker {marker!r} found on disk!"

    # Also verify DB rows hold zero plaintext filenames or file keys
    async with AsyncSessionLocal() as db:
        atts = (await db.execute(select(Attachment))).scalars().all()
        msgs = (await db.execute(select(Message))).scalars().all()
        for a in atts:
            assert "sunset-jaipur" not in (a.encrypted_filename or "")
            assert "Whitepaper" not in (a.encrypted_filename or "")
        for m in msgs:
            assert "JFIF-SECRET" not in m.ciphertext
            assert "Whitepaper" not in m.ciphertext


@pytest.mark.asyncio
async def test_phase5_limits_quota_signed_url_security_and_cancel_cleanup(
    live_node: tuple[AsyncClient, str, Path],
) -> None:
    """
    Verifies MIME allow-list, 100 MB max file size, signed URL HMAC enforcement,
    in-flight upload cancellation cleanup, and per-user storage quota enforcement.
    """
    client, _, blob_root = live_node
    alice = await _register_peer(client, "quota_alice", "Quota Alice")
    bob = await _register_peer(client, "quota_bob", "Quota Bob")

    conv = (
        await client.post(
            "/conversations",
            headers=_headers(alice),
            json={"peer_id": bob.user_id},
        )
    ).json()
    conv_id = conv["id"]
    valid_nonce = base64.b64encode(os.urandom(12)).decode("ascii")

    # 1. Disallowed executable MIME is rejected
    bad_mime = await client.post(
        "/attachments/init",
        headers=_headers(alice),
        json={
            "conversation_id": conv_id,
            "mime_type": "application/x-msdownload",
            "total_size": 1024,
            "chunk_size": 1_048_576,
            "chunk_count": 1,
            "file_nonce": valid_nonce,
            "encrypted_filename": "enc_exe_name",
        },
    )
    assert bad_mime.status_code in (400, 415, 422)

    # 2. File > 100 MB is rejected with 413
    oversized = await client.post(
        "/attachments/init",
        headers=_headers(alice),
        json={
            "conversation_id": conv_id,
            "mime_type": "video/mp4",
            "total_size": 105 * 1024 * 1024,
            "chunk_size": 1_048_576,
            "chunk_count": 105,
            "file_nonce": valid_nonce,
            "encrypted_filename": "enc_huge_video",
        },
    )
    assert oversized.status_code == 413

    # 3. Tampered signed upload URL & cancel upload cleanup
    init_ok = await client.post(
        "/attachments/init",
        headers=_headers(alice),
        json={
            "conversation_id": conv_id,
            "mime_type": "application/pdf",
            "total_size": 2048,
            "chunk_size": 1_048_576,
            "chunk_count": 1,
            "file_nonce": valid_nonce,
            "encrypted_filename": "enc_cancel_pdf",
        },
    )
    assert init_ok.status_code == 201
    att_id = init_ok.json()["attachment_id"]
    slot_url = init_ok.json()["upload_urls"][0]["upload_url"]

    # Tamper with `sig=` query parameter -> must reject with 403
    tampered_url = slot_url[:-4] + "0000"
    bad_put = await client.put(tampered_url, content=os.urandom(2048 + 16))
    assert bad_put.status_code == 403

    # Upload chunk 0 then cancel before complete -> staging cleaned up & DB row removed
    good_put = await client.put(slot_url, content=os.urandom(2048 + 16))
    assert good_put.status_code == 200
    assert any((blob_root / "staging").iterdir())

    del_r = await client.delete(f"/attachments/{att_id}", headers=_headers(alice))
    assert del_r.status_code == 200
    assert not any((blob_root / "staging").iterdir())

    # 4. Per-user storage quota enforcement
    async with AsyncSessionLocal() as db:
        u = (await db.execute(select(User).where(User.id == alice.user_id))).scalar_one()
        u.storage_quota_bytes = 4096  # Set tight 4 KB quota for test
        await db.commit()

    quota_exceeded = await client.post(
        "/attachments/init",
        headers=_headers(alice),
        json={
            "conversation_id": conv_id,
            "mime_type": "image/png",
            "total_size": 8192,
            "chunk_size": 1_048_576,
            "chunk_count": 1,
            "file_nonce": valid_nonce,
            "encrypted_filename": "enc_over_quota",
        },
    )
    assert quota_exceeded.status_code in (413, 507, 400)


@pytest.mark.asyncio
async def test_phase5_static_and_live_location_ws_streaming_stop_and_auto_expiry(
    live_node: tuple[AsyncClient, str, Path],
) -> None:
    """
    Verifies E2EE static location + live location (15m / 1h / 8h):
    - Periodic encrypted coordinate updates streamed over WebSocket (`location.live_update` -> `location.live_updated`)
    - Stop-sharing (`location.live_stop` -> `location.live_stopped`)
    - Auto-expiry enforcement rejecting updates once `expires_at` has passed.
    """
    client, base_ws, _ = live_node
    alice = await _register_peer(client, "loc_alice", "Loc Alice")
    bob = await _register_peer(client, "loc_bob", "Loc Bob")

    conv_id = (
        await client.post(
            "/conversations",
            headers=_headers(alice),
            json={"peer_id": bob.user_id},
        )
    ).json()["id"]

    async with (
        websockets.connect(f"{base_ws}/ws?token={alice.access_token}") as alice_ws,
        websockets.connect(f"{base_ws}/ws?token={bob.access_token}") as bob_ws,
    ):
        await _recv_until_event(alice_ws, "session.ready")
        await _recv_until_event(bob_ws, "session.ready")

        # 1. Static location message
        static_payload = {
            "text": "Hawa Mahal",
            "label": "Hawa Mahal",
            "address": "Badi Choupad, Jaipur",
            "latitude": 26.9239,
            "longitude": 75.8267,
            "isLive": False,
        }
        ct_static, nonce_static = _encrypt_envelope(
            alice, bob.public_key_str, static_payload
        )
        r_static = await client.post(
            "/messages",
            headers=_headers(alice),
            json={
                "conversation_id": conv_id,
                "ciphertext": ct_static,
                "nonce": nonce_static,
                "type": "location",
            },
        )
        assert r_static.status_code == 201
        bob_static_evt = await _recv_until_event(bob_ws, "message.new")
        bob_static_dec = _decrypt_envelope(
            bob,
            alice.public_key_str,
            bob_static_evt["data"]["ciphertext"],
            bob_static_evt["data"]["nonce"],
        )
        assert bob_static_dec["latitude"] == pytest.approx(26.9239)
        assert bob_static_dec["longitude"] == pytest.approx(75.8267)
        assert "26.9239" not in bob_static_evt["data"]["ciphertext"]

        # 2. Live location (15 min) + real-time WebSocket updates + stop sharing
        expires_iso = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat()
        live_init_payload = {
            "text": "En route",
            "label": "En route",
            "latitude": 26.9124,
            "longitude": 75.7873,
            "isLive": True,
            "durationMinutes": 15,
            "expiresAt": expires_iso,
        }
        ct_live0, nonce_live0 = _encrypt_envelope(
            alice, bob.public_key_str, live_init_payload
        )
        r_live = await client.post(
            "/messages",
            headers=_headers(alice),
            json={
                "conversation_id": conv_id,
                "ciphertext": ct_live0,
                "nonce": nonce_live0,
                "type": "live_location",
                "expires_at": expires_iso,
            },
        )
        assert r_live.status_code == 201, r_live.text
        live_msg_id = r_live.json()["id"]
        await _recv_until_event(bob_ws, "message.new")

        # Alice pushes moving GPS update over WebSocket -> Bob receives `location.live_updated`
        live_upd_payload = {
            **live_init_payload,
            "latitude": 26.9188,
            "longitude": 75.8011,
        }
        ct_upd, nonce_upd = _encrypt_envelope(
            alice, bob.public_key_str, live_upd_payload
        )
        await alice_ws.send(
            json.dumps(
                {
                    "event": "location.live_update",
                    "data": {
                        "conversation_id": conv_id,
                        "message_id": live_msg_id,
                        "ciphertext": ct_upd,
                        "nonce": nonce_upd,
                    },
                }
            )
        )

        bob_upd_evt = await _recv_until_event(bob_ws, "location.live_updated")
        assert bob_upd_evt["data"]["id"] == live_msg_id
        bob_upd_dec = _decrypt_envelope(
            bob,
            alice.public_key_str,
            bob_upd_evt["data"]["ciphertext"],
            bob_upd_evt["data"]["nonce"],
        )
        assert bob_upd_dec["latitude"] == pytest.approx(26.9188)
        assert bob_upd_dec["longitude"] == pytest.approx(75.8011)

        # Alice stops sharing over WebSocket -> Bob receives `location.live_stopped`
        stop_payload = {**live_upd_payload, "liveStopped": True}
        ct_stop, nonce_stop = _encrypt_envelope(
            alice, bob.public_key_str, stop_payload
        )
        await alice_ws.send(
            json.dumps(
                {
                    "event": "location.live_stop",
                    "data": {
                        "conversation_id": conv_id,
                        "message_id": live_msg_id,
                        "ciphertext": ct_stop,
                        "nonce": nonce_stop,
                    },
                }
            )
        )
        bob_stop_evt = await _recv_until_event(bob_ws, "location.live_stopped")
        assert bob_stop_evt["data"]["id"] == live_msg_id

        # Subsequent update on stopped live location must fail
        post_stop_patch = await client.patch(
            f"/messages/{live_msg_id}/live-location",
            headers=_headers(alice),
            json={"ciphertext": ct_upd, "nonce": nonce_upd},
        )
        assert post_stop_patch.status_code in (400, 409, 410)

        # 3. Auto-expiry check: a live location whose `expires_at` has elapsed rejects updates
        short_exp = (datetime.now(timezone.utc) + timedelta(seconds=1)).isoformat()
        r_exp = await client.post(
            "/messages",
            headers=_headers(alice),
            json={
                "conversation_id": conv_id,
                "ciphertext": ct_live0,
                "nonce": nonce_live0,
                "type": "live_location",
                "expires_at": short_exp,
            },
        )
        assert r_exp.status_code == 201
        exp_msg_id = r_exp.json()["id"]
        await asyncio.sleep(1.25)

        expired_patch = await client.patch(
            f"/messages/{exp_msg_id}/live-location",
            headers=_headers(alice),
            json={"ciphertext": ct_upd, "nonce": nonce_upd},
        )
        assert expired_patch.status_code in (400, 409, 410)
