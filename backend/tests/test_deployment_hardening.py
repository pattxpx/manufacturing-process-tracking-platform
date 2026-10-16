"""Settings and behaviour that matter when the app runs behind a hosting platform: the database URL scheme, which client
address is believed, throttling that is shared between instances, and the health check."""
from datetime import timedelta

import pytest

from fastapi.testclient import TestClient

from app import config
from app.auth.clientip import resolve_client_ip
from app.auth.ratelimit import limiter
from app.database import get_db
from app.main import app
from app.models import utcnow
from tests.conftest import ADMIN_PASSWORD, ADMIN_USERNAME, login


# ---- Database URL from the platform ----

@pytest.mark.parametrize("given,expected", [
    ("postgresql://u:p@host:5432/db", "postgresql+psycopg://u:p@host:5432/db"),
    ("postgres://u:p@host/db", "postgresql+psycopg://u:p@host/db"),
    ("postgresql+psycopg://u:p@host/db", "postgresql+psycopg://u:p@host/db"),
])
def test_database_urls_from_a_hosting_platform_use_the_psycopg_driver(given, expected):
    assert config.normalize_database_url(given) == expected


# ---- Which client address is believed ----

@pytest.mark.parametrize("peer,header,hops,expected", [
    ("10.0.0.5", "1.2.3.4", 0, "10.0.0.5"),                         # default: the header is ignored
    ("10.0.0.5", "1.2.3.4", 1, "1.2.3.4"),                          # one proxy of ours: the last entry
    ("10.0.0.5", "6.6.6.6, 1.2.3.4", 1, "1.2.3.4"),                 # a client-made leading entry is ignored
    ("10.0.0.5", "1.2.3.4, 172.16.0.9", 2, "1.2.3.4"),              # two proxies of ours
    ("10.0.0.5", "6.6.6.6, 1.2.3.4, 172.16.0.9", 2, "1.2.3.4"),
    ("10.0.0.5", "1.2.3.4", 2, "10.0.0.5"),                         # header shorter than expected: do not guess
    ("10.0.0.5", None, 1, "10.0.0.5"),
    ("10.0.0.5", "not-an-address", 1, "10.0.0.5"),
    ("10.0.0.5", "1.2.3.4:5555", 1, "10.0.0.5"),                    # anything that is not a plain address is not trusted
    ("10.0.0.5", "2001:db8::1", 1, "2001:db8::1"),
    (None, None, 0, "unknown"),
])
def test_the_client_address_only_trusts_entries_added_by_our_own_proxies(peer, header, hops, expected):
    assert resolve_client_ip(peer, header, hops) == expected


def fail_logins(client, how_many, username="intruder", forwarded=lambda i: None):
    codes = []
    for i in range(how_many):
        headers = {"X-Forwarded-For": forwarded(i)} if forwarded(i) else {}
        codes.append(client.post("/api/auth/login", json={"username": f"{username}{i}", "password": "wrong-password-1"}, headers=headers).status_code)
    return codes


def test_spoofed_forwarded_for_entries_cannot_evade_the_address_limit(anonymous, monkeypatch):
    monkeypatch.setattr(config, "TRUSTED_PROXY_HOPS", 1)
    # 20 failures from one real address (the last entry), each claiming a different made-up address in front of it
    codes = fail_logins(anonymous, 22, forwarded=lambda i: f"10.9.{i}.1, 203.0.113.7")
    assert codes[:20] == [401] * 20 and codes[20:] == [429, 429]


def test_without_trusted_proxies_the_header_is_ignored_completely(anonymous):
    codes = fail_logins(anonymous, 22, forwarded=lambda i: f"203.0.113.{i}")  # a different address in every request
    assert codes[:20] == [401] * 20 and codes[20:] == [429, 429]


def test_different_real_addresses_are_counted_separately(anonymous, monkeypatch):
    monkeypatch.setattr(config, "TRUSTED_PROXY_HOPS", 1)
    assert set(fail_logins(anonymous, 20, forwarded=lambda i: "203.0.113.7")) == {401}
    other = anonymous.post("/api/auth/login", json={"username": "someone", "password": "wrong-password-1"},
                           headers={"X-Forwarded-For": "198.51.100.9"})
    assert other.status_code == 401  # a different address is not blocked by the first one's failures
    assert fail_logins(anonymous, 1, username="again", forwarded=lambda i: "203.0.113.7") == [429]


