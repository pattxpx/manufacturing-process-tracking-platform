"""Login, logout, sessions, cookies, CSRF, rate limiting and the audit trail of all of that."""
from datetime import timedelta

from sqlalchemy import text

from app import config
from app.auth.dependencies import SESSION_COOKIE
from app.database import SessionLocal
from app.models import utcnow
from tests.conftest import ADMIN_PASSWORD, ADMIN_USERNAME, add_user, login, make_order


def audit_actions(client=None):
    with SessionLocal() as db:
        return [row[0] for row in db.execute(text("SELECT action FROM audit_events ORDER BY id"))]


# ---- Login and the session cookie ----

def test_login_succeeds_and_returns_user_permissions_and_csrf_token(anonymous):
    response = login(anonymous)
    assert response.status_code == 200
    body = response.json()
    assert body["user"]["username"] == ADMIN_USERNAME and body["user"]["role"] == "admin"
    assert "users:manage" in body["permissions"] and len(body["csrf_token"]) >= 32
    assert body["timezone"] == config.APP_TIMEZONE
    assert "password" not in response.text and "argon2" not in response.text  # no hash, no password


def test_session_cookie_is_httponly_samesite_and_scoped_to_the_whole_site(anonymous):
    cookie = login(anonymous).headers["set-cookie"].lower()
    assert f"{SESSION_COOKIE}=" in cookie
    assert "httponly" in cookie and "samesite=lax" in cookie and "path=/" in cookie
    assert "domain=" not in cookie  # host-only: not shared with sub-domains


def test_cookie_is_secure_in_production(anonymous, monkeypatch):
    monkeypatch.setattr(config, "COOKIE_SECURE", True)
    assert "secure" in login(anonymous).headers["set-cookie"].lower()


def test_session_token_is_stored_only_as_a_hash(anonymous):
    login(anonymous)
    token = anonymous.cookies[SESSION_COOKIE]
    with SessionLocal() as db:
        stored = db.execute(text("SELECT token_hash, csrf_token FROM user_sessions")).one()
    assert token not in stored and len(stored[0]) == 64


def test_wrong_password_and_unknown_user_get_the_same_answer(anonymous):
    wrong = anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "not-the-password-1"})
    unknown = anonymous.post("/api/auth/login", json={"username": "nobody", "password": "not-the-password-1"})
    add_user("sleeper", active=False)
    disabled = anonymous.post("/api/auth/login", json={"username": "sleeper", "password": "another-long-password-1"})
    assert wrong.status_code == unknown.status_code == disabled.status_code == 401
    assert wrong.json() == unknown.json() == disabled.json() == {"detail": "Invalid username or password."}
    assert SESSION_COOKIE not in anonymous.cookies


def test_user_name_is_not_case_sensitive(anonymous):
    assert login(anonymous, ADMIN_USERNAME.upper()).status_code == 200


def test_validation_errors_never_echo_a_submitted_password(anonymous):
    secret = "x" * 300  # too long: fails validation
    response = anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": secret})
    assert response.status_code == 422 and secret not in response.text


def test_me_requires_a_session(anonymous):
    assert anonymous.get("/api/auth/me").status_code == 401
    login(anonymous)
    assert anonymous.get("/api/auth/me").json()["user"]["username"] == ADMIN_USERNAME


# ---- Rotation, logout, expiry ----

def test_every_login_gets_a_new_session_and_the_old_one_is_retired(anonymous):
    login(anonymous)
    first = anonymous.cookies[SESSION_COOKIE]
    login(anonymous)  # signing in again while holding the old cookie
    second = anonymous.cookies[SESSION_COOKIE]
    assert first != second
    anonymous.cookies.set(SESSION_COOKIE, first)
    assert anonymous.get("/api/auth/me").status_code == 401  # the old token no longer works


def test_logout_ends_the_session_on_the_server(client):
    stolen = client.cookies[SESSION_COOKIE]
    assert client.post("/api/auth/logout").status_code == 204
    client.cookies.set(SESSION_COOKIE, stolen)  # an attacker replaying the old cookie
    assert client.get("/api/auth/me").status_code == 401
    assert "logout" in audit_actions()


def test_idle_sessions_expire(client, monkeypatch):
    with SessionLocal() as db:
        db.execute(text("UPDATE user_sessions SET last_seen_at = now() - interval '3 hours'"))
        db.commit()
    assert client.get("/api/auth/me").status_code == 401


def test_sessions_have_an_absolute_lifetime(client):
    with SessionLocal() as db:
        db.execute(text("UPDATE user_sessions SET expires_at = now() - interval '1 minute'"))
        db.commit()
    assert client.get("/api/orders").status_code == 401


