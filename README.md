# RelayChat (`chatapp.in`) — Federated End-to-End Encrypted Messenger

**RelayChat** is a self-hostable, decentralized, end-to-end encrypted (E2EE) real-time messaging platform inspired by WhatsApp's clean user experience and Matrix/ActivityPub's open federation model. Every user owns a portable federated handle (`username@domain`, e.g., `rahul@chatapp.in`), holds their cryptographic identity keys strictly in their browser's IndexedDB, and can communicate seamlessly across independent self-hosted nodes.

---

## Architecture Diagram

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                        Browser / PWA Client (Next.js 14 + React)                     │
│  ┌──────────────────────┐  ┌─────────────────────────┐  ┌─────────────────────────┐  │
│  │ Web Crypto E2EE Core │  │ IndexedDB Keystore      │  │ Service Worker (/sw.js) │  │
│  │ • ECDH P-256 + HKDF  │  │ • Device Identity JWK   │  │ • Offline PWA Shell     │  │
│  │ • AES-256-GCM DMs    │  │ • Group Sender Keys vN  │  │ • Default "New message" │  │
│  │ • 1MB Media Chunks   │  │ • PBKDF2 Backup Export  │  │ • Opt-in Local Decrypt  │  │
│  │ • 24h Status Keys    │  └─────────────────────────┘  └─────────────────────────┘  │
│  └──────────┬───────────┘                                             ▲              │
└─────────────┼─────────────────────────────────────────────────────────┼──────────────┘
              │ HTTPS REST + WSS (/ws) + Chunked Ciphertext Uploads     │ VAPID Push
              ▼                                                         │
┌───────────────────────────────────────────────────────────────────────┴──────────────┐
│                     Node A: chatapp.in (Nginx TLS 1.3 Reverse Proxy)                 │
│  ┌────────────────────────────────────────────────────────────────────────────────┐  │
│  │                     FastAPI Async Server (Python 3.11+)                        │  │
│  │  • Argon2id Auth + JWT Refresh Rotation    • 24h Status & Disappearing Worker  │  │
│  │  • Multi-Device WebSocket Hub (/ws)        • VAPID Web Push Dispatcher         │  │
│  │  • Pluggable Attachment Scanner Hook       • Prometheus Metrics (/metrics)     │  │
│  │  • Sliding-Window Rate Limiter + CSP       • Ed25519 S2S Federation Inbox/Out  │  │
│  └────────┬─────────────────────────┬──────────────────────────┬──────────────────┘  │
│           ▼                         ▼                          │                     │
│  ┌─────────────────┐     ┌─────────────────────┐               │ Ed25519 Signed S2S  │
│  │ MySQL 8.4       │     │ Encrypted Blobs     │               │ • /.well-known/...  │
│  │ (Ciphertext,    │     │ (Local Disk or      │               │ • X-Federation-Sig  │
│  │  Sender Keys,   │     │  MinIO / S3)        │               │ • Durable Outbox    │
│  │  Outbox, Views) │     └─────────────────────┘               │                     │
│  └─────────────────┘                                           ▼                     │
└────────────────────────────────────────────────────────────────┼─────────────────────┘
                                                                 │ HTTPS + SSRF Guard
                                                                 ▼
                                        ┌──────────────────────────────────────────────┐
                                        │   Node B: partner.org (Independent Server)   │
                                        │   • Pins chatapp.in Ed25519 key (TOFU)       │
                                        │   • Verifies timestamp/nonce/body signature  │
                                        │   • Relays E2EE envelopes to local users     │
                                        └──────────────────────────────────────────────┘
