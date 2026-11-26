import base64
import json
import os
from pathlib import Path
from typing import AsyncGenerator

import pytest
import pytest_asyncio
from cryptography.hazmat.primitives.asymmetric import ec
from httpx import ASGITransport, AsyncClient

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///./test_phase1.db"
os.environ["APP_NAME"] = "RelayChat"
os.environ["APP_DOMAIN"] = "chatapp.in"
os.environ["NODE_KEY_PATH"] = "./.node_keys/test_node_ed25519.json"

from app.core.config import get_settings  # noqa: E402
from app.core.rate_limit import rate_limiter  # noqa: E402
from app.core.security import sign_ed25519, verify_ed25519  # noqa: E402
from app.db.base import Base  # noqa: E402
from app.db.session import engine  # noqa: E402
from app.main import app  # noqa: E402


def make_p256_public_jwk(include_private: bool = False) -> str:
    priv = ec.generate_private_key(ec.SECP256R1())
    nums = priv.private_numbers()
    pub = nums.public_numbers

    def b64u(val: int) -> str:
        return base64.urlsafe_b64encode(val.to_bytes(32, "big")).rstrip(b"=").decode("ascii")

    jwk: dict[str, object] = {
        "kty": "EC",
        "crv": "P-256",
        "x": b64u(pub.x),
        "y": b64u(pub.y),
        "ext": True,
    }
    if include_private:
        jwk["d"] = b64u(nums.private_value)
    return json.dumps(jwk)


@pytest_asyncio.fixture(autouse=True)
async def setup_db() -> AsyncGenerator[None, None]:
    rate_limiter.reset()
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.drop_all)
        await conn.run_sync(Base.metadata.create_all)
    yield
    for p in (Path("./test_phase1.db"), Path("./.node_keys/test_node_ed25519.json")):
        if p.exists():
            p.unlink()


@pytest.mark.asyncio
async def test_check_username_signup_and_well_known() -> None:
    pub_jwk = make_p256_public_jwk()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        # 1. Live username check before signup -> valid & available
        chk1 = await client.get("/users/check-username/rahul_01")
        assert chk1.status_code == 200
        assert chk1.json() == {
            "username": "rahul_01",
            "id": "rahul_01@chatapp.in",
            "valid": True,
            "available": True,
            "reason": None,
        }

        # Invalid username format check -> valid=False
        chk_bad = await client.get("/users/check-username/ab")
        assert chk_bad.status_code == 200
        assert chk_bad.json()["valid"] is False
        assert chk_bad.json()["available"] is False

        # 2. Signup via POST /auth/signup
        resp = await client.post(
            "/auth/signup",
            json={
                "username": "rahul_01",
                "password": "StrongPassword123!",
                "display_name": "Rahul Sharma",
                "public_key": pub_jwk,
            },
        )
        assert resp.status_code == 201, resp.text
        data = resp.json()
        assert data["user"]["username"] == "rahul_01"
        assert data["user"]["global_id"] == "rahul_01@chatapp.in"
        assert "d" not in json.loads(data["user"]["public_key"])
        assert "relaychat_refresh" in resp.cookies

        # 3. Username check now reports unavailable
        chk2 = await client.get("/users/check-username/rahul_01")
        assert chk2.status_code == 200
        assert chk2.json()["valid"] is True
        assert chk2.json()["available"] is False

        # 4. Duplicate signup rejected with 409
        dup = await client.post(
            "/auth/signup",
            json={
                "username": "rahul_01",
                "password": "StrongPassword123!",
                "public_key": pub_jwk,
            },
        )
        assert dup.status_code == 409
        assert dup.json()["error"]["code"] == "USERNAME_TAKEN"

        # 5. GET /.well-known/user/{username} -> {id: "user@domain", public_key, node, ...}
        wk = await client.get("/.well-known/user/rahul_01")
        assert wk.status_code == 200
        wk_data = wk.json()
        assert wk_data["id"] == "rahul_01@chatapp.in"
        assert wk_data["node"] == "http://testserver"
        assert json.loads(wk_data["public_key"])["crv"] == "P-256"

        # 6. GET /.well-known/node-key
        nk = await client.get("/.well-known/node-key")
        assert nk.status_code == 200
        nk_data = nk.json()
        msg = b'{"event":"ping"}'
        sig = sign_ed25519(msg)
        assert verify_ed25519(nk_data["public_key"], msg, sig) is True


