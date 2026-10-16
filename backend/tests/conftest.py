import os

# Must be set before the app is imported, so the app talks to the test database.
os.environ["DATABASE_URL"] = os.environ.get(
    "TEST_DATABASE_URL", "postgresql+psycopg://localhost:5432/mfg_test"
)
os.environ["ENVIRONMENT"] = "test"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from sqlalchemy import text  # noqa: E402

from app import db_triggers  # noqa: E402
from app.auth.passwords import hash_password  # noqa: E402
from app.auth.ratelimit import limiter  # noqa: E402
from app.database import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import User  # noqa: E402
from app.seed import seed_reference_data  # noqa: E402

ADMIN_USERNAME = "admin1"
ADMIN_PASSWORD = "correct-horse-battery-9"
ADMIN_HASH = hash_password(ADMIN_PASSWORD)  # hashed once: Argon2 is deliberately slow

assert engine.url.database.endswith("_test"), "Tests drop all tables: use a database ending in _test"


def reset_database():
    """A fresh database: tables, append-only triggers, 3 printers, 5 materials, one administrator, no orders."""
    with engine.begin() as connection:
        connection.execute(text("CREATE EXTENSION IF NOT EXISTS btree_gist"))
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with engine.begin() as connection:
        for statement in db_triggers.create_statements():
            connection.execute(text(statement))
    with SessionLocal() as db:
        seed_reference_data(db)
        db.add(User(username=ADMIN_USERNAME, full_name="Test Admin", password_hash=ADMIN_HASH, role="admin"))
        db.commit()
    limiter.reset()


def login(test_client: TestClient, username=ADMIN_USERNAME, password=ADMIN_PASSWORD):
    """Sign in. On success the cookie is kept by the client and the CSRF header is set for later requests."""
    response = test_client.post("/api/auth/login", json={"username": username, "password": password})
    if response.status_code == 200:
        test_client.headers["X-CSRF-Token"] = response.json()["csrf_token"]
    return response


@pytest.fixture()
def anonymous():
    """A client that is not signed in."""
    reset_database()
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture()
def client():
    """A client signed in as the administrator, on a fresh database."""
    reset_database()
    with TestClient(app) as test_client:
        assert login(test_client).status_code == 200
        yield test_client


def make_order(client, product="Titanium Spinal Cage", quantity=10, **extra):
    body = {"product": product, "quantity": quantity, "design_reference": "DR-TEST-001", **extra}
    response = client.post("/api/orders", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def run_step(client, order_id, step):
    """Start and complete one step, asserting that both calls work."""
    started = client.post(f"/api/orders/{order_id}/steps/{step}/start", json={})
    assert started.status_code == 200, started.text
    completed = client.post(f"/api/orders/{order_id}/steps/{step}/complete", json={})
    assert completed.status_code == 200, completed.text


def advance_to_qc(client, order_id):
    for step in ["design_review", "printing", "post_processing"]:
        run_step(client, order_id, step)


def get_resource(client, name):
    resources = client.get("/api/resources").json()
    return next(r for r in resources if r["name"] == name)


ALLOWED_ORIGIN = "http://localhost:3000"


def ws_ticket(test_client: TestClient) -> str:
    response = test_client.post("/api/auth/ws-ticket")
    assert response.status_code == 200, response.text
    return response.json()["ticket"]


def ws_connect(test_client: TestClient, ticket: str | None = None, origin: str | None = ALLOWED_ORIGIN):
    """Open the live-updates WebSocket the way the browser does: a ticket in the subprotocol, and an Origin."""
    ticket = ticket or ws_ticket(test_client)
    headers = {"origin": origin} if origin else {}
    return test_client.websocket_connect("/ws/production/", subprotocols=["mfg-v1", f"ticket.{ticket}"], headers=headers)


def add_user(username: str, password: str = "another-long-password-1", role: str = "admin", active: bool = True):
    with SessionLocal() as db:
        db.add(User(username=username, full_name=username.title(), password_hash=hash_password(password),
                    role=role, is_active=active))
        db.commit()
    return password