```

---

## Core Feature Summary (Phases 1–9)

| Capability | Cryptographic / Architectural Design |
| --- | --- |
| **Federated Identity & Auth** | `username@domain` handles, Argon2id password hashing, per-device JWT access + rotating `HttpOnly` refresh cookies, QR Safety Number verification, and PBKDF2-SHA256 (250k iter) + AES-256-GCM `.relaykey.json` key backup. |
| **1:1 Real-Time E2EE Chat** | Browser Web Crypto ECDH (P-256) → HKDF-SHA256 → AES-256-GCM per message with random 96-bit nonces. Real-time `/ws` delivery, offline queueing, `sent` / `delivered` / `read` ticks, replies, edits, tombstones, reactions, starring, forwarding, disappearing timers, archiving, pinning, and client-side chat export (`.txt` / `.json`). |
| **Encrypted Media, Voice & Location** | Per-attachment random 256-bit AES-GCM key, 1 MB chunked streaming encryption (`<= 100 MB`), MediaRecorder Opus voice notes with waveform visualization, and OpenStreetMap/Leaflet static & live location sharing. |
| **WebRTC 1:1 Voice & Video Calls** | Live `/ws` & federated S2S call signaling (`call.offer`, `call.answer`, `call.ice_candidate`, `call.hangup`, `call.decline`) paired with Coturn STUN/TURN configuration for DTLS-SRTP peer-to-peer calls. |
| **E2EE Groups (Sender Keys)** | Signal-style per-sender 256-bit group `SenderKey` wrapped individually for each member, automatic `key_version` rotation on member removal/leave so removed members cannot decrypt future messages, admin roles, `@mentions`, and invite links. |
| **Decentralized S2S Federation** | `/.well-known/chat-server` discovery, Ed25519 HTTP request signing (`X-Federation-Domain`, `X-Federation-Timestamp`, `X-Federation-Nonce`, `X-Federation-Signature`), TOFU key pinning, replay cache, SSRF IP guard, durable exponential-backoff outbox worker, and admin allow/block policies. |
| **24h Encrypted Status / Stories** | Text stories (custom gradient + font) & encrypted photo/video stories encrypted once with an ephemeral 256-bit Status Key wrapped only for permitted contacts (`all contacts` / `except` / `only`), auto-expiring after 24 hours with viewer list, mute/unmute, and private E2EE status replies. |
| **Privacy-Preserving Web Push & PWA** | VAPID Web Push + installable PWA (`manifest.json` + `/sw.js`). Displays `"New message"` by default so push gateways see zero content, with an opt-in **Local Service Worker Decryption** mode using the browser's IndexedDB private key. |
| **Production Hardening & Ops** | Bucketed rate limits (`X-RateLimit-*` + `Retry-After`), strict CSP & security headers, control-char input sanitization, pluggable attachment scanner hook, `/metrics` Prometheus endpoint, and encrypted MySQL backup script (`scripts/backup_mysql.sh`). |

---

## Threat Model

### Assets Protected
1. **Message, Media, Voice, Location, & Status Plaintext**: Encrypted and authenticated on the sender's device using AES-256-GCM before network transmission. Neither `chatapp.in`, federated peer servers, S3/MinIO object storage, nor Web Push relays ever possess user private keys or plaintext.
2. **Group Forward/Post-Compromise Membership Boundaries**: When a member leaves or is removed from a group, `key_version` increments and fresh Sender Keys are distributed exclusively to remaining members.
3. **Cross-Node Authenticity**: Every S2S federation request is signed with the origin node's Ed25519 key over `METHOD | PATH | TIMESTAMP | NONCE | SHA256(BODY)` and checked against a replay cache and pinned TOFU public key.

### Trust Assumptions
- **Client Device & Browser Origin Integrity**: As with any web-based E2EE application (WhatsApp Web, Element Web, Proton Mail), the user trusts the origin serving the JavaScript bundle (`https://chatapp.in`) not to inject malicious key-exfiltrating code, and trusts their local OS/browser profile against local malware.
- **Public Key Discovery (TOFU)**: Initial public key retrieval from a user's home server relies on Trust-On-First-Use; high-assurance users verify peers out-of-band using the built-in **60-digit Safety Number / QR Code Scanner**.

---

## Known Limitations