@pytest.mark.asyncio
async def test_private_key_upload_rejected_and_username_rules() -> None:
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        leaked_jwk = make_p256_public_jwk(include_private=True)
        resp = await client.post(
            "/auth/signup",
            json={
                "username": "alice",
                "password": "StrongPassword123!",
                "public_key": leaked_jwk,
            },
        )
        assert resp.status_code == 422
        assert resp.json()["error"]["code"] == "VALIDATION_ERROR"

        for invalid_name in ("ab", "UPPERCASE", "has space", "bad-dash", "x" * 21):
            bad = await client.post(
                "/auth/signup",
                json={
                    "username": invalid_name,
                    "password": "StrongPassword123!",
                    "public_key": make_p256_public_jwk(),
                },
            )
            assert bad.status_code == 422, f"Expected 422 for {invalid_name}"


@pytest.mark.asyncio
async def test_login_refresh_rotation_profile_and_logout() -> None:
    pub_jwk = make_p256_public_jwk()
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        s1 = await client.post(
            "/auth/signup",
            json={
                "username": "priya.v",
                "password": "StrongPassword123!",
                "display_name": "Priya",
                "public_key": pub_jwk,
                "device_name": "Desktop Firefox",
            },
        )
        assert s1.status_code == 201
        token_dev1 = s1.json()["access_token"]

        # Login on second device via POST /auth/login
        client.cookies.clear()
        login2 = await client.post(
            "/auth/login",
            json={
                "username": "priya.v",
                "password": "StrongPassword123!",
                "device_name": "Mobile Chrome",
            },
        )
        assert login2.status_code == 200
        token_dev2 = login2.json()["access_token"]
        refresh_first = login2.json()["refresh_token"]

        # Rotate refresh token via POST /auth/refresh
        rot = await client.post("/auth/refresh", json={"refresh_token": refresh_first})
        assert rot.status_code == 200
        refresh_second = rot.json()["refresh_token"]
        assert refresh_second != refresh_first

        # Replaying old refresh token revokes device 2
        replay = await client.post("/auth/refresh", json={"refresh_token": refresh_first})
        assert replay.status_code == 401
        assert replay.json()["error"]["code"] == "REFRESH_TOKEN_REUSED"

        client.cookies.clear()
        revoked_check = await client.get(
            "/users/me",
            headers={"Authorization": f"Bearer {token_dev2}"},
        )
        assert revoked_check.status_code == 401
        assert revoked_check.json()["error"]["code"] == "DEVICE_REVOKED"

        # Device 1 updates profile via PATCH /users/me and fetches GET /users/me
        patch_resp = await client.patch(
            "/users/me",
            headers={"Authorization": f"Bearer {token_dev1}"},
            json={"display_name": "Priya Verma", "about": "Federated E2EE user"},
        )
        assert patch_resp.status_code == 200
        assert patch_resp.json()["display_name"] == "Priya Verma"

        me_resp = await client.get(
            "/users/me",
            headers={"Authorization": f"Bearer {token_dev1}"},
        )
        assert me_resp.status_code == 200
        assert me_resp.json()["about"] == "Federated E2EE user"

        # Logout revokes current device
        out_resp = await client.post(
            "/auth/logout",
            headers={"Authorization": f"Bearer {token_dev1}"},
        )
        assert out_resp.status_code == 200
        after_logout = await client.get(
            "/users/me",
            headers={"Authorization": f"Bearer {token_dev1}"},
        )
        assert after_logout.status_code == 401


@pytest.mark.asyncio
async def test_auth_rate_limiting() -> None:
    limit = get_settings().AUTH_RATE_LIMIT_PER_MINUTE
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://testserver") as client:
        for _ in range(limit):
            r = await client.post(
                "/auth/login",
                json={"username": "nonexistent", "password": "wrongpassword"},
            )
            assert r.status_code == 401

        blocked = await client.post(
            "/auth/login",
            json={"username": "nonexistent", "password": "wrongpassword"},
        )
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "RATE_LIMITED"
