from sqlalchemy import func, select
from sqlalchemy.orm import Session, selectinload

from app.catalog import STEP_LABELS, STEPS
from app.models import Order, OrderStatusHistory, ProductionRecord, Resource
from app.services.production import get_machines


def build_summary(db: Session) -> dict:
    """Dashboard numbers. Everything is counted by the database, so it stays fast with many orders."""
    by_status = dict(db.execute(select(Order.status, func.count()).group_by(Order.status)).all())

    # Orders that are at each step (not yet released), and how many of those are running it
    at_step = dict(db.execute(
        select(Order.current_step, func.count()).where(Order.status != "released").group_by(Order.current_step)
    ).all())
    running = dict(db.execute(
        select(Order.current_step, func.count())
        .join(ProductionRecord, (ProductionRecord.order_id == Order.id) & (ProductionRecord.step == Order.current_step))
        .where(Order.status != "released", ProductionRecord.status == "in_progress")
        .group_by(Order.current_step)
    ).all())
    completed = dict(db.execute(
        select(ProductionRecord.step, func.count()).where(ProductionRecord.status == "completed")
        .group_by(ProductionRecord.step)
    ).all())

    steps = [
        {
            "step": step,
            "label": STEP_LABELS[step],
            "waiting": at_step.get(step, 0) - running.get(step, 0),
            "running": running.get(step, 0),
            "completed": completed.get(step, 0),
        }
        for step in STEPS
    ]

    activity = db.execute(
        select(OrderStatusHistory).options(selectinload(OrderStatusHistory.order))
        .order_by(OrderStatusHistory.id.desc()).limit(10)
    ).scalars()

    return {
        "total_orders": sum(by_status.values()),
        "in_production": by_status.get("in_production", 0),
        "awaiting_qc": by_status.get("awaiting_qc", 0),
        "qc_failed": by_status.get("qc_failed", 0),
        "released": by_status.get("released", 0),
        "steps": steps,
        "machines": get_machines(db),
        "resources": list(db.execute(select(Resource).order_by(Resource.id)).scalars()),
        "recent_activity": list(activity),
    }
