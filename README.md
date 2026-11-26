# RelayChat (`@chatapp.in`)

**RelayChat** is a federated, end-to-end encrypted (E2EE) web messenger with an original two-pane desktop interface. Every deployment runs as an independent node with its own domain (default: `chatapp.in`) and MySQL 8 database, while browser clients generate **ECDH P-256** identity keys via the Web Crypto API and keep private keys exclusively inside **IndexedDB**.

---

## Monorepo Structure

```text
.
├── backend/
│   ├── alembic/                 # Alembic migrations (0001_initial_schema)
│   ├── app/
│   │   ├── api/                 # FastAPI dependencies & route modules
│   │   ├── core/                # Config, Argon2id/JWT/Ed25519 security, rate limits, logging
│   │   ├── db/                  # SQLAlchemy 2.x async engine & declarative base
│   │   ├── models/              # MySQL 8 models (users, devices, refresh_tokens, messages, ...)
│   │   ├── schemas/             # Strict Pydantic v2 request/response validation
│   │   └── services/            # Auth, token-rotation, and user availability services
│   ├── scripts/seed.py          # Demo user seeder + sample encrypted key backups
│   └── tests/                   # Pytest async test suite
├── frontend/
│   └── src/
│       ├── app/                 # Next.js 14 App Router (/, /signup, /login)
│       ├── components/          # RelayChat two-pane shell, drawers & key restore modal
│       ├── lib/crypto/          # Web Crypto ECDH P-256, AES-256-GCM, PBKDF2 backup & IndexedDB
│       ├── middleware.ts        # Protected route middleware
│       └── store/               # Zustand auth & keystore state
├── coturn/turnserver.conf       # STUN/TURN server config for WebRTC calls
├── docker-compose.yml           # mysql (8.0), api (FastAPI), web (Next.js), coturn
└── .env.example                 # Environment template
```

---

## API Endpoints (Phases 1–4)

- `POST /auth/signup` — Create identity `username@<APP_DOMAIN>`, Argon2id password hash, store P-256 public key (rejects any private key material `"d"`), register device & issue JWT access + refresh tokens
- `POST /auth/login` — Authenticate local user, register device session & issue tokens
- `POST /auth/refresh` — Single-use refresh token rotation via `refresh_tokens` table (replaying a rotated token revokes the device session)
- `POST /auth/logout` — Revoke current device session & clear auth cookies
- `GET /users/check-username/{username}` — Live username validation (`3–20` chars, `a-z 0-9 _ .`) & availability check
- `GET /users/me`, `PATCH /users/me`, `DELETE /users/me` — Fetch & update profile (`display_name`, `about`, `avatar_url`, 3-tier `everyone`/`contacts`/`nobody` privacy for `last_seen`, `profile_photo`, and `read_receipts`, notifications, theme & chat wallpaper), plus permanent account deletion
- `POST /users/me/avatar` — Validated avatar upload (resized & cropped to 256×256 client-side)
- `GET /users/me/devices`, `DELETE /users/me/devices/{device_id}`, `DELETE /users/me/devices` — Linked devices list, single-device logout, and log out all other devices (revokes refresh tokens + closes active WebSockets)
- `GET /users/profile/{identifier}` & `GET /users/search?q=...` — Server-enforced peer profile & directory lookup (filters `last_seen_at`, `is_online`, and `avatar_url` by privacy scope and block rules)
- `GET /contacts`, `POST /contacts`, `PATCH /contacts/{contact_user_id}`, `DELETE /contacts/{contact_user_id}` — Address book by full ID (`username@domain` or `relaychat:username@domain` QR URI) with local node resolution, nicknames, and Phase 8 federation lookup hook
- `GET /blocks`, `POST /blocks`, `DELETE /blocks/{blocked_user_id}` — Server-enforced block/unblock (blocks REST & WebSocket messaging, typing indicators, live presence, and `last_seen_at`)
- `GET /.well-known/user/{username}` — Federation user discovery (`{id: "user@domain", public_key, node, ...}`)
- `GET /.well-known/node-key` — Node Ed25519 public signing key discovery
- `GET /conversations`, `POST /conversations`, `PATCH /conversations/{id}` — 1:1 conversation list, creation, pin & mute settings
- `GET /conversations/{id}/messages?cursor=...&limit=40` — Opaque cursor-paginated ciphertext message history
- `POST /messages`, `PATCH /messages/{id}`, `DELETE /messages/{id}?scope=me|everyone` — REST message fallback, 15-minute sender edit window, and delete for me / delete for everyone
- `WS /ws?token=...&since=...` — JWT-authenticated realtime WebSocket (`message.send` / `message.new`, server-clamped `message.ack` for `sent`/`delivered`/`read`, `message.updated`, `message.deleted`, `typing.start`/`typing.stop`, privacy-filtered `presence.online`/`presence.offline`, offline DB queue flush & missed-event resume)

---

## Running Locally

### Option 1: Docker Compose (MySQL 8 + API + Web + Coturn)

```bash
cp .env.example .env
docker compose up --build
```

- Frontend: `http://localhost:3000`
- Backend OpenAPI Docs: `http://localhost:8000/docs`

### Option 2: Direct Dev Servers

```bash
# Backend
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/alembic upgrade head
.venv/bin/python scripts/seed.py
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000

# Frontend (separate terminal)
cd frontend
npm install
BACKEND_INTERNAL_URL=http://127.0.0.1:8000 npm run dev
```

### Running Tests

```bash
# Backend integration & realtime E2EE WebSocket tests
cd backend
.venv/bin/pytest -v

# Frontend Web Crypto E2EE unit tests (ECDH P-256 -> HKDF-SHA256 -> AES-256-GCM)
cd ../frontend
npm run test:crypto
```

