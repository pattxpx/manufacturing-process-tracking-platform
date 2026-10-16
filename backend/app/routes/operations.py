"""Read-only views (dashboard, queue, machines, history) and resource management."""
from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.auth import permissions as perm
from app.auth.dependencies import Actor, require
from app.auth.ratelimit import SENSITIVE_PER_USER, limiter
from app.database import get_db
from app.events import notify
from app.schemas import (
    BoardOut, DashboardSummary, InspectionOut, MachineOut, OrderOut, Page, QueueItem, ResourceCreate, ResourceOut,
    ResourceUpdate, ResourceUsageOut, StockAdjustmentCreate, StockAdjustmentOut,
)
from app.services import production, quality, resources as resource_service
from app.services.dashboard import build_summary
from app.services.pagination import MAX_PAGE_SIZE
from fastapi import HTTPException

router = APIRouter(prefix="/api")


def throttle(actor: Actor) -> None:
    wait = limiter.hit(f"sensitive:{actor.user_id}", *SENSITIVE_PER_USER)
    if wait:
        raise HTTPException(429, "Too many requests. Slow down.", headers={"Retry-After": str(wait)})


@router.get("/dashboard", response_model=DashboardSummary)
def dashboard(actor: Actor = Depends(require(perm.ORDERS_READ)), db: Session = Depends(get_db)):
    return build_summary(db)


@router.get("/production/queue", response_model=list[QueueItem])
def production_queue(limit_per_step: int | None = Query(None, ge=1, le=500),
                     actor: Actor = Depends(require(perm.PRODUCTION_READ)), db: Session = Depends(get_db)):
    """The FIFO queue. Without limit_per_step it lists every waiting order."""
    return production.get_queue(db, limit_per_step)


@router.get("/production/board", response_model=BoardOut)
def production_board(limit: int = Query(25, ge=1, le=200), actor: Actor = Depends(require(perm.PRODUCTION_READ)),
                     db: Session = Depends(get_db)):
    """The board: per step the total and the first `limit` orders. Scheduling is decided on the full queue."""
    return production.get_board(db, limit)


@router.get("/machines", response_model=list[MachineOut])
def machines(actor: Actor = Depends(require(perm.PRODUCTION_READ)), db: Session = Depends(get_db)):
    return production.get_machines(db)


@router.get("/resources", response_model=list[ResourceOut])
def resources(actor: Actor = Depends(require(perm.RESOURCES_READ)), db: Session = Depends(get_db)):
    return resource_service.list_resources(db)


@router.post("/resources", response_model=ResourceOut, status_code=201)
def create_resource(body: ResourceCreate, request: Request, actor: Actor = Depends(require(perm.RESOURCES_MANAGE)),
                    db: Session = Depends(get_db)):
    throttle(actor)
    resource = resource_service.create_resource(db, body, actor)
    notify("resource.updated")
    return resource_service.resource_out(resource)


@router.patch("/resources/{resource_id}", response_model=ResourceOut)
def update_resource(resource_id: int, body: ResourceUpdate, request: Request,
                    actor: Actor = Depends(require(perm.RESOURCES_MANAGE)), db: Session = Depends(get_db)):
    throttle(actor)
    resource = resource_service.update_resource(db, resource_id, body, actor)
    notify("resource.updated")
    return resource_service.resource_out(resource)


@router.post("/resources/{resource_id}/adjustments", response_model=StockAdjustmentOut, status_code=201)
def adjust_stock(resource_id: int, body: StockAdjustmentCreate, request: Request,
                 actor: Actor = Depends(require(perm.STOCK_ADJUST)), db: Session = Depends(get_db)):
    throttle(actor)
    adjustment = resource_service.adjust_stock(db, resource_id, body, actor)
    notify("resource.updated")
    return adjustment


@router.get("/resources/{resource_id}/adjustments", response_model=Page[StockAdjustmentOut])
def stock_adjustments(resource_id: int, page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=MAX_PAGE_SIZE),
                      actor: Actor = Depends(require(perm.RESOURCES_READ)), db: Session = Depends(get_db)):
    return resource_service.list_adjustments(db, resource_id, page, page_size)


@router.get("/resources/usage", response_model=Page[ResourceUsageOut])
def resource_usage(
    order_id: int | None = None, resource_id: int | None = None,
    page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=MAX_PAGE_SIZE),
    actor: Actor = Depends(require(perm.RESOURCES_READ)), db: Session = Depends(get_db),
):
    return resource_service.list_usage(db, order_id, resource_id, page, page_size)


@router.get("/inspections", response_model=Page[InspectionOut])
def inspections(page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=MAX_PAGE_SIZE),
                actor: Actor = Depends(require(perm.QUALITY_READ)), db: Session = Depends(get_db)):
    return quality.list_inspections(db, page, page_size)


@router.get("/inspections/pending", response_model=Page[OrderOut])
def pending_inspections(page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=MAX_PAGE_SIZE),
                        actor: Actor = Depends(require(perm.QUALITY_READ)), db: Session = Depends(get_db)):
    return quality.pending_inspections(db, page, page_size)
