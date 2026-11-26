# RelayChat Production Deployment & Multi-Node Federation Guide

This guide covers deploying **RelayChat (`chatapp.in`)** in production with **Docker Compose + Nginx + Let's Encrypt HTTPS**, configuring required secrets, running automated MySQL backups, and deploying a **second independent node** (`chat.partner.org`) that federates seamlessly with your primary node.

---

## 1. Prerequisites

- A Linux VPS/VM (Ubuntu 22.04/24.04 LTS or Debian 12+, 2+ vCPU, 4 GB+ RAM)
- Docker Engine 24+ and Docker Compose v2 (`docker compose version`)
- A domain name (e.g., `chatapp.in`) with DNS `A` / `AAAA` records pointing to your server IP
- Open firewall ports:
  - `80/tcp` (Let's Encrypt HTTP-01 challenge + HTTPS redirect)
  - `443/tcp` (HTTPS Web UI, REST API, `/ws` WebSocket, & S2S `/federation/*`)
  - `3478/tcp+udp`, `5349/tcp+udp` (Coturn STUN/TURN for WebRTC calls)

---

## 2. Environment Variable Reference (`.env`)

Copy `.env.example` to `.env` and set production secrets before launching:

| Variable | Required | Description |
| --- | --- | --- |
| `APP_DOMAIN` | Yes | Canonical domain for user handles (`alice@<APP_DOMAIN>`) and S2S signatures |
| `JWT_SECRET_KEY` | Yes | 32+ byte random secret (`openssl rand -hex 32`) |
| `UPLOAD_SIGNING_SECRET` | Yes | 32+ byte random secret signing pre-authorized encrypted chunk upload URLs |
| `MYSQL_ROOT_PASSWORD` | Yes | Strong root password for MySQL 8 |
| `MYSQL_PASSWORD` | Yes | Application database password for `relaychat` user |
| `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` | Yes | Credentials for S3-compatible encrypted chunk storage |
| `NODE_PRIVATE_KEY_B64` | Recommended | Base64 32-byte Ed25519 seed so your node's S2S identity persists across container rebuilds |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | Recommended | ECDSA P-256 keypair (base64url) for Web Push notifications |
| `VAPID_SUBJECT` | Recommended | Contact URI for push services (`mailto:ops@chatapp.in`) |
| `BACKUP_PASSPHRASE` | Optional | Encrypts nightly `mysqldump` archives with AES-256-CBC (PBKDF2) |
| `FILE_SCANNER_CMD` | Optional | Optional external scanner CLI (e.g. `clamdscan --no-summary`) run on uploaded blobs |

### Generating Persistent Ed25519 & VAPID Keys

Run once using the backend container or Python venv:

```bash
python3 - <<'PY'
import base64
from cryptography.hazmat.primitives.asymmetric import ec, ed25519
from cryptography.hazmat.primitives import serialization

ed_priv = ed25519.Ed25519PrivateKey.generate()
ed_b64 = base64.b64encode(ed_priv.private_bytes_raw()).decode()

vapid_priv = ec.generate_private_key(ec.SECP256R1())
d_b64 = base64.urlsafe_b64encode(
    vapid_priv.private_numbers().private_value.to_bytes(32, "big")
).rstrip(b"=").decode()
pub_b64 = base64.urlsafe_b64encode(
    vapid_priv.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
).rstrip(b"=").decode()

print(f"NODE_PRIVATE_KEY_B64={ed_b64}")
print(f"VAPID_PRIVATE_KEY={d_b64}")
print(f"VAPID_PUBLIC_KEY={pub_b64}")
PY
```

---

## 3A. Deploying on an Existing Caddy Server (Multi-Project VPS — Recommended)

If your VPS already runs **Caddy** on ports `80`/`443` and hosts other apps on ports like `3000`, `3002`, `3030`, `8000`, `8011–8013`, `8033`, `3306`, etc., use **`docker-compose.caddy.yml`**:

- **Zero impact on existing projects**: MySQL & Redis stay 100% private inside Docker (`relaychat_internal` network, no host ports).
- **Isolated loopback ports**: Frontend binds only to `127.0.0.1:3045` and Backend binds only to `127.0.0.1:8045`.

```bash
# 1. Generate production .env with strong random secrets for your domain
chmod +x scripts/*.sh
./scripts/setup_prod_env.sh YOUR_DOMAIN.COM

# 2. Build & start RelayChat containers in the background
docker compose -f docker-compose.caddy.yml up -d --build

# 3. Append deploy/caddy/Caddyfile.relaychat to /etc/caddy/Caddyfile
#    (replace chatapp.in with YOUR_DOMAIN.COM), validate, and reload Caddy:
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
```

See `deploy/caddy/Caddyfile.relaychat` and `deploy/caddy/Caddyfile.srv1066951.example` for the ready-to-paste Caddy configuration.

---

## 3B. Standalone Nginx + Let's Encrypt Deployment (`docker-compose.prod.yml`)

1. Issue the initial Let's Encrypt TLS certificate for `SERVER_DOMAIN`:
   ```bash
   export SERVER_DOMAIN=chatapp.in
   docker compose -f docker-compose.prod.yml run --rm --entrypoint "\
     certbot certonly --standalone \
     -d ${SERVER_DOMAIN} \
     --email admin@${SERVER_DOMAIN} \
     --agree-tos --no-eff-email" certbot
   ```
2. Start the full production stack:
   ```bash
   chmod +x scripts/backup_mysql.sh scripts/audit_dependencies.sh
   docker compose -f docker-compose.prod.yml up -d --build
   ```
3. Verify health & federation discovery:
   ```bash
   curl -fsS https://chatapp.in/health
   curl -fsS https://chatapp.in/.well-known/chat-server
   ```

---

## 4. Deploying a Second Node & Federating (`chatapp.in` ↔ `node2.org`)

RelayChat uses decentralized **Server-to-Server (S2S) Ed25519 Signed Federation** — any organization or individual can self-host an independent node and message users on `chatapp.in` end-to-end encrypted!

### Step-by-step on Server B (`node2.org`):

1. Clone this repository onto Server B and point `node2.org`'s DNS `A`/`AAAA` record to Server B's public IP.
2. Create `.env` on Server B with:
   ```env
   ENVIRONMENT=production
   APP_DOMAIN=node2.org
   NODE_PUBLIC_URL=https://node2.org
   FRONTEND_URL=https://node2.org
   FEDERATION_ENABLED=true
   FEDERATION_REQUIRE_HTTPS=true
   ```
   *(Generate fresh `JWT_SECRET_KEY`, `UPLOAD_SIGNING_SECRET`, `NODE_PRIVATE_KEY_B64`, and `VAPID_*` keys for `node2.org` — never share private keys between nodes!)*
3. Obtain Let's Encrypt certs for `node2.org` and run:
   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```
4. Verify discovery from Node A -> Node B and Node B -> Node A:
   ```bash
   curl -fsS https://node2.org/.well-known/chat-server
   # Returns:
   # {
   #   "domain": "node2.org",
   #   "protocol_version": "1.0",
   #   "api_base_url": "https://node2.org",
   #   "inbox_url": "https://node2.org/federation/inbox",
   #   "signing_public_key": "<Ed25519 base64>",
   #   ...
   # }
   ```
5. **Start chatting across domains!**
   - Log into `https://chatapp.in` as `alice@chatapp.in`.
   - Open **New Chat**, type `bob@node2.org`, and click **Start E2EE Chat**.
   - `chatapp.in` automatically:
     1. Fetches `https://node2.org/.well-known/chat-server` and pins `node2.org`'s Ed25519 signing key (**Trust-On-First-Use**).
     2. Queries `/federation/users/bob` to fetch Bob's P-256 E2EE public key (browser derives ECDH shared key directly with Bob — neither server ever sees plaintext!).
     3. Delivers signed envelopes (`X-Federation-Domain`, `X-Federation-Timestamp`, `X-Federation-Nonce`, `X-Federation-Signature`) to `https://node2.org/federation/inbox` with durable outbox retries if `node2.org` is temporarily offline.
6. **Domain Allowlist / Blocklist Administration**:
   - Node admins (`is_admin=True`) can inspect peer health, outbox queue metrics, and set `allow` / `block` domain policies directly in **Settings -> Federation & Peer Nodes** (or via `PUT /federation/admin/policy`).

### Local Two-Node Federation Sandbox (Single Machine)

To test federation locally without public DNS, run:

```bash
docker compose -f docker-compose.federation.yml up --build
```

This launches `alpha.local` (`:8001` / `:3001`) and `beta.local` (`:8002` / `:3002`) with full cross-domain E2EE DM, group Sender Keys, media relay, typing, and receipts.

---

## 5. Backups & Prometheus Monitoring

- **Manual On-Demand MySQL Backup**:
  ```bash
  ./scripts/backup_mysql.sh
  ```
- **Restore from Encrypted Backup**:
  ```bash
  PASS_ENV="$BACKUP_PASSPHRASE" openssl enc -d -aes-256-cbc -pbkdf2 -iter 250000 \
    -pass env:PASS_ENV -in backup.sql.gz.enc | gunzip | mysql -h 127.0.0.1 -u relaychat -p relaychat
  ```
- **Prometheus Scrape Target**:
  Configure Prometheus to scrape `http://backend:8000/metrics` (exposes `relaychat_http_requests_total`, `relaychat_ws_active_connections`, `relaychat_rate_limit_rejections_total`, and `relaychat_attachment_scans_total`).
