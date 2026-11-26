#!/usr/bin/env bash
# ==============================================================================
# RelayChat (chatapp.in) — Production MySQL 8 Online Backup & Retention Script
# ==============================================================================
# Performs a consistent online InnoDB snapshot using --single-transaction,
# compresses with gzip, optionally encrypts with AES-256-CBC (PBKDF2), writes a
# SHA-256 integrity digest, and prunes backups older than BACKUP_RETENTION_DAYS.
#
# Usage:
#   ./scripts/backup_mysql.sh
#   BACKUP_PASSPHRASE="strong-secret" BACKUP_DIR=/var/backups/relaychat ./scripts/backup_mysql.sh
# ==============================================================================

set -euo pipefail

MYSQL_HOST="${MYSQL_HOST:-mysql}"
MYSQL_PORT="${MYSQL_PORT:-3306}"
MYSQL_DATABASE="${MYSQL_DATABASE:-relaychat}"
MYSQL_USER="${MYSQL_USER:-relaychat}"
MYSQL_PASSWORD="${MYSQL_PASSWORD:-relaychat_secret}"

BACKUP_DIR="${BACKUP_DIR:-./backups/mysql}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-}"

TIMESTAMP="$(date -u +"%Y%m%dT%H%M%SZ")"
mkdir -p "${BACKUP_DIR}"

RAW_GZ="${BACKUP_DIR}/relaychat_${MYSQL_DATABASE}_${TIMESTAMP}.sql.gz"

echo "[backup] Starting consistent MySQL 8 dump of ${MYSQL_DATABASE}@${MYSQL_HOST}:${MYSQL_PORT}..."

MYSQL_PWD="${MYSQL_PASSWORD}" mysqldump \
  --host="${MYSQL_HOST}" \
  --port="${MYSQL_PORT}" \
  --user="${MYSQL_USER}" \
  --single-transaction \
  --quick \
  --routines \
  --triggers \
  --events \
  --default-character-set=utf8mb4 \
  --set-gtid-purged=OFF \
  "${MYSQL_DATABASE}" | gzip -9 > "${RAW_GZ}"

FINAL_ARTIFACT="${RAW_GZ}"

if [[ -n "${BACKUP_PASSPHRASE}" ]]; then
  ENC_ARTIFACT="${RAW_GZ}.enc"
  echo "[backup] Encrypting backup archive with OpenSSL AES-256-CBC (PBKDF2)..."
  PASS_ENV="${BACKUP_PASSPHRASE}" openssl enc -aes-256-cbc -salt -pbkdf2 -iter 250000 \
    -pass env:PASS_ENV \
    -in "${RAW_GZ}" \
    -out "${ENC_ARTIFACT}"
  rm -f "${RAW_GZ}"
  FINAL_ARTIFACT="${ENC_ARTIFACT}"
fi

sha256sum "${FINAL_ARTIFACT}" > "${FINAL_ARTIFACT}.sha256"
SIZE_BYTES="$(wc -c < "${FINAL_ARTIFACT}" | tr -d ' ')"
echo "[backup] Backup complete: ${FINAL_ARTIFACT} (${SIZE_BYTES} bytes)"

echo "[backup] Pruning backups older than ${BACKUP_RETENTION_DAYS} days in ${BACKUP_DIR}..."
find "${BACKUP_DIR}" -maxdepth 1 -type f \( -name "relaychat_*.sql.gz*" \) -mtime "+${BACKUP_RETENTION_DAYS}" -delete

echo "[backup] Done."
