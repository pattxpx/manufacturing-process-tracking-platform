"""Server-side sessions. The browser gets a random 256-bit token; only its SHA-256 hash is stored."""
import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import delete, select, update
from sqlalchemy.orm import Session

from app import config
from app.models import User, UserSession, WebSocketTicket, utcnow

TOUCH_EVERY_SECONDS = 60  # last_seen is updated at most this often, to avoid a write on every request
WS_TICKET_SECONDS = 30


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return secrets.token_urlsafe(32)  # 256 bits from the operating system's secure random source


def create_session(db: Session, user: User, ip: str | None, user_agent: str | None) -> tuple[str, UserSession]:
    """A brand-new session with a brand-new token (called at every login, so the id always changes)."""
    token = new_token()
    now = utcnow()
    session = UserSession(
        token_hash=hash_token(token), user_id=user.id, csrf_token=new_token(),
        created_at=now, last_seen_at=now, expires_at=now + timedelta(hours=config.SESSION_MAX_HOURS),
        ip=ip, user_agent=(user_agent or "")[:200] or None,
    )
    db.add(session)
    db.flush()
    return token, session


def find_session(db: Session, token: str | None) -> tuple[UserSession, User] | None:
    """The live session and its user for this token, or None (unknown, revoked, expired, idle, or user disabled)."""
    if not token:
        return None
    row = db.execute(
        select(UserSession, User).join(User, User.id == UserSession.user_id)
        .where(UserSession.token_hash == hash_token(token))
    ).first()
    if row is None:
        return None
    session, user = row
    now = utcnow()
    if session.revoked_at is not None or not user.is_active:
        return None
    if now >= session.expires_at or now - session.last_seen_at > timedelta(minutes=config.SESSION_IDLE_MINUTES):
        return None
    if (now - session.last_seen_at).total_seconds() > TOUCH_EVERY_SECONDS:
        session.last_seen_at = now
        db.commit()
    return session, user


def revoke_session(db: Session, session_id: int) -> None:
    db.execute(update(UserSession).where(UserSession.id == session_id, UserSession.revoked_at.is_(None))
               .values(revoked_at=utcnow()))


def revoke_user_sessions(db: Session, user_id: int, except_session_id: int | None = None) -> None:
    query = update(UserSession).where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
    if except_session_id is not None:
        query = query.where(UserSession.id != except_session_id)
    db.execute(query.values(revoked_at=utcnow()))


def purge_expired(db: Session) -> None:
    """Remove sessions and tickets that ended long ago."""
    cutoff = utcnow() - timedelta(days=7)
    db.execute(delete(UserSession).where(UserSession.expires_at < cutoff))
    db.execute(delete(WebSocketTicket).where(WebSocketTicket.expires_at < cutoff))


def create_ws_ticket(db: Session, session: UserSession) -> str:
    token = new_token()
    db.add(WebSocketTicket(
        token_hash=hash_token(token), session_id=session.id,
        expires_at=utcnow() + timedelta(seconds=WS_TICKET_SECONDS),
    ))
    return token


def use_ws_ticket(db: Session, token: str) -> tuple[UserSession, User] | None:
    """Spend a ticket (once only) and return the session it belongs to, if that session is still valid."""
    result = db.execute(
        update(WebSocketTicket)
        .where(WebSocketTicket.token_hash == hash_token(token), WebSocketTicket.used_at.is_(None),
               WebSocketTicket.expires_at > utcnow())
        .values(used_at=utcnow()).returning(WebSocketTicket.session_id)
    ).first()
    db.commit()
    if result is None:
        return None
    row = db.execute(
        select(UserSession, User).join(User, User.id == UserSession.user_id).where(UserSession.id == result[0])
    ).first()
    return _check_live(row)


def _check_live(row) -> tuple[UserSession, User] | None:
    if row is None:
        return None
    session, user = row
    now = utcnow()
    if session.revoked_at is not None or not user.is_active or now >= session.expires_at:
        return None
    if now - session.last_seen_at > timedelta(minutes=config.SESSION_IDLE_MINUTES):
        return None
    return session, user


def session_is_live(db: Session, session_id: int) -> bool:
    """Used while a WebSocket is open: is the login behind it still valid?"""
    db.expire_all()
    row = db.execute(
        select(UserSession, User).join(User, User.id == UserSession.user_id).where(UserSession.id == session_id)
    ).first()
    return _check_live(row) is not None
