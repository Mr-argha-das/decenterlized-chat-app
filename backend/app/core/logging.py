import json
import logging
import sys
from datetime import datetime, timezone
from typing import Any


class StructuredJsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
        }
        for extra_key in ("request_id", "method", "path", "status_code", "duration_ms", "user_id"):
            val = getattr(record, extra_key, None)
            if val is not None:
                payload[extra_key] = val
        if record.exc_info:
            payload["exception"] = self.formatException(record.exc_info)
        return json.dumps(payload, default=str)


def configure_logging() -> None:
    root = logging.getLogger()
    if getattr(root, "_relaychat_configured", False):
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(StructuredJsonFormatter())
    root.handlers = [handler]
    root.setLevel(logging.INFO)
    logging.getLogger("sqlalchemy.engine").setLevel(logging.WARNING)
    setattr(root, "_relaychat_configured", True)
