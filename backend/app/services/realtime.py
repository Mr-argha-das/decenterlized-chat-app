import logging
from collections import defaultdict
from typing import Any

from fastapi import WebSocket

logger = logging.getLogger("relaychat.ws")


class RealtimeConnectionManager:
    """Tracks active authenticated WebSocket connections per user ID and linked device ID."""

    def __init__(self) -> None:
        self._connections: dict[str, set[WebSocket]] = defaultdict(set)
        self._socket_devices: dict[WebSocket, str] = {}

    async def connect(
        self, user_id: str, websocket: WebSocket, device_id: str | None = None
    ) -> bool:
        """Registers socket and returns True if the user transitioned from offline -> online."""
        was_offline = len(self._connections[user_id]) == 0
        self._connections[user_id].add(websocket)
        if device_id:
            self._socket_devices[websocket] = device_id
        return was_offline

    def disconnect(self, user_id: str, websocket: WebSocket) -> bool:
        """Removes socket and returns True if the user now has zero active sockets."""
        self._socket_devices.pop(websocket, None)
        conns = self._connections.get(user_id)
        if not conns:
            return False
        conns.discard(websocket)
        if not conns:
            self._connections.pop(user_id, None)
            return True
        return False

    def is_online(self, user_id: str) -> bool:
        return bool(self._connections.get(user_id))

    async def close_device_sockets(self, user_id: str, device_ids: set[str]) -> None:
        """Force-closes active WebSockets belonging to unlinked/logged-out devices."""
        conns = list(self._connections.get(user_id, ()))
        for ws in conns:
            did = self._socket_devices.get(ws)
            if did in device_ids:
                self.disconnect(user_id, ws)
                try:
                    await ws.close(code=4401, reason="Device logged out")
                except Exception:
                    pass

    async def close_all_user_sockets(self, user_id: str) -> None:
        """Force-closes all active WebSockets for a deleted account."""
        conns = list(self._connections.get(user_id, ()))
        self._connections.pop(user_id, None)
        for ws in conns:
            self._socket_devices.pop(ws, None)
            try:
                await ws.close(code=4401, reason="Account deleted")
            except Exception:
                pass

    async def send_to_user(
        self,
        user_id: str,
        payload: dict[str, Any],
        exclude_ws: WebSocket | None = None,
    ) -> int:
        conns = list(self._connections.get(user_id, ()))
        delivered = 0
        stale: list[WebSocket] = []
        for ws in conns:
            if exclude_ws is not None and ws is exclude_ws:
                continue
            try:
                await ws.send_json(payload)
                delivered += 1
            except Exception:
                stale.append(ws)
        for dead in stale:
            self.disconnect(user_id, dead)
        return delivered

    async def broadcast_to_users(
        self,
        user_ids: list[str] | set[str],
        payload: dict[str, Any],
        exclude_ws: WebSocket | None = None,
    ) -> None:
        for uid in set(user_ids):
            await self.send_to_user(uid, payload, exclude_ws=exclude_ws)


ws_manager = RealtimeConnectionManager()
