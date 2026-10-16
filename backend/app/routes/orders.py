from typing import Literal

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.auth import permissions as perm
from app.auth.dependencies import Actor, client_ip, require
from app.catalog import MATERIALS, PRODUCTS
from app.database import get_db
from app.events import notify
from app.schemas import (
    CompleteStepRequest, InspectionCreate, InspectionOut, OrderCreate, OrderDetail, OrderOut,
    OrderUpdate, Page, ProductOut, StartStepRequest,
)
from app.services import orders as order_service
from app.services import audit, production, quality
from app.services.pagination import MAX_PAGE_SIZE
from app.services.orders import material_requirements

router = APIRouter(prefix="/api")


def to_detail(db: Session, order) -> dict:
    """OrderDetail = the order plus its records and the rule-based extras."""
    data = OrderOut.model_validate(order).model_dump()
    data.update(
        production_records=order.production_records,
        inspections=order.inspections,
        history=order.history,
        material_requirements=material_requirements(db, order),
    )
    return data


@router.get("/products", response_model=list[ProductOut])
def list_products(actor: Actor = Depends(require(perm.ORDERS_READ))):
    return [
        {
            "name": name,
            "materials": [
                {"name": material, "unit": MATERIALS[material]["unit"], "per_unit": per_unit}
                for material, per_unit in info["materials"].items()
            ],
        }
        for name, info in PRODUCTS.items()
    ]


@router.get("/orders", response_model=Page[OrderOut])
def list_orders(
    search: str | None = Query(None, max_length=100, pattern=r"^[^\x00]*$"),
    status: Literal["new", "in_production", "awaiting_qc", "qc_failed", "ready_for_release", "released"] | None = None,
    step: Literal["design_review", "printing", "post_processing", "quality_inspection", "final_release"] | None = None,
    page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=MAX_PAGE_SIZE),
    actor: Actor = Depends(require(perm.ORDERS_READ)), db: Session = Depends(get_db),
):
    return order_service.list_orders(db, search, status, step, page, page_size)


@router.post("/orders", response_model=OrderDetail, status_code=201)
def create_order(body: OrderCreate, request: Request, actor: Actor = Depends(require(perm.ORDERS_WRITE)),
                 db: Session = Depends(get_db)):
    order = order_service.create_order(db, body, actor.username)
    audit.record(db, "order_created", actor, target_type="order", target_id=order.id, ip=client_ip(request))
    db.commit()
    notify("order.created", order_id=order.id)
    return to_detail(db, order)


@router.get("/orders/{order_id}", response_model=OrderDetail)
def get_order(order_id: int, actor: Actor = Depends(require(perm.ORDERS_READ)), db: Session = Depends(get_db)):
    return to_detail(db, order_service.get_order(db, order_id))


@router.patch("/orders/{order_id}", response_model=OrderDetail)
def update_order(order_id: int, body: OrderUpdate, request: Request, actor: Actor = Depends(require(perm.ORDERS_WRITE)),
                 db: Session = Depends(get_db)):
    order = order_service.update_order(db, order_id, body, actor.username)
    audit.record(db, "order_updated", actor, target_type="order", target_id=order.id, ip=client_ip(request),
                 details={"fields": sorted(body.model_dump(exclude_unset=True))})
    db.commit()
    notify("order.updated", order_id=order.id)
    return to_detail(db, order)


@router.post("/orders/{order_id}/steps/{step}/start", response_model=OrderDetail)
def start_step(order_id: int, step: str, body: StartStepRequest, request: Request,
               actor: Actor = Depends(require(perm.PRODUCTION_OPERATE)), db: Session = Depends(get_db)):
    order = production.start_step(db, order_id, step, body.machine_id, actor.username)
    audit.record(db, "production_started", actor, target_type="order", target_id=order.id, ip=client_ip(request),
                 details={"step": step})
    db.commit()
    notify("production.started", order_id=order.id, step=step)
    if step == "printing":
        notify("machine.updated", order_id=order.id)
        notify("resource.updated")
    return to_detail(db, order)


@router.post("/orders/{order_id}/steps/{step}/complete", response_model=OrderDetail)
def complete_step(order_id: int, step: str, body: CompleteStepRequest, request: Request,
                  actor: Actor = Depends(require(perm.PRODUCTION_OPERATE)), db: Session = Depends(get_db)):
    actual_usage = {entry.resource_id: entry.actual_quantity for entry in body.actual_usage or []}
    order = production.complete_step(db, order_id, step, actual_usage, actor.username)
    audit.record(db, "production_completed", actor, target_type="order", target_id=order.id, ip=client_ip(request),
                 details={"step": step})
    db.commit()
    notify("production.completed", order_id=order.id, step=step)
    if step == "printing":
        notify("machine.updated", order_id=order.id)
        notify("resource.updated")
    return to_detail(db, order)


@router.post("/orders/{order_id}/inspections", response_model=InspectionOut, status_code=201)
def record_inspection(order_id: int, body: InspectionCreate, request: Request,
                      actor: Actor = Depends(require(perm.QUALITY_INSPECT)), db: Session = Depends(get_db)):
    inspection = quality.record_inspection(db, order_id, body, actor.username)
    audit.record(db, "inspection_recorded", actor, target_type="order", target_id=order_id, ip=client_ip(request),
                 details={"result": body.result})
    db.commit()
    notify("inspection.recorded", order_id=order_id, result=body.result)
    return inspection


@router.post("/orders/{order_id}/release", response_model=OrderDetail)
def release_order(order_id: int, request: Request, actor: Actor = Depends(require(perm.QUALITY_RELEASE)),
                  db: Session = Depends(get_db)):
    order = quality.release_order(db, order_id, actor.username)
    audit.record(db, "order_released", actor, target_type="order", target_id=order.id, ip=client_ip(request))
    db.commit()
    notify("order.released", order_id=order.id)
    return to_detail(db, order)
