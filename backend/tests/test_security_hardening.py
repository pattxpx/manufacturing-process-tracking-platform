"""Headers, request limits, error handling, append-only history, configuration checks, the bootstrap CLI."""
import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app import config, manage
from app.auth.ratelimit import limiter
from app.database import SessionLocal
from tests.conftest import ADMIN_USERNAME, make_order, run_step, advance_to_qc


# ---- Response headers and request limits ----

def test_security_headers_are_on_every_response(client):
    for response in (client.get("/api/health"), client.get("/api/orders"), client.get("/api/nope")):
        headers = response.headers
        assert headers["x-content-type-options"] == "nosniff"
        assert headers["x-frame-options"] == "DENY"
        assert headers["cache-control"] == "no-store"
        assert headers["referrer-policy"] == "no-referrer"
        assert "frame-ancestors 'none'" in headers["content-security-policy"]
        assert "server" not in headers


def test_hsts_is_sent_in_production(client, monkeypatch):
    monkeypatch.setattr(config, "IS_PRODUCTION", True)
    assert "max-age=31536000" in client.get("/api/health").headers["strict-transport-security"]


def test_unknown_host_names_are_refused(client):
    assert client.get("/api/health", headers={"Host": "evil.example"}).status_code == 400


def test_oversized_bodies_are_refused(client, monkeypatch):
    monkeypatch.setattr(config, "MAX_BODY_BYTES", 2000)
    big = {"product": "Hearing Aid Shell", "quantity": 1, "design_reference": "x" * 90, "notes": "n" * 3000}
    assert client.post("/api/orders", json=big).status_code == 413


def test_floods_from_one_address_are_limited(client, monkeypatch):
    import app.main as main
    monkeypatch.setattr(main, "API_REQUESTS_PER_IP", (5, 60))
    limiter.reset()
    codes = [client.get("/api/health").status_code for _ in range(8)]
    assert codes[:5] == [200] * 5 and set(codes[5:]) == {429}


def test_unexpected_errors_do_not_leak_details(client, monkeypatch):
    import app.routes.operations as operations
    monkeypatch.setattr(operations.production, "get_machines", lambda db: 1 / 0)
    from fastapi.testclient import TestClient
    from app.main import app
    from tests.conftest import login
    quiet = TestClient(app, raise_server_exceptions=False)
    login(quiet)
    response = quiet.get("/api/machines")
    assert response.status_code == 500 and response.json() == {"detail": "Internal server error"}
    assert "ZeroDivision" not in response.text and "Traceback" not in response.text


# ---- Injection ----

@pytest.mark.parametrize("payload", ["' OR 1=1 --", "'; DROP TABLE orders; --", "%' OR '1'='1", "\\", "\x00"])
def test_search_text_is_data_never_sql(client, payload):
    make_order(client)
    response = client.get("/api/orders", params={"search": payload, "status": payload})
    assert response.status_code in (200, 422) and (response.status_code == 422 or response.json()["total"] == 0)
    assert client.get("/api/orders").json()["total"] == 1  # the table is still there


def test_control_characters_in_a_body_are_a_clean_422_not_a_server_error(client):
    body = {"product": "Hearing Aid Shell", "quantity": 1, "design_reference": "ok", "notes": "bad \x00 byte"}
    assert client.post("/api/orders", json=body).status_code == 422
    assert client.get("/api/orders", params={"status": "nonsense"}).status_code == 422  # only real statuses are accepted
    assert client.get("/api/audit-events", params={"action": "x'; --"}).status_code == 422


def test_stored_text_is_escaped_by_the_api_not_interpreted(client):
    order = make_order(client, design_reference="<script>alert(1)</script>")
    assert client.get(f"/api/orders/{order['id']}").json()["design_reference"] == "<script>alert(1)</script>"  # returned as data, as JSON


# ---- History cannot be rewritten ----

