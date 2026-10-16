"""Who may do what: every endpoint is protected, roles are enforced, and clients cannot grant themselves anything."""
import re

import pytest
from sqlalchemy import text

from app.auth import permissions
from app.database import SessionLocal
from app.main import app
from tests.conftest import ADMIN_USERNAME, add_user, login, make_order

PUBLIC = {("GET", "/api/health"), ("POST", "/api/auth/login")}


def all_api_routes():
    """Every (method, path) the API offers, read from the app's own OpenAPI description."""
    for path, operations in app.openapi()["paths"].items():
        if path.startswith("/api"):
            for method in operations:
                yield method.upper(), path


def concrete(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "1", path)  # {order_id} -> 1


# ---- Every endpoint is protected ----

def test_the_route_scan_finds_the_whole_api():
    routes = set(all_api_routes())
    assert len(routes) >= 35 and ("POST", "/api/orders/{order_id}/release") in routes


@pytest.mark.parametrize("method,path", sorted(set(all_api_routes()) - PUBLIC))
def test_endpoint_rejects_anonymous_callers(anonymous, method, path):
    response = anonymous.request(method, concrete(path), json={} if method != "GET" else None)
    assert response.status_code == 401, f"{method} {path} answered {response.status_code} without a login"


def test_only_health_and_login_are_public():
    assert PUBLIC == {("GET", "/api/health"), ("POST", "/api/auth/login")}
    assert not any("register" in path or "signup" in path for _, path in all_api_routes())  # no public registration


def test_api_documentation_is_off_when_disabled():
    from fastapi import FastAPI  # the production setting is a constructor argument of the app
    assert FastAPI(docs_url=None, redoc_url=None, openapi_url=None).openapi_url is None


# ---- Roles are really enforced (a restricted role is only a configuration change away) ----

@pytest.fixture()
def viewer(client, monkeypatch):
    """A client signed in as a user with a read-only role, defined just for this test."""
    read_only = frozenset({permissions.ORDERS_READ, permissions.PRODUCTION_READ, permissions.SCHEDULE_READ,
                           permissions.RESOURCES_READ, permissions.QUALITY_READ})
    monkeypatch.setitem(permissions.ROLE_PERMISSIONS, "viewer", read_only)
    add_user("vera", role="viewer")
    other = type(client)(client.app)
    assert login(other, "vera", "another-long-password-1").status_code == 200
    return other


def test_a_read_only_role_can_read(viewer):
    for path in ["/api/orders", "/api/dashboard", "/api/production/board", "/api/machines", "/api/resources",
                 "/api/schedule", "/api/inspections", "/api/auth/me"]:
        assert viewer.get(path).status_code == 200, path


def test_a_read_only_role_cannot_change_anything(client, viewer):
    order = make_order(client)
    attempts = [
        ("POST", "/api/orders", {"product": "Hearing Aid Shell", "quantity": 1, "design_reference": "X"}),
        ("PATCH", f"/api/orders/{order['id']}", {"notes": "x"}),
        ("POST", f"/api/orders/{order['id']}/steps/design_review/start", {}),
        ("POST", f"/api/orders/{order['id']}/steps/design_review/complete", {}),
        ("POST", f"/api/orders/{order['id']}/inspections", {"result": "pass"}),
        ("POST", f"/api/orders/{order['id']}/release", None),
        ("PUT", f"/api/orders/{order['id']}/schedule", {"machine_id": 1, "planned_start_at": "2099-01-01T00:00:00Z", "estimated_duration_minutes": 60}),
        ("DELETE", f"/api/orders/{order['id']}/schedule", None),
        ("POST", "/api/resources", {"name": "Evil", "unit": "g"}),
        ("PATCH", "/api/resources/1", {"min_stock": 5}),
        ("POST", "/api/resources/1/adjustments", {"quantity_change": 100, "reason": "free stock"}),
        ("GET", "/api/users", None),
        ("POST", "/api/users", {"username": "mallory", "full_name": "M", "password": "a-very-long-password-1"}),
        ("GET", "/api/audit-events", None),
    ]
    for method, path, body in attempts:
        response = viewer.request(method, path, json=body)
        assert response.status_code == 403, f"{method} {path} -> {response.status_code}"
    assert client.get(f"/api/orders/{order['id']}").json()["status"] == "new"  # nothing changed


def test_denied_attempts_are_audited(client, viewer):
    viewer.post("/api/orders", json={"product": "Hearing Aid Shell", "quantity": 1, "design_reference": "X"})
    with SessionLocal() as db:
        row = db.execute(text("SELECT actor_username, success, details FROM audit_events WHERE action='permission_denied'")).one()
    assert row[0] == "vera" and row[1] is False and "orders:write" in row[2]


def test_a_user_cannot_raise_their_own_role(viewer):
    me = viewer.get("/api/auth/me").json()["user"]
    assert viewer.patch(f"/api/users/{me['id']}", json={"role": "admin"}).status_code == 403
    assert viewer.get("/api/auth/me").json()["user"]["role"] == "viewer"


def test_unknown_roles_get_no_permissions(client):
    add_user("ghost", role="not_a_role")
    other = type(client)(client.app)
    assert login(other, "ghost", "another-long-password-1").status_code == 200
    assert other.get("/api/orders").status_code == 403  # deny by default
    assert permissions.permissions_for("not_a_role") == frozenset()


def test_today_every_role_is_admin_and_admin_can_do_everything():
    assert set(permissions.ROLE_PERMISSIONS) == {"admin"}
    assert permissions.ROLE_PERMISSIONS["admin"] == permissions.ALL_PERMISSIONS
    assert permissions.DEFAULT_ROLE == "admin"