def test_disabling_a_user_ends_their_session_immediately(client):
    add_user("worker")
    other = type(client)(client.app)
    assert login(other, "worker", "another-long-password-1").status_code == 200
    users = client.get("/api/users").json()
    worker = next(u for u in users if u["username"] == "worker")
    assert client.patch(f"/api/users/{worker['id']}", json={"is_active": False}).status_code == 200
    assert other.get("/api/orders").status_code == 401


# ---- CSRF and origin ----

def test_state_changing_requests_need_the_csrf_token(client):
    body = {"product": "Hearing Aid Shell", "quantity": 1, "design_reference": "CAD-1"}
    token = client.headers.pop("X-CSRF-Token")
    assert client.post("/api/orders", json=body).status_code == 403                                  # missing
    assert client.post("/api/orders", json=body, headers={"X-CSRF-Token": "wrong" * 10}).status_code == 403  # wrong
    assert client.post("/api/orders", json=body, headers={"X-CSRF-Token": token}).status_code == 201
    assert client.get("/api/orders").status_code == 200  # reading needs no token


def test_requests_from_another_website_are_refused_even_with_the_token(client):
    body = {"product": "Hearing Aid Shell", "quantity": 1, "design_reference": "CAD-1"}
    evil = client.post("/api/orders", json=body, headers={"Origin": "https://evil.example"})
    assert evil.status_code == 403
    cross_site = client.post("/api/orders", json=body, headers={"Sec-Fetch-Site": "cross-site"})
    assert cross_site.status_code == 403
    good = client.post("/api/orders", json=body, headers={"Origin": "http://localhost:3000"})
    assert good.status_code == 201


def test_login_checks_the_origin_too(anonymous):
    response = anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD},
                              headers={"Origin": "https://evil.example"})
    assert response.status_code == 403


# ---- Rate limiting ----

def test_repeated_failures_lock_the_account_from_that_address(anonymous):
    for _ in range(5):
        assert anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"}).status_code == 401
    blocked = anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
    assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) > 0
    assert "login_blocked" in audit_actions()


def test_unknown_users_are_throttled_exactly_like_real_ones(anonymous):
    results = [anonymous.post("/api/auth/login", json={"username": "ghost", "password": "wrong-password-1"}).status_code
               for _ in range(6)]
    assert results == [401] * 5 + [429]


def test_one_address_cannot_try_many_user_names(anonymous):
    statuses = [anonymous.post("/api/auth/login", json={"username": f"user{i}", "password": "wrong-password-1"}).status_code
                for i in range(22)]
    assert statuses[:20] == [401] * 20 and statuses[20:] == [429, 429]


def test_a_successful_login_clears_the_failure_count(anonymous):
    for _ in range(4):
        anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"})
    assert login(anonymous).status_code == 200
    for _ in range(4):  # a fresh allowance
        assert anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"}).status_code == 401


# ---- Password change ----

def test_changing_the_password_checks_the_old_one_and_ends_other_sessions(client):
    other = type(client)(client.app)
    login(other)
    assert client.post("/api/auth/change-password", json={"current_password": "wrong-password-1", "new_password": "a-brand-new-password-1"}).status_code == 400
    assert client.post("/api/auth/change-password", json={"current_password": ADMIN_PASSWORD, "new_password": "short"}).status_code == 422
    assert client.post("/api/auth/change-password", json={"current_password": ADMIN_PASSWORD, "new_password": "a-brand-new-password-1"}).status_code == 204

    assert other.get("/api/orders").status_code == 401   # the other device was signed out
    assert client.get("/api/orders").status_code == 200  # this one stays
    fresh = type(client)(client.app)
    assert login(fresh, password=ADMIN_PASSWORD).status_code == 401
    assert login(fresh, password="a-brand-new-password-1").status_code == 200


# ---- Audit trail ----

def test_logins_and_failures_are_audited_without_secrets(anonymous):
    anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"})
    login(anonymous)
    anonymous.post("/api/auth/logout")
    actions = audit_actions()
    assert actions[:3] == ["login_failed", "login_success", "logout"]
    with SessionLocal() as db:
        everything = " ".join(str(v) for row in db.execute(text("SELECT * FROM audit_events")) for v in row)
    assert "wrong-password-1" not in everything and ADMIN_PASSWORD not in everything


def test_business_actions_are_audited_with_the_real_actor(client):
    order = make_order(client)
    client.post(f"/api/orders/{order['id']}/steps/design_review/start", json={})
    with SessionLocal() as db:
        rows = db.execute(text("SELECT action, actor_username FROM audit_events WHERE target_type='order'")).all()
        history = db.execute(text("SELECT DISTINCT actor FROM order_status_history")).scalars().all()
    assert ("order_created", ADMIN_USERNAME) in rows and ("production_started", ADMIN_USERNAME) in rows
    assert history == [ADMIN_USERNAME]  # who did it is on the order's own history too
