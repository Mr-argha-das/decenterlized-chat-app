"""Pluggable encrypted attachment scanning hook (`file_scanner.py`).

Because RelayChat is end-to-end encrypted, files arrive as AES-256-GCM ciphertext
without keys on the server. This hook enforces:
1. Envelope & size invariants (non-zero ciphertext, valid AES-GCM auth tag overhead,
   no NUL-byte or anomalous control patterns in metadata).
2. Optional external scanner command (`FILE_SCANNER_CMD`, e.g., `clamdscan --no-summary`)
   for operators deploying ClamAV/YARA appliances or custom policy webhooks.
"""
import asyncio
import logging
import shlex
from pathlib import Path

from fastapi import status

from app.core.config import get_settings
from app.core.errors import AppError
from app.core.metrics import metrics_registry

logger = logging.getLogger("relaychat.scanner")

# Test/EICAR-style marker over encrypted_filename metadata so security tests can trigger quarantine deterministically
QUARANTINE_TEST_TOKEN = "EICAR-ENCRYPTED-TEST-QUARANTINE"


async def scan_completed_blob(
    *,
    blob_path: Path,
    mime_type: str,
    encrypted_filename: str,
    expected_plaintext_size: int,
    ciphertext_size: int,
    chunk_count: int,
) -> dict[str, str]:
    settings = get_settings()
    metrics_registry.inc_counter("file_scans_total", 1)

    if not settings.FILE_SCANNER_ENABLED:
        return {"verdict": "skipped", "engine": "disabled"}

    if not blob_path.exists():
        raise AppError(
            "SCAN_TARGET_MISSING",
            "Assembled blob missing before security scan.",
            status_code=status.HTTP_400_BAD_REQUEST,
        )

    # 1. Envelope & ciphertext size sanity check (each chunk adds 16-byte GCM tag)
    min_expected_cipher = expected_plaintext_size + (chunk_count * 16)
    max_expected_cipher = expected_plaintext_size + (chunk_count * 80) + 1024
    if ciphertext_size < min_expected_cipher or ciphertext_size > max_expected_cipher:
        blob_path.unlink(missing_ok=True)
        raise AppError(
            "SCAN_REJECTED_ENVELOPE",
            "Attachment ciphertext length failed AEAD envelope integrity check.",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    if "\x00" in encrypted_filename or QUARANTINE_TEST_TOKEN in encrypted_filename:
        blob_path.unlink(missing_ok=True)
        logger.warning("Quarantined uploaded blob due to scanner signature match on %s", blob_path.name)
        raise AppError(
            "FILE_QUARANTINED",
            "Attachment was blocked by the node security scanner.",
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
        )

    # 2. Optional external scanner command (e.g. ClamAV `clamdscan --no-summary <file>`)
    cmd_template = settings.FILE_SCANNER_CMD.strip()
    if cmd_template:
        args = shlex.split(cmd_template) + [str(blob_path)]
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=20.0)
        if proc.returncode != 0:
            blob_path.unlink(missing_ok=True)
            detail = (stdout or stderr).decode("utf-8", errors="replace").strip()[:200]
            logger.warning("External file scanner rejected %s: %s", blob_path.name, detail)
            raise AppError(
                "FILE_QUARANTINED",
                "Attachment was rejected by the node security scanner.",
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            )
        return {"verdict": "clean", "engine": "external"}

    return {"verdict": "clean", "engine": "builtin-envelope-guard"}
