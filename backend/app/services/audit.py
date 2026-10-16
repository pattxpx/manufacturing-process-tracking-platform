"""The audit trail. Rows can only be added (the database refuses changes), and are written by the server from
the verified session, never from anything the client sends."""
import json

from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import AuditEvent


def _row(action, actor_user_id, actor_username, target_type, target_id, success, ip, details) -> AuditEvent:
    text = json.dumps(details, default=str, separators=(",", ":")) if details else None
    return AuditEvent(
        action=action, actor_user_id=actor_user_id, actor_username=actor_username,
        target_type=target_type, target_id=str(target_id) if target_id is not None else None,
        success=success, ip=ip, details=text[:500] if text else None,
    )


def record(db: Session, action: str, actor=None, *, target_type=None, target_id=None, success=True, ip=None, details=None):
    """Add an event to the CURRENT transaction (the caller commits). Use for things that happen together
    with a database change, so the audit row and the change are saved or lost together."""
    db.add(_row(
        action, getattr(actor, "user_id", None), getattr(actor, "username", None),
        target_type, target_id, success, ip, details,
    ))


def record_now(action: str, actor=None, *, actor_username=None, actor_user_id=None, target_type=None, target_id=None,
               success=True, ip=None, details=None):
    """Write an event in its own transaction, so it is kept even when the request itself fails or is refused
    (failed logins, permission denials)."""
    with SessionLocal() as db:
        db.add(_row(
            action, actor_user_id or getattr(actor, "user_id", None), actor_username or getattr(actor, "username", None),
            target_type, target_id, success, ip, details,
        ))
        db.commit()
