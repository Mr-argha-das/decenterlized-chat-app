import asyncio
import base64
import hashlib
import json
import os
import secrets
import socket
import sys
from contextlib import AsyncExitStack
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from pathlib import Path
from typing import Any, AsyncGenerator

import httpx
import pytest
import pytest_asyncio
import websockets
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.serialization import (
    Encoding,
    NoEncryption,
    PrivateFormat,
)

from app.core.errors import AppError
from app.services.federation_security import (
    compute_body_digest,
    is_disallowed_ip,
    validate_federation_url,
)
from tests.test_phase3_realtime_e2ee_chat import SimulatedE2eePeer
from tests.test_phase7_groups_sender_keys import SimulatedGroupPeer

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


@dataclass
class FederatedNodeProcess:
    domain: str
    port: int
    base_http: str
    base_ws: str
    db_path: Path
    key_path: Path
    storage_dir: Path
    env: dict[str, str]
    proc: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        self.proc = await asyncio.create_subprocess_exec(
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--log-level",
            "warning",
            cwd=str(BACKEND_ROOT),
            env=self.env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        deadline = asyncio.get_running_loop().time() + 12.0
        async with httpx.AsyncClient() as client:
            while asyncio.get_running_loop().time() < deadline:
                if self.proc.returncode is not None:
                    stderr_bytes = await self.proc.stderr.read() if self.proc.stderr else b""
                    raise RuntimeError(
                        f"Node {self.domain} exited early ({self.proc.returncode}): {stderr_bytes.decode()}"
                    )
                try:
                    r = await client.get(f"{self.base_http}/health", timeout=0.5)
                    if r.status_code == 200:
                        return
                except Exception:
                    pass
                await asyncio.sleep(0.08)
        raise TimeoutError(f"Timed out waiting for node {self.domain} on port {self.port}")

    async def stop(self) -> None:
        if self.proc and self.proc.returncode is None:
            self.proc.terminate()
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=5.0)
            except asyncio.TimeoutError:
                self.proc.kill()
                await self.proc.wait()
        self.proc = None


@pytest_asyncio.fixture()
async def two_federated_nodes(
    tmp_path: Path,
) -> AsyncGenerator[tuple[FederatedNodeProcess, FederatedNodeProcess], None]:
    port_a = _free_port()
    port_b = _free_port()
    dead_port = _free_port()

    url_a = f"http://127.0.0.1:{port_a}"
    url_b = f"http://127.0.0.1:{port_b}"
    domain_map = (
        f"node-a.local={url_a},"
        f"node-b.local={url_b},"
        f"dead-node.local=http://127.0.0.1:{dead_port}"
    )

    def make_env(domain: str, node_url: str, db_file: Path, key_file: Path, storage: Path) -> dict[str, str]:
        env = dict(os.environ)
        env.update(
            {
                "ENVIRONMENT": "test",
                "APP_NAME": f"RelayChat ({domain})",
                "APP_DOMAIN": domain,
                "NODE_PUBLIC_URL": node_url,
                "FRONTEND_URL": node_url,
                "DATABASE_URL": f"sqlite+aiosqlite:///{db_file}",
                "NODE_KEY_PATH": str(key_file),
                "NODE_PRIVATE_KEY_B64": "",
                "STORAGE_DIR": str(storage),
                "JWT_SECRET_KEY": f"jwt-secret-for-{domain}-minimum-32-chars!!",
                "UPLOAD_SIGNING_SECRET": f"upload-secret-for-{domain}-32-chars!",
                "FEDERATION_ENABLED": "true",
                "FEDERATION_REQUIRE_HTTPS": "false",
                "FEDERATION_ALLOW_PRIVATE_IPS": "true",
                "FEDERATION_DOMAIN_MAP": domain_map,
                "FEDERATION_HTTP_TIMEOUT_SECONDS": "2.0",
                "FEDERATION_USER_CACHE_TTL_SECONDS": "300",
                "FEDERATION_OUTBOX_POLL_INTERVAL_SECONDS": "0.15",
                "FEDERATION_OUTBOX_BASE_DELAY_SECONDS": "0.15",
                "FEDERATION_OUTBOX_MAX_DELAY_SECONDS": "1.0",
                "FEDERATION_OUTBOX_MAX_ATTEMPTS": "3",
                "API_RATE_LIMIT_PER_MINUTE": "1000",
                "AUTH_RATE_LIMIT_PER_MINUTE": "200",
            }
        )
        return env

    node_a = FederatedNodeProcess(
        domain="node-a.local",
        port=port_a,
        base_http=url_a,
        base_ws=f"ws://127.0.0.1:{port_a}",
        db_path=tmp_path / "node_a.db",
        key_path=tmp_path / "keys_a" / "ed25519.json",
        storage_dir=tmp_path / "storage_a",
        env=make_env(
            "node-a.local",
            url_a,
            tmp_path / "node_a.db",
            tmp_path / "keys_a" / "ed25519.json",
            tmp_path / "storage_a",
        ),
    )
    node_b = FederatedNodeProcess(
        domain="node-b.local",
        port=port_b,
        base_http=url_b,
        base_ws=f"ws://127.0.0.1:{port_b}",
        db_path=tmp_path / "node_b.db",
        key_path=tmp_path / "keys_b" / "ed25519.json",
        storage_dir=tmp_path / "storage_b",
        env=make_env(
            "node-b.local",
            url_b,
            tmp_path / "node_b.db",
            tmp_path / "keys_b" / "ed25519.json",
            tmp_path / "storage_b",
        ),
    )

    await node_a.start()
    await node_b.start()
    try:
        yield node_a, node_b
    finally:
        await node_a.stop()
        await node_b.stop()


