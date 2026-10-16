import asyncio
import logging
import time

import anyio
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app import config
from app.auth import permissions
from app.auth.sessions import session_is_live, use_ws_ticket
from app.database import SessionLocal
from app.events import MAX_CONNECTIONS_PER_USER, manager

router = APIRouter()
logger = logging.getLogger("ws")

SUBPROTOCOL = "mfg-v1"
RECHECK_SECONDS = 30       # how often the login behind an open socket is checked again
MAX_MESSAGE_BYTES = 1024   # this socket only sends; clients have nothing to say
MAX_MESSAGES_PER_MINUTE = 30


def authenticate(ticket: str):
    """Spend the ticket and return (user id, session id), or None. Runs in a worker thread (blocking database access)."""
    with SessionLocal() as db:
        found = use_ws_ticket(db, ticket)
        if found is None:
            return None
        session, user = found
        if not permissions.has_permission(user.role, permissions.PRODUCTION_READ):
            return None
        return user.id, session.id


def still_logged_in(session_id: int) -> bool:
    with SessionLocal() as db:
        return session_is_live(db, session_id)


@router.websocket("/ws/production/")
async def production_events(websocket: WebSocket):
    # 1. Only our own website may open this socket (browsers do not apply CORS to WebSockets)
    if websocket.headers.get("origin") not in config.ALLOWED_ORIGINS:
        await websocket.close(code=1008)  # refused before the handshake completes
        return

    # 2. A single-use ticket, sent as a subprotocol so that it never appears in URLs or access logs
    ticket = next((p[len("ticket."):] for p in websocket.scope.get("subprotocols", []) if p.startswith("ticket.")), None)
    identity = await anyio.to_thread.run_sync(authenticate, ticket) if ticket else None
    if identity is None:
        await websocket.close(code=1008)
        return
    user_id, session_id = identity
    if manager.count_for_user(user_id) >= MAX_CONNECTIONS_PER_USER:
        await websocket.close(code=1008)
        return

    await websocket.accept(subprotocol=SUBPROTOCOL)
    manager.add(websocket, user_id, session_id)
    messages: list[float] = []
    last_check = time.monotonic()
    try:
        while True:
            try:
                text = await asyncio.wait_for(websocket.receive_text(), timeout=RECHECK_SECONDS)
                now = time.monotonic()
                messages = [t for t in messages if now - t < 60] + [now]
                if len(text.encode()) > MAX_MESSAGE_BYTES or len(messages) > MAX_MESSAGES_PER_MINUTE:
                    await websocket.close(code=1009)
                    return
            except asyncio.TimeoutError:
                pass
            # 3. Keep checking that the login behind this socket is still valid (logout, expiry, disabled user)
            if time.monotonic() - last_check >= RECHECK_SECONDS:
                last_check = time.monotonic()
                if not await anyio.to_thread.run_sync(still_logged_in, session_id):
                    await websocket.close(code=4401)
                    return
    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(websocket)
