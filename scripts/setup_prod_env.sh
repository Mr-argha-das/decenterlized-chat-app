#!/usr/bin/env bash
# ==============================================================================
# RelayChat — 1-Command Production .env Generator (for Caddy / Docker VPS)
# ==============================================================================
# Usage:
#   ./scripts/setup_prod_env.sh [domain]
#   Default domain: chatone.duckdns.org
# ==============================================================================

set -euo pipefail

DOMAIN="${1:-chatone.duckdns.org}"
ENV_FILE=".env"

if [[ -f "${ENV_FILE}" ]]; then
  echo "[!] ${ENV_FILE} already exists. Backing up to ${ENV_FILE}.bak.$(date +%s)"
  cp "${ENV_FILE}" "${ENV_FILE}.bak.$(date +%s)"
fi

JWT_SEC="$(openssl rand -hex 32)"
UPLOAD_SEC="$(openssl rand -hex 32)"
MYSQL_ROOT_PASS="$(openssl rand -hex 20)"
MYSQL_APP_PASS="$(openssl rand -hex 20)"
BACKUP_PASS="$(openssl rand -hex 24)"
TURN_SEC="$(openssl rand -hex 20)"

cat > "${ENV_FILE}" <<EOF
# Auto-generated RelayChat Production Configuration for ${DOMAIN}
ENVIRONMENT=production
APP_NAME=RelayChat
APP_DOMAIN=${DOMAIN}
NODE_PUBLIC_URL=https://${DOMAIN}
FRONTEND_URL=https://${DOMAIN}
CORS_ORIGINS=https://${DOMAIN}

# Isolated loopback ports for Caddy reverse_proxy (won't touch :3000, :3002, :3030, :8000, :8033, etc.)
RELAYCHAT_WEB_PORT=3045
RELAYCHAT_API_PORT=8045

# MySQL 8 (internal to Docker network only)
MYSQL_ROOT_PASSWORD=${MYSQL_ROOT_PASS}
MYSQL_DATABASE=relaychat
MYSQL_USER=relaychat
MYSQL_PASSWORD=${MYSQL_APP_PASS}

# Auth & Upload Signing Secrets
JWT_SECRET_KEY=${JWT_SEC}
UPLOAD_SIGNING_SECRET=${UPLOAD_SEC}
COOKIE_SECURE=true
COOKIE_SAMESITE=lax

# Federation & Web Push (auto-persisted in relaychat_node_keys Docker volume if left empty)
FEDERATION_ENABLED=true
FEDERATION_REQUIRE_HTTPS=true
NODE_PRIVATE_KEY_B64=
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:admin@${DOMAIN}

# Encrypted Nightly MySQL Backups
BACKUP_RETENTION_DAYS=14
BACKUP_PASSPHRASE=${BACKUP_PASS}

# WebRTC STUN
TURN_REALM=${DOMAIN}
TURN_SHARED_SECRET=${TURN_SEC}
NEXT_PUBLIC_STUN_URL=stun:stun.cloudflare.com:3478
NEXT_PUBLIC_TURN_URL=
EOF

chmod 600 "${ENV_FILE}"
echo "[✓] Generated hardened ${ENV_FILE} for https://${DOMAIN} (ports 127.0.0.1:3045 & 127.0.0.1:8045)"