1. **Metadata Visibility**:
   - While message bodies, filenames, captions, voice notes, coordinates, and status stories are end-to-end encrypted, home servers (and federated recipient servers) necessarily observe routing metadata: sender/recipient `global_id`, conversation membership, message timestamps, ciphertext byte lengths, and connection IP addresses.
2. **Web Push Limitations**:
   - Browser Web Push relies on vendor push relays (FCM / Mozilla Autopush / APNs). To prevent leaking plaintext to push relays or OS notification logs, RelayChat defaults to displaying `"New message"` only. When a user opts into **Local Service Worker Decryption**, the Service Worker must read the device's IndexedDB private key while the browser profile is unlocked; if a push payload exceeds the ~4 KB Web Push limit (e.g., long messages or group Sender Key messages), it gracefully falls back to `"New message"`.
3. **Key Backup Risk**:
   - Because private keys never touch the server unencrypted, clearing browser storage or losing a device without exporting an encrypted `.relaykey.json` backup permanently prevents decrypting historical messages. Conversely, choosing a weak passphrase when exporting `.relaykey.json` exposes the exported file to offline dictionary attacks despite 250,000-iteration PBKDF2-SHA256 stretching.
4. **Static ECDH Identity Key in 1:1 DMs**:
   - 1:1 chats derive keys from ECDH P-256 + HKDF-SHA256 with unique 96-bit per-message nonces rather than a full X3DH + Double Ratchet per-message DH ratchet; compromise of an unrotated long-term device private key allows decrypting past 1:1 ciphertexts stored for that device.

---

## Quick Start & Testing

### 1. Local Development (FastAPI + Next.js)
```bash
# Terminal 1 — Backend (:8000)
cd backend
./.venv/bin/alembic upgrade head
./.venv/bin/python scripts/seed.py
./.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000

# Terminal 2 — Frontend (:3000)
cd frontend
npm run dev
```
Demo accounts seeded by `scripts/seed.py`: `rahul` (node admin), `priya`, `aarav` (password: `RelayChat#2026`).

### 2. Automated Test Suites & Coverage
```bash
# Backend integration suite + coverage report (Phases 1–9: 26 integration tests)
cd backend && ./.venv/bin/pytest --cov=app --cov-report=term-missing

# Frontend Web Crypto unit tests (DM, QR, Chunked Media, Group Sender Keys, 24h Status)
cd frontend && npm run test:crypto

# Full-stack live E2E runner (Signup, E2EE Chat, Encrypted File, Call, Group, Status, Push)
cd frontend && npm run test:e2e:fullstack

# Playwright browser E2E suite (requires local Chromium binary installed)
cd frontend && npm run test:e2e

# Dependency security audit
./scripts/audit_dependencies.sh
```

### 3. Production HTTPS Deployment & Multi-Node Federation
See **[`deploy/DEPLOYMENT.md`](deploy/DEPLOYMENT.md)** for complete instructions on:
- Launching `docker-compose.prod.yml` with **Nginx TLS 1.3 + Let's Encrypt Certbot**, MySQL 8.4, Redis 7, MinIO, Coturn, and automated encrypted MySQL backups (`scripts/backup_mysql.sh`).
- Deploying a second independent node (`node2.org`) and federating live with `chatapp.in` (or testing locally via `docker-compose.federation.yml`).

---

## Roadmap

- **Native Mobile Apps (Flutter / React Native)**:
  - Dedicated iOS & Android clients backed by OS hardware-backed secure enclaves (iOS Keychain / Android Keystore) for P-256 & Ed25519 private keys, native CallKit / ConnectionService WebRTC integration, background push decryption via NSE (Notification Service Extension), and QR device linking.
- **X3DH + Double Ratchet Upgrade**:
  - Prekey bundles (`signedPreKey` + one-time prekeys) for per-message forward secrecy and post-compromise healing in 1:1 chats.
- **SFU Encrypted Group Calls**:
  - Multi-party voice/video rooms using WebRTC Insertable Streams (SFrame E2EE) over LiveKit/mediasoup.
