"""Failed-attempt throttling that is shared by every server instance.

Every failed sign-in and failed password change is already written to the audit trail (in PostgreSQL), so the limits
are simply "how many such events happened recently". No memory is kept in the server process, nothing is lost on a
restart, and several instances (replicas) all see the same counts. Attempts for the same user (or the same password
change) are serialised with a PostgreSQL advisory lock held until the request ends, so a burst cannot all pass the check
before the first failure is recorded. The per-address limit has no lock of its own: a burst across many different
usernames from one address can overshoot it by at most the number of requests in flight. If the database is unavailable
the request fails with HTTP 500 (it never lets anyone in), and the counts are intact when the database returns."""
from datetime import timedelta

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.models import AuditEvent, utcnow

WINDOW = timedelta(minutes=15)

# Maximum failures within WINDOW
LOGIN_FAILS_PER_USER_AND_IP = 5
LOGIN_FAILS_PER_IP = 20
LOGIN_FAILS_PER_USER = 30
PASSWORD_CHANGE_FAILS_PER_USER = 5


def serialise(db: Session, kind: str, key: str) -> None:
    """Wait for any other request holding the same lock. It is released when this request's transaction ends (commit,
    rollback or the session being closed), which is after the failure has been recorded."""
    db.execute(text("SELECT pg_advisory_xact_lock(hashtextextended(:name, 0))"), {"name": f"{kind}:{key}"})


def seconds_until_allowed(db: Session, action: str, limit: int, since, **filters) -> int:
    """0 if fewer than `limit` events of this kind happened since `since`; otherwise the time until the oldest of them leaves the window."""
    query = select(AuditEvent.created_at).where(AuditEvent.action == action, AuditEvent.created_at > since)
    for column, value in filters.items():
        query = query.where(getattr(AuditEvent, column) == value)
    times = list(db.execute(query.order_by(AuditEvent.created_at.desc()).limit(limit)).scalars())
    if len(times) < limit:
        return 0
    return max(1, int((times[-1] + WINDOW - utcnow()).total_seconds()) + 1)


def login_blocked_for(db: Session, username: str, ip: str) -> int:
    """Seconds this sign-in attempt must wait (0 = go ahead). A successful sign-in clears the counts for that user
    (as it always did); the count for an address is not cleared."""
    now = utcnow()
    window_start = now - WINDOW
    last_success = db.execute(
        select(func.max(AuditEvent.created_at)).where(AuditEvent.action == "login_success", AuditEvent.actor_username == username)
    ).scalar_one()
    since_user = max(window_start, last_success) if last_success else window_start
    waits = [
        seconds_until_allowed(db, "login_failed", LOGIN_FAILS_PER_USER_AND_IP, since_user, actor_username=username, ip=ip),
        seconds_until_allowed(db, "login_failed", LOGIN_FAILS_PER_IP, window_start, ip=ip),
        seconds_until_allowed(db, "login_failed", LOGIN_FAILS_PER_USER, since_user, actor_username=username),
    ]
    return max(waits)


def password_change_blocked_for(db: Session, user_id: int) -> int:
    return seconds_until_allowed(
        db, "password_change_failed", PASSWORD_CHANGE_FAILS_PER_USER, utcnow() - WINDOW, actor_user_id=user_id
    )
