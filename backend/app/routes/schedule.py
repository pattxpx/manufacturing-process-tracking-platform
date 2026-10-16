from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from app.auth import permissions as perm
from app.auth.dependencies import Actor, require
from app.auth.ratelimit import SENSITIVE_PER_USER, limiter
from app.database import get_db
from app.events import notify
from app.routes.orders import to_detail
from app.schemas import OrderDetail, ScheduleOut, ScheduleRequest
from app.services import scheduling

router = APIRouter(prefix="/api", tags=["schedule"])


@router.get("/schedule", response_model=ScheduleOut)
def get_schedule(
    start: datetime | None = Query(None, description="Start of the window (with a time zone). Default: a few hours ago"),
    days: int = Query(3, ge=1, le=scheduling.MAX_WINDOW_DAYS),
    actor: Actor = Depends(require(perm.SCHEDULE_READ)), db: Session = Depends(get_db),
):
    if start is not None and start.tzinfo is None:
        raise HTTPException(422, "start must include a time zone")
    return scheduling.get_schedule(db, start, days)


@router.put("/orders/{order_id}/schedule", response_model=OrderDetail)
def set_schedule(order_id: int, body: ScheduleRequest, actor: Actor = Depends(require(perm.SCHEDULE_MANAGE)),
                 db: Session = Depends(get_db)):
    wait = limiter.hit(f"sensitive:{actor.user_id}", *SENSITIVE_PER_USER)
    if wait:
        raise HTTPException(429, "Too many requests. Slow down.", headers={"Retry-After": str(wait)})
    order = scheduling.set_schedule(db, order_id, body, actor)
    notify("schedule.updated", order_id=order.id)
    return to_detail(db, order)


@router.delete("/orders/{order_id}/schedule", response_model=OrderDetail)
def clear_schedule(order_id: int, actor: Actor = Depends(require(perm.SCHEDULE_MANAGE)), db: Session = Depends(get_db)):
    order = scheduling.clear_schedule(db, order_id, actor)
    notify("schedule.updated", order_id=order.id)
    return to_detail(db, order)
