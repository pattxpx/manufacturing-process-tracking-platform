"""WebSocket notifications. The database is the source of truth; these only say "something changed".
Events carry ids and types only, never business data. Only signed-in users with the right permission are connected."""
import logging

import anyio.from_thread
from fastapi import WebSocket

logger = logging.getLogger("events")

MAX_CONNECTIONS_PER_USER = 10


class ConnectionManager:
    def __init__(self):
        self.connections: list[tuple[WebSocket, int, int]] = []  # (socket, user id, session id)

    def count_for_user(self, user_id: int) -> int:
        return sum(1 for _, uid, _ in self.connections if uid == user_id)

    def add(self, websocket: WebSocket, user_id: int, session_id: int):
        self.connections.append((websocket, user_id, session_id))

    def disconnect(self, websocket: WebSocket):
        self.connections = [c for c in self.connections if c[0] is not websocket]

    async def broadcast(self, message: dict):
        for websocket, _, _ in list(self.connections):
            try:
                await websocket.send_json(message)
            except Exception:
                self.disconnect(websocket)

    async def close_session(self, session_id: int):
        """Drop every socket that belongs to this login (called on logout)."""
        for websocket, _, sid in list(self.connections):
            if sid == session_id:
                self.disconnect(websocket)
                try:
                    await websocket.close(code=4401)
                except Exception:
                    pass


manager = ConnectionManager()


def notify(event_type: str, **data):
    """Call from a normal (sync) route AFTER the database commit."""
    try:
        anyio.from_thread.run(manager.broadcast, {"type": event_type, **data})
    except Exception:
        # A failed notification must never fail the request that already succeeded.
        logger.exception("Could not broadcast %s", event_type)


def disconnect_session(session_id: int):
    try:
        anyio.from_thread.run(manager.close_session, session_id)
    except Exception:
        logger.exception("Could not close sockets of session %s", session_id)
