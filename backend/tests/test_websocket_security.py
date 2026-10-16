"""The live-updates WebSocket: only signed-in users from our own website, with a single-use ticket."""
import pytest
from sqlalchemy import text
from starlette.websockets import WebSocketDisconnect

from app.auth import permissions
from app.database import SessionLocal
from tests.conftest import add_user, login, make_order, ws_connect, ws_ticket


def rejected(test_client, **kwargs):
    with pytest.raises(WebSocketDisconnect):
        with ws_connect(test_client, **kwargs) as websocket:
            websocket.receive_json()


def test_a_valid_ticket_from_our_website_connects(client):
    with ws_connect(client) as websocket:
        order = make_order(client)
        assert websocket.receive_json()["order_id"] == order["id"]


def test_no_ticket_means_no_connection(client):
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/ws/production/", subprotocols=["mfg-v1"], headers={"origin": "http://localhost:3000"}) as ws:
            ws.receive_json()


def test_an_invalid_ticket_is_refused(client):
    rejected(client, ticket="not-a-real-ticket")


def test_tickets_work_once_only(client):
    ticket = ws_ticket(client)
    with ws_connect(client, ticket=ticket):
        pass
    rejected(client, ticket=ticket)


def test_expired_tickets_are_refused(client):
    ticket = ws_ticket(client)
    with SessionLocal() as db:
        db.execute(text("UPDATE websocket_tickets SET expires_at = now() - interval '1 second'"))
        db.commit()
    rejected(client, ticket=ticket)


def test_another_website_cannot_open_the_socket(client):
    """Browsers do not apply CORS to WebSockets, so the server must check the Origin itself."""
    rejected(client, origin="https://evil.example")
    rejected(client, origin=None)


def test_a_ticket_needs_a_login(anonymous):
    assert anonymous.post("/api/auth/ws-ticket").status_code == 401


def test_a_ticket_of_an_ended_session_is_refused(client):
    ticket = ws_ticket(client)
    client.post("/api/auth/logout")
    rejected(client, ticket=ticket)


def test_logout_closes_open_sockets(client):
    with ws_connect(client) as websocket:
        client.post("/api/auth/logout")
        with pytest.raises(WebSocketDisconnect):
            websocket.receive_json()


def test_a_role_without_read_access_gets_no_ticket(client, monkeypatch):
    monkeypatch.setitem(permissions.ROLE_PERMISSIONS, "nothing", frozenset({permissions.ORDERS_WRITE}))
    add_user("nora", role="nothing")
    other = type(client)(client.app)
    login(other, "nora", "another-long-password-1")
    assert other.post("/api/auth/ws-ticket").status_code == 403


def test_oversized_messages_close_the_connection(client):
    with ws_connect(client) as websocket:
        websocket.send_text("x" * 5000)
        with pytest.raises(WebSocketDisconnect):
            websocket.receive_json()


def test_events_carry_ids_not_business_data(client):
    with ws_connect(client) as websocket:
        make_order(client, design_reference="SECRET-DESIGN-REF")
        message = websocket.receive_json()
    assert set(message) <= {"type", "order_id", "step", "result"}
    assert "SECRET" not in str(message)