async def _signup_on_node(
    client: httpx.AsyncClient,
    username: str,
    display_name: str,
) -> SimulatedE2eePeer:
    peer = SimulatedE2eePeer(username)
    r = await client.post(
        "/auth/signup",
        json={
            "username": username,
            "password": "StrongPassword123!",
            "display_name": display_name,
            "public_key": peer.public_key_str,
            "device_name": f"{display_name} Browser",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    peer.access_token = body["access_token"]
    peer.user_id = body["user"]["id"]
    peer.global_id = body["user"]["global_id"]
    return peer


def _auth(peer: SimulatedE2eePeer) -> dict[str, str]:
    return {"Authorization": f"Bearer {peer.access_token}"}


async def _recv_until(ws: Any, target_event: str, timeout: float = 5.0) -> dict[str, Any]:
    deadline = asyncio.get_running_loop().time() + timeout
    while True:
        rem = deadline - asyncio.get_running_loop().time()
        if rem <= 0:
            raise TimeoutError(f"Timed out waiting for WS event '{target_event}'")
        raw = await asyncio.wait_for(ws.recv(), timeout=rem)
        pkt = json.loads(raw)
        if pkt.get("event") == target_event:
            return pkt


def _custom_sign_s2s_post(
    priv_key: Ed25519PrivateKey,
    *,
    path: str,
    raw_body: bytes,
    origin: str,
    dest: str,
    nonce: str | None = None,
    date_hdr: str | None = None,
    digest_override: str | None = None,
) -> dict[str, str]:
    eff_date = date_hdr or format_datetime(datetime.now(timezone.utc), usegmt=True)
    eff_digest = digest_override or compute_body_digest(raw_body)
    eff_nonce = nonce or secrets.token_urlsafe(20)
    signed_headers = [
        "(request-target)",
        "date",
        "digest",
        "x-federation-origin",
        "x-federation-destination",
        "x-federation-nonce",
    ]
    signing_str = "\n".join(
        [
            f"(request-target): post {path}",
            f"date: {eff_date}",
            f"digest: {eff_digest}",
            f"x-federation-origin: {origin}",
            f"x-federation-destination: {dest}",
            f"x-federation-nonce: {eff_nonce}",
        ]
    ).encode("utf-8")
    sig_b64 = base64.b64encode(priv_key.sign(signing_str)).decode("ascii")
    return {
        "Date": eff_date,
        "Digest": eff_digest,
        "X-Federation-Origin": origin,
        "X-Federation-Destination": dest,
        "X-Federation-Nonce": eff_nonce,
        "Signature": (
            f'keyId="http://{origin}/.well-known/node-key",'
            f'algorithm="ed25519",'
            f'headers="{" ".join(signed_headers)}",'
            f'signature="{sig_b64}"'
        ),
        "Content-Type": "application/json",
    }


@pytest.mark.asyncio
async def test_node_identity_remote_user_cache_and_ssrf_protection(
    two_federated_nodes: tuple[FederatedNodeProcess, FederatedNodeProcess],
) -> None:
    node_a, node_b = two_federated_nodes

    # 1. Verify SSRF protection blocks loopback, RFC1918, cloud metadata, IPv6-mapped loopback, and HTTP in prod
    assert is_disallowed_ip("127.0.0.1") is True
    assert is_disallowed_ip("10.12.0.5") is True
    assert is_disallowed_ip("172.16.10.1") is True
    assert is_disallowed_ip("192.168.1.20") is True
    assert is_disallowed_ip("169.254.169.254") is True
    assert is_disallowed_ip("100.64.1.1") is True
    assert is_disallowed_ip("::1") is True
    assert is_disallowed_ip("::ffff:127.0.0.1") is True

    with pytest.raises(AppError) as exc_https:
        await validate_federation_url(
            "http://example.com/.well-known/node-key",
            require_https=True,
            allow_private_ips=True,
        )
    assert exc_https.value.code == "FEDERATION_HTTPS_REQUIRED"

    with pytest.raises(AppError) as exc_ssrf:
        await validate_federation_url(
            "https://127.0.0.1/.well-known/node-key",
            require_https=True,
            allow_private_ips=False,
        )
    assert exc_ssrf.value.code == "FEDERATION_SSRF_BLOCKED"

    with pytest.raises(AppError) as exc_meta:
        await validate_federation_url(
            "https://169.254.169.254/latest/meta-data",
            require_https=True,
            allow_private_ips=False,
        )
    assert exc_meta.value.code == "FEDERATION_SSRF_BLOCKED"

    # 2. Verify /.well-known/node-key and /.well-known/node-info on both independent nodes
    async with (
        httpx.AsyncClient(base_url=node_a.base_http) as client_a,
        httpx.AsyncClient(base_url=node_b.base_http) as client_b,
    ):
        nk_a = (await client_a.get("/.well-known/node-key")).json()
        ni_a = (await client_a.get("/.well-known/node-info")).json()
        nk_b = (await client_b.get("/.well-known/node-key")).json()
        ni_b = (await client_b.get("/.well-known/node-info")).json()

        assert ni_a["domain"] == "node-a.local"
        assert ni_b["domain"] == "node-b.local"
        assert ni_a["public_key_ed25519"] == nk_a["public_key"]
        assert ni_b["public_key_ed25519"] == nk_b["public_key"]
        assert nk_a["public_key"] != nk_b["public_key"]
        assert "messages" in ni_a["capabilities"]

        # 3. Register Alice on Node A and Bob on Node B, then resolve Bob from Node A (caches with TTL)
        alice = await _signup_on_node(client_a, "alice", "Alice (Node A)")
        bob = await _signup_on_node(client_b, "bob", "Bob (Node B)")
        assert alice.global_id == "alice@node-a.local"
        assert bob.global_id == "bob@node-b.local"

        add_res = await client_a.post(
            "/contacts",
            headers=_auth(alice),
            json={"identifier": "bob@node-b.local", "nickname": "Bob Remote"},
        )
        assert add_res.status_code == 201, add_res.text
        added = add_res.json()
        assert added["user"]["global_id"] == "bob@node-b.local"
        assert added["user"]["public_key"] == bob.public_key_str

        # Status dashboard on Node A reflects cached remote user + online peer `node-b.local`
        st_a = (await client_a.get("/federation/status", headers=_auth(alice))).json()
        assert st_a["cached_remote_users"] >= 1
        peer_domains = {p["domain"]: p for p in st_a["peers"]}
        assert "node-b.local" in peer_domains
        assert peer_domains["node-b.local"]["status"] == "online"


@pytest.mark.asyncio
async def test_bidirectional_federation_chat_receipts_typing_calls_and_remote_file_download(
    two_federated_nodes: tuple[FederatedNodeProcess, FederatedNodeProcess],
) -> None:
    node_a, node_b = two_federated_nodes

    async with (
        httpx.AsyncClient(base_url=node_a.base_http) as client_a,
        httpx.AsyncClient(base_url=node_b.base_http) as client_b,
        AsyncExitStack() as stack,
    ):
        alice = await _signup_on_node(client_a, "alice", "Alice A")
        bob = await _signup_on_node(client_b, "bob", "Bob B")

        ws_alice = await stack.enter_async_context(
            websockets.connect(f"{node_a.base_ws}/ws?token={alice.access_token}")
        )
        await _recv_until(ws_alice, "session.ready")

        ws_bob = await stack.enter_async_context(
            websockets.connect(f"{node_b.base_ws}/ws?token={bob.access_token}")
        )
        await _recv_until(ws_bob, "session.ready")

        # 1. Alice starts 1:1 conversation with remote user `bob@node-b.local`
        conv_a_res = await client_a.post(
            "/conversations",
            headers=_auth(alice),
            json={"peer_username": "bob@node-b.local"},
        )
        assert conv_a_res.status_code == 201, conv_a_res.text
        conv_a = conv_a_res.json()
        conv_a_id = conv_a["id"]
        assert conv_a["peer"]["global_id"] == "bob@node-b.local"

        # 2. Alice -> Bob E2EE message across Node A -> Node B
        ct_ab, nonce_ab = alice.encrypt_for(
            bob.public_key_str, "Namaste Bob from Node A!"
        )
        await ws_alice.send(
            json.dumps(
                {
                    "event": "message.send",
                    "data": {
                        "conversation_id": conv_a_id,
                        "ciphertext": ct_ab,
                        "nonce": nonce_ab,
                        "type": "text",
                        "client_msg_id": "fed-ab-1",
                    },
                }
            )
        )

        # Bob receives live `message.new` on Node B's WebSocket and decrypts E2EE plaintext!
        bob_new = await _recv_until(ws_bob, "message.new")
        msg_on_b = bob_new["data"]
        assert msg_on_b["sender_global_id"] == "alice@node-a.local"
        assert (
            bob.decrypt_from(
                alice.public_key_str, msg_on_b["ciphertext"], msg_on_b["nonce"]
            )
            == "Namaste Bob from Node A!"
        )
        conv_b_id = msg_on_b["conversation_id"]

        # 3. Bob sends `read` receipt on Node B -> propagates back to Alice on Node A!
        await ws_bob.send(
            json.dumps(
                {
                    "event": "message.ack",
                    "data": {
                        "conversation_id": conv_b_id,
                        "status": "read",
                        "message_ids": [msg_on_b["id"]],
                    },
                }
            )
        )
        while True:
            ack_pkt = await _recv_until(ws_alice, "message.ack")
            if ack_pkt["data"].get("status") == "read":
                assert ack_pkt["data"]["message_id"] == msg_on_b["id"]
                break

        # 4. Typing indicator & WebRTC call offer cross from Node A -> Node B
        await ws_alice.send(
            json.dumps(
                {
                    "event": "typing.start",
                    "data": {"conversation_id": conv_a_id},
                }
            )
        )
        typing_pkt = await _recv_until(ws_bob, "typing.start")
        assert typing_pkt["data"]["global_id"] == "alice@node-a.local"

        await ws_alice.send(
            json.dumps(
                {
                    "event": "call.offer",
                    "data": {
                        "call_id": str(__import__("uuid").uuid4()),
                        "conversation_id": conv_a_id,
                        "to_global_id": "bob@node-b.local",
                        "call_type": "voice",
                        "payload": {"sdp": "v=0...mock-sdp-offer"},
                    },
                }
            )
        )
        call_pkt = await _recv_until(ws_bob, "call.offer")
        assert call_pkt["data"]["from_global_id"] == "alice@node-a.local"
        assert call_pkt["data"]["payload"]["sdp"] == "v=0...mock-sdp-offer"

        # 5. Reverse direction: Bob -> Alice E2EE message across Node B -> Node A!
        ct_ba, nonce_ba = bob.encrypt_for(
            alice.public_key_str, "Loud and clear from Node B!"
        )
        await ws_bob.send(
            json.dumps(
                {
                    "event": "message.send",
                    "data": {
                        "conversation_id": conv_b_id,
                        "ciphertext": ct_ba,
                        "nonce": nonce_ba,
                        "type": "text",
                        "client_msg_id": "fed-ba-1",
                    },
                }
            )
        )
        alice_new = await _recv_until(ws_alice, "message.new")
        assert alice_new["data"]["sender_global_id"] == "bob@node-b.local"
        assert (
            alice.decrypt_from(
                bob.public_key_str,
                alice_new["data"]["ciphertext"],
                alice_new["data"]["nonce"],
            )
            == "Loud and clear from Node B!"
        )

        # 6. Federated Encrypted File Download: Alice uploads encrypted blob on Node A -> Bob downloads via Node B!
        file_key = os.urandom(32)
        file_iv = os.urandom(12)
        plaintext_pdf = b"%PDF-1.7 Secret Cross-Node Contract Payload " * 40
        encrypted_chunk = AESGCM(file_key).encrypt(file_iv, plaintext_pdf, None)

        init_att = await client_a.post(
            "/attachments/init",
            headers=_auth(alice),
            json={
                "conversation_id": conv_a_id,
                "encrypted_filename": base64.b64encode(b"contract.pdf").decode(),
                "mime_type": "application/pdf",
                "total_size": len(plaintext_pdf),
                "chunk_size": 1_048_576,
                "chunk_count": 1,
                "file_nonce": base64.b64encode(file_iv).decode(),
            },
        )
        assert init_att.status_code == 201, init_att.text
        att_id = init_att.json()["attachment_id"]
        slot_url = init_att.json()["upload_urls"][0]["upload_url"]

        up_res = await client_a.put(
            slot_url,
            content=encrypted_chunk,
            headers={"Content-Type": "application/octet-stream"},
        )
        assert up_res.status_code == 200
        comp_res = await client_a.post(
            f"/attachments/{att_id}/complete", headers=_auth(alice)
        )
        assert comp_res.status_code == 200

        meta_json = json.dumps(
            {
                "text": "See attached PDF",
                "file_key": base64.b64encode(file_key).decode(),
                "file_iv": base64.b64encode(file_iv).decode(),
                "attachment_id": att_id,
            }
        )
        ct_doc, nonce_doc = alice.encrypt_for(bob.public_key_str, meta_json)
        send_doc = await client_a.post(
            "/messages",
            headers=_auth(alice),
            json={
                "conversation_id": conv_a_id,
                "ciphertext": ct_doc,
                "nonce": nonce_doc,
                "type": "document",
                "attachment_id": att_id,
            },
        )
        assert send_doc.status_code == 201

        bob_doc_msg = await _recv_until(ws_bob, "message.new")
        bob_att_id = bob_doc_msg["data"]["attachment_id"]
        assert bob_att_id is not None

        # Bob downloads encrypted blob from HIS OWN NODE (`client_b`), which fetches S2S from Node A!
        dl_res = await client_b.get(
            f"/attachments/{bob_att_id}/download",
            headers=_auth(bob),
        )
        assert dl_res.status_code == 200
        decrypted_pdf = AESGCM(file_key).decrypt(file_iv, dl_res.content, None)
        assert decrypted_pdf == plaintext_pdf


@pytest.mark.asyncio
async def test_offline_remote_node_queueing_backoff_recovery_and_dead_letter(
    two_federated_nodes: tuple[FederatedNodeProcess, FederatedNodeProcess],
) -> None:
    node_a, node_b = two_federated_nodes

    async with httpx.AsyncClient(base_url=node_a.base_http) as client_a:
        alice = await _signup_on_node(client_a, "alice_q", "Alice Queue")
        async with httpx.AsyncClient(base_url=node_b.base_http) as client_b:
            bob = await _signup_on_node(client_b, "bob_q", "Bob Queue")

        conv_res = await client_a.post(
            "/conversations",
            headers=_auth(alice),
            json={"peer_username": "bob_q@node-b.local"},
        )
        assert conv_res.status_code == 201
        conv_a_id = conv_res.json()["id"]

        # Increase max_attempts on Node A so messages keep retrying while Node B is stopped
        node_a.env["FEDERATION_OUTBOX_MAX_ATTEMPTS"] = "12"
        await node_a.stop()
        await node_a.start()

        # STOP Node B completely!
        await node_b.stop()

        # Alice sends 2 E2EE messages while Node B is DOWN
        ct1, n1 = alice.encrypt_for(bob.public_key_str, "Queued while Node B is offline #1")
        ct2, n2 = alice.encrypt_for(bob.public_key_str, "Queued while Node B is offline #2")

        r1 = await client_a.post(
            "/messages",
            headers=_auth(alice),
            json={
                "conversation_id": conv_a_id,
                "ciphertext": ct1,
                "nonce": n1,
                "type": "text",
            },
        )
        r2 = await client_a.post(
            "/messages",
            headers=_auth(alice),
            json={
                "conversation_id": conv_a_id,
                "ciphertext": ct2,
                "nonce": n2,
                "type": "text",
            },
        )
        assert r1.status_code == 201
        assert r2.status_code == 201

        # Wait briefly so Node A's outbox worker records failed delivery attempt & schedules backoff
        await asyncio.sleep(0.45)
        outbox_while_down = (
            await client_a.get("/federation/outbox?status=pending", headers=_auth(alice))
        ).json()
        assert len(outbox_while_down) >= 2
        assert outbox_while_down[0]["attempts"] >= 1

        # Bring Node B BACK ONLINE -> Node A's outbox worker recovers and delivers queued messages!
        await node_b.start()

        deadline = asyncio.get_running_loop().time() + 8.0
        while asyncio.get_running_loop().time() < deadline:
            st = (await client_a.get("/federation/status", headers=_auth(alice))).json()
            if st["outbox_stats"]["pending"] == 0 and st["outbox_stats"]["delivered"] >= 2:
                break
            await asyncio.sleep(0.2)
        else:
            st = (await client_a.get("/federation/status", headers=_auth(alice))).json()
            pytest.fail(f"Node A outbox did not drain after Node B recovered: {st['outbox_stats']}")

        # Bob connects to Node B and receives both queued messages in order!
        async with websockets.connect(
            f"{node_b.base_ws}/ws?token={bob.access_token}"
        ) as ws_bob:
            await _recv_until(ws_bob, "session.ready")
            m1 = await _recv_until(ws_bob, "message.new")
            m2 = await _recv_until(ws_bob, "message.new")
            texts = [
                bob.decrypt_from(
                    alice.public_key_str, m1["data"]["ciphertext"], m1["data"]["nonce"]
                ),
                bob.decrypt_from(
                    alice.public_key_str, m2["data"]["ciphertext"], m2["data"]["nonce"]
                ),
            ]
            assert texts == [
                "Queued while Node B is offline #1",
                "Queued while Node B is offline #2",
            ]

        # Also verify dead-letter transition after N failed tries!
        node_a.env["FEDERATION_OUTBOX_MAX_ATTEMPTS"] = "2"
        node_a.env["FEDERATION_OUTBOX_BASE_DELAY_SECONDS"] = "0.08"
        await node_a.stop()
        await node_a.start()
        await node_b.stop()

        ct_dlq, n_dlq = alice.encrypt_for(bob.public_key_str, "Will hit dead-letter")
        dlq_send = await client_a.post(
            "/messages",
            headers=_auth(alice),
            json={
                "conversation_id": conv_a_id,
                "ciphertext": ct_dlq,
                "nonce": n_dlq,
                "type": "text",
            },
        )
        assert dlq_send.status_code == 201

        deadline_dlq = asyncio.get_running_loop().time() + 6.0
        while asyncio.get_running_loop().time() < deadline_dlq:
            st_dlq = (
                await client_a.get("/federation/status", headers=_auth(alice))
            ).json()
            if st_dlq["outbox_stats"]["dead_letter"] >= 1:
                break
            await asyncio.sleep(0.15)
        else:
            pytest.fail("Outbox message did not transition to dead_letter after max_attempts")


@pytest.mark.asyncio
async def test_tampered_signature_digest_replay_skew_and_domain_allow_block_lists(
    two_federated_nodes: tuple[FederatedNodeProcess, FederatedNodeProcess],
) -> None:
    node_a, node_b = two_federated_nodes

    # Load Node A's real Ed25519 private key so we can craft valid & tampered S2S requests
    key_data_a = json.loads(node_a.key_path.read_text(encoding="utf-8"))
    priv_a = Ed25519PrivateKey.from_private_bytes(
        base64.b64decode(key_data_a["private_key_b64"])
    )
    rogue_priv = Ed25519PrivateKey.generate()

    async with (
        httpx.AsyncClient(base_url=node_a.base_http) as client_a,
        httpx.AsyncClient(base_url=node_b.base_http) as client_b,
    ):
        alice = await _signup_on_node(client_a, "alice_sec", "Alice Sec")
        bob_admin = await _signup_on_node(client_b, "bob_admin", "Bob Admin")
        carol_regular = await _signup_on_node(client_b, "carol_user", "Carol Regular")

        envelope_dict = {
            "event_id": "evt_sec_1",
            "event_type": "presence",
            "origin_domain": "node-a.local",
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "data": {
                "actor_global_id": alice.global_id,
                "is_online": True,
                "last_seen_at": datetime.now(timezone.utc).isoformat(),
                "target_global_ids": [bob_admin.global_id],
            },
        }
        raw_body = json.dumps(envelope_dict).encode("utf-8")

        # 1. Tampered Ed25519 signature (signed with wrong private key) -> 401 rejected!
        bad_sig_hdrs = _custom_sign_s2s_post(
            rogue_priv,
            path="/federation/inbox",
            raw_body=raw_body,
            origin="node-a.local",
            dest="node-b.local",
        )
        res_bad_sig = await client_b.post(
            "/federation/inbox", content=raw_body, headers=bad_sig_hdrs
        )
        assert res_bad_sig.status_code == 401
        assert res_bad_sig.json()["error"]["code"] == "FEDERATION_INVALID_SIGNATURE"

        # 2. Tampered JSON body after signing (Digest mismatch) -> 401 rejected!
        valid_hdrs_for_tamper = _custom_sign_s2s_post(
            priv_a,
            path="/federation/inbox",
            raw_body=raw_body,
            origin="node-a.local",
            dest="node-b.local",
        )
        tampered_body = json.dumps({**envelope_dict, "event_id": "evt_tampered"}).encode("utf-8")
        res_bad_digest = await client_b.post(
            "/federation/inbox", content=tampered_body, headers=valid_hdrs_for_tamper
        )
        assert res_bad_digest.status_code == 401
        assert res_bad_digest.json()["error"]["code"] == "FEDERATION_DIGEST_MISMATCH"

        # 3. Stale Date header (> 5 minutes old) -> 401 rejected!
        stale_date = format_datetime(
            datetime.now(timezone.utc) - timedelta(minutes=10), usegmt=True
        )
        stale_hdrs = _custom_sign_s2s_post(
            priv_a,
            path="/federation/inbox",
            raw_body=raw_body,
            origin="node-a.local",
            dest="node-b.local",
            date_hdr=stale_date,
        )
        res_stale = await client_b.post(
            "/federation/inbox", content=raw_body, headers=stale_hdrs
        )
        assert res_stale.status_code == 401
        assert res_stale.json()["error"]["code"] == "FEDERATION_TIMESTAMP_SKEW"

        # 4. Valid signed request succeeds (202), and replaying exact same nonce is rejected (409)!
        replay_nonce = "unique_replay_test_nonce_12345"
        good_hdrs = _custom_sign_s2s_post(
            priv_a,
            path="/federation/inbox",
            raw_body=raw_body,
            origin="node-a.local",
            dest="node-b.local",
            nonce=replay_nonce,
        )
        res_ok = await client_b.post(
            "/federation/inbox", content=raw_body, headers=good_hdrs
        )
        assert res_ok.status_code == 202

        res_replay = await client_b.post(
            "/federation/inbox", content=raw_body, headers=good_hdrs
        )
        assert res_replay.status_code == 409
        assert res_replay.json()["error"]["code"] == "FEDERATION_REPLAY_DETECTED"

        # 5. Admin Controls: non-admin gets 403; admin can block/allow domains!
        non_admin_attempt = await client_b.post(
            "/federation/domains",
            headers=_auth(carol_regular),
            json={"domain": "node-a.local", "rule": "block"},
        )
        assert non_admin_attempt.status_code == 403

        blk = await client_b.post(
            "/federation/domains",
            headers=_auth(bob_admin),
            json={"domain": "node-a.local", "rule": "block", "note": "Maintenance test"},
        )
        assert blk.status_code == 201

        blocked_hdrs = _custom_sign_s2s_post(
            priv_a,
            path="/federation/inbox",
            raw_body=raw_body,
            origin="node-a.local",
            dest="node-b.local",
        )
        res_blocked = await client_b.post(
            "/federation/inbox", content=raw_body, headers=blocked_hdrs
        )
        assert res_blocked.status_code == 403
        assert res_blocked.json()["error"]["code"] == "FEDERATION_DOMAIN_BLOCKED"

        # Switch to allowlist mode permitting `node-a.local` -> requests succeed again!
        pol = await client_b.put(
            "/federation/policy",
            headers=_auth(bob_admin),
            json={
                "mode": "allowlist",
                "allow_domains": ["node-a.local"],
                "block_domains": [],
            },
        )
        assert pol.status_code == 200
        assert pol.json()["policy_mode"] == "allowlist"

        allowed_hdrs = _custom_sign_s2s_post(
            priv_a,
            path="/federation/inbox",
            raw_body=raw_body,
            origin="node-a.local",
            dest="node-b.local",
        )
        res_allowed = await client_b.post(
            "/federation/inbox", content=raw_body, headers=allowed_hdrs
        )
        assert res_allowed.status_code == 202


async def _signup_group_peer_on_node(
    client: httpx.AsyncClient,
    username: str,
    display_name: str,
) -> SimulatedGroupPeer:
    peer = SimulatedGroupPeer(username, display_name)
    r = await client.post(
        "/auth/signup",
        json={
            "username": username,
            "password": "StrongPassword123!",
            "display_name": display_name,
            "public_key": peer.public_key_str,
            "device_name": f"{display_name} Browser",
        },
    )
    assert r.status_code == 201, r.text
    body = r.json()
    peer.access_token = body["access_token"]
    peer.user_id = body["user"]["id"]
    peer.global_id = body["user"]["global_id"]
    return peer


@pytest.mark.asyncio
async def test_federated_group_chat_across_nodes(
    two_federated_nodes: tuple[FederatedNodeProcess, FederatedNodeProcess],
) -> None:
    node_a, node_b = two_federated_nodes

    async with (
        httpx.AsyncClient(base_url=node_a.base_http) as client_a,
        httpx.AsyncClient(base_url=node_b.base_http) as client_b,
        AsyncExitStack() as stack,
    ):
        alice = await _signup_group_peer_on_node(client_a, "alice_grp", "Alice Group")
        priya = await _signup_group_peer_on_node(client_a, "priya_grp", "Priya Group")
        bob = await _signup_group_peer_on_node(client_b, "bob_grp", "Bob Remote Group")

        ws_bob = await stack.enter_async_context(
            websockets.connect(f"{node_b.base_ws}/ws?token={bob.access_token}")
        )
        await _recv_until(ws_bob, "session.ready")

        # Alice creates a 3-member cross-node group on Node A including `bob_grp@node-b.local`
        grp_res = await client_a.post(
            "/groups",
            headers={"Authorization": f"Bearer {alice.access_token}"},
            json={
                "name": "Cross-Node Federated Squad",
                "description": "Node A + Node B E2EE Group",
                "member_ids": [priya.user_id, "bob_grp@node-b.local"],
            },
        )
        assert grp_res.status_code == 201, grp_res.text
        group = grp_res.json()
        group_id = group["id"]

        # Bob on Node B receives `group.created` over WebSocket via S2S federation!
        grp_created_pkt = await _recv_until(ws_bob, "group.created")
        assert grp_created_pkt["data"]["group_id"] == group_id

        # Alice generates her v1 Sender Key and distributes wrapped envelopes (including to remote Bob!)
        alice_sk = os.urandom(32)
        envelopes = []
        for m in group["members"]:
            wrapped, w_nonce = alice.wrap_sender_key_for(
                group_id, 1, m["public_key"], alice_sk
            )
            envelopes.append(
                {
                    "recipient_id": m["user_id"],
                    "wrapped_key": wrapped,
                    "nonce": w_nonce,
                }
            )

        dist_res = await client_a.post(
            f"/groups/{group_id}/keys",
            headers={"Authorization": f"Bearer {alice.access_token}"},
            json={"key_version": 1, "envelopes": envelopes},
        )
        assert dist_res.status_code == 200

        # Bob receives `group.sender_key_available` on Node B and fetches his wrapped key from Node B!
        await _recv_until(ws_bob, "group.sender_key_available")
        bob_keys = (
            await client_b.get(
                f"/groups/{group_id}/keys?key_version=1",
                headers={"Authorization": f"Bearer {bob.access_token}"},
            )
        ).json()
        assert len(bob_keys) == 1
        unwrapped_by_bob = bob.unwrap_sender_key_from(
            group_id,
            1,
            bob_keys[0]["sender_public_key"],
            bob_keys[0]["wrapped_key"],
            bob_keys[0]["nonce"],
        )
        assert unwrapped_by_bob == alice_sk

        # Alice sends a Sender-Key-encrypted group message on Node A -> Bob receives & decrypts on Node B!
        ct_grp, n_grp = SimulatedGroupPeer.encrypt_group_msg(
            group_id,
            alice.user_id,
            1,
            alice_sk,
            "Hello across nodes @bob_grp!",
        )
        send_grp = await client_a.post(
            "/messages",
            headers={"Authorization": f"Bearer {alice.access_token}"},
            json={
                "conversation_id": group_id,
                "ciphertext": ct_grp,
                "nonce": n_grp,
                "type": "text",
                "sender_key_version": 1,
                "mentions": ["bob_grp@node-b.local"],
            },
        )
        assert send_grp.status_code == 201

        while True:
            pkt = await _recv_until(ws_bob, "message.new")
            if pkt["data"]["type"] == "text":
                decrypted_txt = SimulatedGroupPeer.decrypt_group_msg(
                    group_id,
                    pkt["data"]["sender_id"],
                    1,
                    unwrapped_by_bob,
                    pkt["data"]["ciphertext"],
                    pkt["data"]["nonce"],
                )
                assert decrypted_txt == "Hello across nodes @bob_grp!"
                break