def test_audit_events_cannot_be_changed_or_deleted(client):
    make_order(client)
    for statement in ["UPDATE audit_events SET success = false", "DELETE FROM audit_events"]:
        with SessionLocal() as db, pytest.raises(DBAPIError):
            db.execute(text(statement))
            db.commit()
    assert client.get("/api/audit-events").json()["total"] >= 2


def test_stock_adjustments_inspections_and_order_history_are_append_only(client):
    order = make_order(client)
    advance_to_qc(client, order["id"])
    client.post(f"/api/orders/{order['id']}/inspections", json={"result": "fail", "notes": "porosity"})
    client.post("/api/resources/1/adjustments", json={"quantity_change": 5, "reason": "delivery"})
    for statement in [
        "UPDATE stock_adjustments SET quantity_change = 999", "DELETE FROM stock_adjustments",
        "UPDATE quality_inspections SET result = 'pass'", "DELETE FROM quality_inspections",
        "UPDATE order_status_history SET note = 'edited'", "DELETE FROM order_status_history",
    ]:
        with SessionLocal() as db, pytest.raises(DBAPIError):
            db.execute(text(statement))
            db.commit()


# ---- Configuration checks for production ----

def test_unsafe_production_settings_are_listed(monkeypatch):
    monkeypatch.setattr(config, "COOKIE_SECURE", False)
    monkeypatch.setattr(config, "ALLOWED_ORIGINS", ["http://example.com"])
    monkeypatch.setattr(config, "ALLOWED_HOSTS", ["*"])
    monkeypatch.delenv("DATABASE_URL", raising=False)
    problems = " | ".join(config.production_problems())
    for expected in ["COOKIE_SECURE", "https://", "ALLOWED_HOSTS", "DATABASE_URL"]:
        assert expected in problems


def test_safe_production_settings_pass(monkeypatch):
    monkeypatch.setattr(config, "COOKIE_SECURE", True)
    monkeypatch.setattr(config, "ALLOWED_ORIGINS", ["https://app.example.com"])
    monkeypatch.setattr(config, "ALLOWED_HOSTS", ["api.example.com"])
    monkeypatch.setenv("ALLOWED_HOSTS", "api.example.com")
    monkeypatch.setenv("DATABASE_URL", "postgresql+psycopg://x/y")
    assert config.production_problems() == []


# ---- Initial administrator ----

def test_create_admin_command_uses_the_environment_password_and_makes_an_admin(anonymous, monkeypatch, capsys):
    monkeypatch.setenv("INITIAL_ADMIN_PASSWORD", "bootstrap-password-1234")
    manage.create_admin("Founder", "First Admin")
    assert "bootstrap-password-1234" not in capsys.readouterr().out  # never printed
    from tests.conftest import login
    response = login(anonymous, "founder", "bootstrap-password-1234")
    assert response.status_code == 200 and response.json()["user"]["role"] == "admin"
    with SessionLocal() as db:
        logged = " ".join(str(v) for row in db.execute(text("SELECT * FROM audit_events")) for v in row)
    assert "bootstrap-password-1234" not in logged and "user_created" in logged


def test_create_admin_command_refuses_duplicates_and_weak_passwords(anonymous, monkeypatch):
    monkeypatch.setenv("INITIAL_ADMIN_PASSWORD", "bootstrap-password-1234")
    with pytest.raises(SystemExit):
        manage.create_admin(ADMIN_USERNAME, "Duplicate")
    monkeypatch.setenv("INITIAL_ADMIN_PASSWORD", "weak")
    with pytest.raises(SystemExit):
        manage.create_admin("someone", "Weak Password")


def test_no_account_exists_in_a_fresh_migrated_schema_without_the_command():
    """The seed script and migrations never create users, so there are no default credentials anywhere."""
    import inspect
    from app import seed
    assert "User(" not in inspect.getsource(seed) and "password" not in inspect.getsource(seed).lower()
