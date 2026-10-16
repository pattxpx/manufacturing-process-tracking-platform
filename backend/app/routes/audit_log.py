from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.auth import permissions
from app.auth.dependencies import Actor, require
from app.database import get_db
from app.models import AuditEvent
from app.schemas import AuditEventOut, Page
from app.services.pagination import MAX_PAGE_SIZE, paginate

router = APIRouter(prefix="/api", tags=["audit"])


@router.get("/audit-events", response_model=Page[AuditEventOut])
def audit_events(
    action: str | None = Query(None, max_length=60, pattern=r"^[a-z_]*$"),
    page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=MAX_PAGE_SIZE),
    actor: Actor = Depends(require(permissions.AUDIT_READ)), db: Session = Depends(get_db),
):
    """The audit trail, newest first. Read-only: there is no endpoint that changes or deletes events."""
    query = select(AuditEvent).order_by(AuditEvent.id.desc())
    if action:
        query = query.where(AuditEvent.action == action)
    return paginate(db, query, page, page_size)