def test_the_audit_trail_records_the_resolved_address(anonymous, monkeypatch):
    monkeypatch.setattr(config, "TRUSTED_PROXY_HOPS", 1)
    anonymous.post("/api/auth/login", json={"username": "x", "password": "wrong-password-1"}, headers={"X-Forwarded-For": "6.6.6.6, 203.0.113.7"})
    assert login(anonymous).status_code == 200
    events = anonymous.get("/api/audit-events", params={"action": "login_failed"}).json()["items"]
    assert events[0]["ip"] == "203.0.113.7"


# ---- Throttling is shared between server instances ----

def test_the_login_lockout_survives_a_restart_or_another_instance(anonymous):
    for _ in range(5):
        anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"})
    limiter.reset()  # a different process (or a restart) has none of the first one's memory
    blocked = anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
    assert blocked.status_code == 429 and int(blocked.headers["retry-after"]) > 0


def test_the_lockout_ends_when_the_failures_leave_the_15_minute_window(anonymous, monkeypatch):
    for _ in range(5):
        anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"})
    assert anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}).status_code == 429
    later = utcnow() + timedelta(minutes=16)
    monkeypatch.setattr("app.auth.throttle.utcnow", lambda: later)
    assert anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}).status_code == 200


def test_the_retry_after_time_counts_down_to_the_oldest_failure_leaving(anonymous):
    for _ in range(5):
        anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"})
    wait = int(anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}).headers["retry-after"])
    assert 14 * 60 < wait <= 15 * 60 + 2


def test_a_user_is_not_locked_out_by_failures_from_before_their_last_successful_sign_in(anonymous):
    for _ in range(4):
        anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"})
    assert login(anonymous).status_code == 200
    for _ in range(4):
        assert anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"}).status_code == 401


def test_password_change_guessing_is_limited_across_instances(client):
    wrong = {"current_password": "wrong-password-1", "new_password": "a-brand-new-password-1"}
    assert [client.post("/api/auth/change-password", json=wrong).status_code for _ in range(5)] == [400] * 5
    limiter.reset()
    blocked = client.post("/api/auth/change-password", json={**wrong, "current_password": ADMIN_PASSWORD})
    assert blocked.status_code == 429


# ---- Health check ----

def test_the_health_check_is_public_and_reveals_nothing_else(anonymous):
    response = anonymous.get("/api/health")
    assert response.status_code == 200 and response.json() == {"status": "ok"}


def test_the_health_check_reports_an_unreachable_database_as_503(anonymous):
    class BrokenSession:
        def execute(self, *args, **kwargs):
            raise RuntimeError("password=hunter2 host=secret-db")  # must never reach the response

    app.dependency_overrides[get_db] = lambda: iter([BrokenSession()])
    try:
        response = anonymous.get("/api/health")
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert response.status_code == 503 and response.json() == {"status": "unavailable"}
    assert "hunter2" not in response.text and "secret-db" not in response.text


def test_proxy_hops_outside_the_allowed_range_are_a_production_problem(monkeypatch):
    monkeypatch.setattr(config, "TRUSTED_PROXY_HOPS", 9)
    assert any("TRUSTED_PROXY_HOPS" in problem for problem in config.production_problems())


# ---- Throttling under concurrency and when the database fails ----

def test_a_burst_of_simultaneous_wrong_passwords_for_one_user_cannot_pass_the_limit(anonymous):
    from concurrent.futures import ThreadPoolExecutor

    def attempt(_):
        return anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"}).status_code

    with ThreadPoolExecutor(max_workers=12) as pool:
        codes = list(pool.map(attempt, range(12)))
    assert codes.count(401) == 5 and codes.count(429) == 7  # exactly the limit, not "a few more"


def test_when_the_database_fails_sign_in_is_refused_and_not_let_through():
    class BrokenSession:
        def execute(self, *args, **kwargs):
            raise RuntimeError("connection lost")

        def close(self):
            pass

    app.dependency_overrides[get_db] = lambda: iter([BrokenSession()])
    try:
        with TestClient(app, raise_server_exceptions=False) as broken:
            response = broken.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD})
    finally:
        app.dependency_overrides.pop(get_db, None)
    assert response.status_code == 500 and "session" not in response.headers.get("set-cookie", "").lower()


def test_the_limit_recovers_by_itself_after_the_window(anonymous, monkeypatch):
    for _ in range(5):
        anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": "wrong-password-1"})
    assert anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}).status_code == 429
    later = utcnow() + timedelta(minutes=16)
    monkeypatch.setattr("app.auth.throttle.utcnow", lambda: later)
    assert anonymous.post("/api/auth/login", json={"username": ADMIN_USERNAME, "password": ADMIN_PASSWORD}).status_code == 200
