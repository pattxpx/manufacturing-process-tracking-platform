from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from app.catalog import STEP_LABELS
from app.errors import BusinessRuleError
from app.models import Order, ProductionRecord, QualityInspection, utcnow
from app.schemas import InspectionCreate
from app.services.orders import get_order, record_history
from app.services.pagination import paginate


def record_inspection(db: Session, order_id: int, data: InspectionCreate, actor: str = "system") -> QualityInspection:
    order = get_order(db, order_id, lock=True)
    if order.status == "released":
        raise BusinessRuleError("Order is released and read-only")
    if order.current_step != "quality_inspection":
        raise BusinessRuleError(
            f"Order is not ready for inspection: it is at {STEP_LABELS[order.current_step]}"
        )

    inspection = QualityInspection(order=order, result=data.result, notes=data.notes, inspected_by=actor)
    db.add(inspection)

    if data.result == "pass":
        now = utcnow()
        db.add(ProductionRecord(order=order, step="quality_inspection", status="completed", completed_at=now))
        order.current_step = "final_release"
        order.queued_at = now
        record_history(db, order, "Inspection passed", new_status="ready_for_release", actor=actor)
    else:
        record_history(db, order, f"Inspection failed: {data.notes}", new_status="qc_failed", actor=actor)
    db.commit()
    return inspection


def release_order(db: Session, order_id: int, actor: str = "system") -> Order:
    order = get_order(db, order_id, lock=True)
    reasons = order.release_blockers
    if reasons:
        raise BusinessRuleError("Release blocked: " + "; ".join(reasons))

    now = utcnow()
    db.add(ProductionRecord(order=order, step="final_release", status="completed", completed_at=now))
    record_history(db, order, "Order released", new_status="released", actor=actor)
    db.commit()
    return order


def pending_inspections(db: Session, page: int, page_size: int) -> dict:
    """Orders waiting for (re-)inspection, oldest first."""
    query = (
        select(Order)
        .where(Order.current_step == "quality_inspection", Order.status.in_(["awaiting_qc", "qc_failed"]))
        .options(selectinload(Order.production_records), selectinload(Order.inspections))
        .order_by(Order.queued_at, Order.id)
    )
    return paginate(db, query, page, page_size)


def list_inspections(db: Session, page: int, page_size: int) -> dict:
    """The inspection history, newest first. Every record is kept; this only picks the page."""
    query = (
        select(QualityInspection).options(selectinload(QualityInspection.order))
        .order_by(QualityInspection.id.desc())
    )
    return paginate(db, query, page, page_size)