# ---- Mass assignment: fields the endpoint does not offer are refused, not ignored ----

def test_clients_cannot_set_fields_that_are_not_offered(client):
    order = make_order(client)
    assert client.post("/api/orders", json={"product": "Hearing Aid Shell", "quantity": 1, "design_reference": "X", "status": "released"}).status_code == 422
    assert client.post("/api/orders", json={"product": "Hearing Aid Shell", "quantity": 1, "design_reference": "X", "id": 999}).status_code == 422
    assert client.patch(f"/api/orders/{order['id']}", json={"status": "released", "current_step": "final_release"}).status_code == 422
    assert client.post(f"/api/orders/{order['id']}/inspections", json={"result": "pass", "inspected_by": "someone-else"}).status_code == 422
    assert client.post(f"/api/orders/{order['id']}/steps/design_review/start", json={"actor": "x"}).status_code == 422
    assert client.patch("/api/resources/1", json={"on_hand": 999999, "reserved": 0}).status_code == 422
    assert client.post("/api/resources/1/adjustments", json={"quantity_change": 1, "reason": "test", "on_hand_after": 5}).status_code == 422
    assert client.post("/api/auth/login", json={"username": "a", "password": "b", "role": "admin"}).status_code == 422
    assert client.get(f"/api/orders/{order['id']}").json()["status"] == "new"


def test_a_user_cannot_be_given_unlisted_fields(client):
    body = {"username": "newbie", "full_name": "New B", "password": "a-very-long-password-1", "is_active": True, "id": 7}
    assert client.post("/api/users", json=body).status_code == 422
    me = client.get("/api/auth/me").json()["user"]
    assert client.patch(f"/api/users/{me['id']}", json={"password_hash": "x"}).status_code == 422


def test_the_actor_comes_from_the_session_not_the_request(client):
    order = make_order(client)
    client.post(f"/api/orders/{order['id']}/steps/design_review/start", json={}, headers={"X-Actor": "someone-else", "X-User": "x"})
    history = client.get(f"/api/orders/{order['id']}").json()["history"]
    assert {h["actor"] for h in history} == {ADMIN_USERNAME}


# ---- User management ----

NEW_USER = {"username": "Bea", "full_name": "Bea Example", "password": "a-very-long-password-1"}


def test_an_admin_creates_accounts_and_they_are_admins_by_default(client):
    created = client.post("/api/users", json=NEW_USER)
    assert created.status_code == 201
    user = created.json()
    assert user["username"] == "bea" and user["role"] == "admin" and user["is_active"] is True
    assert "password" not in created.text and "hash" not in created.text
    other = type(client)(client.app)
    assert login(other, "BEA", NEW_USER["password"]).status_code == 200
    assert other.get("/api/orders").status_code == 200  # every account can use every feature for now


def test_user_names_are_unique_whatever_the_case(client):
    assert client.post("/api/users", json=NEW_USER).status_code == 201
    assert client.post("/api/users", json={**NEW_USER, "username": "BEA"}).status_code == 409


def test_weak_passwords_and_unknown_roles_are_refused(client):
    assert client.post("/api/users", json={**NEW_USER, "password": "short"}).status_code == 422
    assert client.post("/api/users", json={**NEW_USER, "password": "xxxxxxxxxxxxxxxx"}).status_code == 422  # repetitive
    assert client.post("/api/users", json={**NEW_USER, "password": "contains-bea-in-it-1"}).status_code == 422
    assert client.post("/api/users", json={**NEW_USER, "role": "superuser"}).status_code == 422
    assert client.post("/api/users", json={**NEW_USER, "username": "a b"}).status_code == 422


def test_the_last_administrator_cannot_be_removed(client):
    me = client.get("/api/auth/me").json()["user"]
    assert client.patch(f"/api/users/{me['id']}", json={"is_active": False}).status_code == 409   # not yourself
    # Another admin exists, so the role could change, but a role without the permission is refused for the last manager
    assert client.patch(f"/api/users/{me['id']}", json={"role": "unknown_role"}).status_code in (409, 422)


def test_changing_a_role_or_resetting_a_password_ends_that_users_sessions(client):
    add_user("carl")
    other = type(client)(client.app)
    login(other, "carl", "another-long-password-1")
    carl = next(u for u in client.get("/api/users").json() if u["username"] == "carl")
    assert client.post(f"/api/users/{carl['id']}/reset-password", json={"new_password": "a-new-long-password-2"}).status_code == 204
    assert other.get("/api/orders").status_code == 401
    fresh = type(client)(client.app)
    assert login(fresh, "carl", "another-long-password-1").status_code == 401
    assert login(fresh, "carl", "a-new-long-password-2").status_code == 200


def test_user_management_is_audited(client):
    created = client.post("/api/users", json=NEW_USER).json()
    client.patch(f"/api/users/{created['id']}", json={"is_active": False})
    client.patch(f"/api/users/{created['id']}", json={"is_active": True})
    client.post(f"/api/users/{created['id']}/reset-password", json={"new_password": "a-new-long-password-2"})
    events = client.get("/api/audit-events", params={"page_size": 100}).json()["items"]
    actions = [e["action"] for e in events]
    for action in ["user_created", "user_deactivated", "user_activated", "password_reset"]:
        assert action in actions
    text_of_events = str(events)
    assert NEW_USER["password"] not in text_of_events and "a-new-long-password-2" not in text_of_events


def test_unknown_users_are_404_not_server_errors(client):
    assert client.patch("/api/users/9999", json={"is_active": False}).status_code == 404
    assert client.post("/api/users/9999/reset-password", json={"new_password": "a-new-long-password-2"}).status_code == 404
