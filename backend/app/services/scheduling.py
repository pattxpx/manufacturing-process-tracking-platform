"""Manual planning of print jobs on the three printers.

A plan is only a PLAN: a printer, a start time and an estimated duration. It is kept apart from what really
happens (production_records). How it works with the existing rules:
  * Planning never starts anything and never reserves material. Starting still follows FIFO, material and
    printer rules exactly as before.
  * Two plans can never overlap on one printer (checked under a row lock, and guaranteed by a database
    exclusion constraint if two requests race).
  * When a job starts without an explicit printer, its planned printer is preferred if it is free.
  * A job whose planned start (or planned end, while running) has passed is shown as "delayed".
Times are stored in UTC (timezone-aware) and shown in the configured time zone.
"""
from datetime import datetime, timedelta, timezone

from sqlalchemy import exists, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app import config
from app.errors import BusinessRuleError, not_found
from app.models import Machine, Order, ProductionRecord, Resource, utcnow
from app.schemas import ScheduleRequest
from app.services import audit
from app.services.orders import get_order, record_history, required_materials
from app.services.production import find_shortages, get_machines, material_state

PLANNING_STEPS = ("design_review", "printing")  # a job can be planned from the start until printing begins
UNSCHEDULED_SHOWN = 50
MAX_WINDOW_DAYS = 14


def local(moment: datetime) -> str:
    """For messages: '20 Oct 09:00' in the configured time zone."""
    return moment.astimezone(config.timezone()).strftime("%d %b %H:%M")


def printing_record(order: Order):
    return next((r for r in order.production_records if r.step == "printing"), None)


def planning_problem(order: Order) -> str | None:
    """Why this order's plan cannot be created or changed (None = fine)."""
    if order.can_plan:
        return None
    if order.status == "released":
        return "Order is released and read-only"
    if order.status not in ("new", "in_production") or order.current_step not in PLANNING_STEPS:
        return "Only orders that have not yet finished printing can be planned"
    if printing_record(order) is not None:
        return "Printing has already started for this order, so its plan can no longer be changed"
    return None


def overlapping(db: Session, machine_id: int, start: datetime, end: datetime, except_order_id: int) -> list[Order]:
    query = (
        select(Order).where(
            Order.planned_machine_id == machine_id, Order.plan_active,
            Order.id != except_order_id, Order.planned_start_at < end, Order.planned_end_at > start,
        ).order_by(Order.planned_start_at)
    )
    return list(db.execute(query).scalars())


def check_materials(db: Session, order: Order) -> None:
    """A job can only be planned if its materials can exist: active, and in stock (reservations aside)."""
    available, inactive = material_state(db)
    on_hand = {name: amount for name, amount in db.execute(select(Resource.name, Resource.on_hand)).all()}
    problems = []
    for need in required_materials(order):
        if need["name"] in inactive:
            problems.append(f"{need['name']} is inactive")
        elif on_hand[need["name"]] < need["quantity"]:
            problems.append(
                f"not enough {need['name']} in stock ({need['quantity']} {need['unit']} needed, "
                f"{on_hand[need['name']]} {need['unit']} on hand)"
            )
    if problems:
        raise BusinessRuleError("This order cannot be planned: " + "; ".join(problems))


def set_schedule(db: Session, order_id: int, data: ScheduleRequest, actor) -> Order:
    order = get_order(db, order_id, lock=True)  # lock order: the order, then the printer (as everywhere else)
    problem = planning_problem(order)
    if problem:
        raise BusinessRuleError(problem)

    machine = db.execute(
        select(Machine).where(Machine.id == data.machine_id).with_for_update()
    ).scalar_one_or_none()
    if machine is None:
        raise not_found("Printer")

    start = data.planned_start_at.astimezone(timezone.utc)
    if start < utcnow() - timedelta(minutes=2):
        raise BusinessRuleError("The planned start is in the past. Choose a time from now on", status_code=422)
    end = start + timedelta(minutes=data.estimated_duration_minutes)

    check_materials(db, order)
    clashes = overlapping(db, machine.id, start, end, order.id)
    if clashes:
        first = clashes[0]
        raise BusinessRuleError(
            f"{machine.name} is already planned for {first.order_number} from {local(first.planned_start_at)} "
            f"to {local(first.planned_end_at)}. Choose another time or printer"
        )

    again = order.planned_start_at is not None
    order.planned_machine_id = machine.id
    order.planned_start_at = start
    order.estimated_duration_minutes = data.estimated_duration_minutes
    order.planned_end_at = end
    order.plan_active = True
    note = (f"{'Rescheduled' if again else 'Planned'} on {machine.name}: {local(start)} to {local(end)} "
            f"({data.estimated_duration_minutes} min)")
    record_history(db, order, note, actor=actor.username)
    audit.record(db, "order_rescheduled" if again else "order_scheduled", actor, target_type="order", target_id=order.id,
                 details={"printer": machine.name, "start": start.isoformat(), "minutes": data.estimated_duration_minutes})
    try:
        db.commit()
    except IntegrityError:
        # Two requests raced for the same slot: the database constraint stopped the second one.
        db.rollback()
        raise BusinessRuleError(f"{machine.name} was just planned for that time by someone else. Choose another time")
    return order


def clear_schedule(db: Session, order_id: int, actor) -> Order:
    order = get_order(db, order_id, lock=True)
    problem = planning_problem(order)
    if problem:
        raise BusinessRuleError(problem)
    if order.planned_start_at is None:
        raise BusinessRuleError("This order has no plan", status_code=409)
    order.planned_machine_id = order.planned_start_at = order.estimated_duration_minutes = order.planned_end_at = None
    record_history(db, order, "Plan removed", actor=actor.username)
    audit.record(db, "order_schedule_cleared", actor, target_type="order", target_id=order.id)
    db.commit()
    return order


def get_schedule(db: Session, start: datetime | None, days: int) -> dict:
    now = utcnow()
    if start is None:
        start = now.replace(minute=0, second=0, microsecond=0) - timedelta(hours=3)
    start = start.astimezone(timezone.utc)
    end = start + timedelta(days=days)

    orders = list(db.execute(
        select(Order).where(
            Order.planned_machine_id.is_not(None), Order.planned_start_at < end, Order.planned_end_at > start,
        ).options(selectinload(Order.production_records)).order_by(Order.planned_start_at, Order.id)
    ).scalars())

    available, inactive = material_state(db)
    machines = get_machines(db)
    printers, alerts = [], []
    for machine in machines:
        jobs = []
        for order in (o for o in orders if o.planned_machine_id == machine["id"]):
            record = printing_record(order)
            state = order.schedule_state
            short = bool(find_shortages(required_materials(order), available, inactive)) if record is None else False
            jobs.append({
                "order_id": order.id, "order_number": order.order_number, "product": order.product,
                "quantity": order.quantity, "machine_id": machine["id"],
                "planned_start_at": order.planned_start_at, "planned_end_at": order.planned_end_at,
                "estimated_duration_minutes": order.estimated_duration_minutes, "state": state,
                "actual_start_at": record.started_at if record else None,
                "actual_end_at": record.completed_at if record else None,
                "material_short_now": short, "can_change": record is None and order.status != "released",
            })
            if state == "delayed":
                what = "is running past its planned end" if record else "has not started although its planned start has passed"
                alerts.append(f"{order.order_number} on {machine['name']} {what} ({local(order.planned_start_at)})")
        upcoming = next((j for j in jobs if j["state"] == "planned"), None)
        printers.append({
            "id": machine["id"], "name": machine["name"], "status": machine["status"],
            "current_order_number": machine["current_order_number"],
            "next_planned_order_number": upcoming["order_number"] if upcoming else None,
            "next_planned_start_at": upcoming["planned_start_at"] if upcoming else None,
            "jobs": jobs,
        })

    not_printing_yet = ~exists().where(ProductionRecord.order_id == Order.id, ProductionRecord.step == "printing")
    unplanned = (
        Order.planned_start_at.is_(None), Order.status.in_(["new", "in_production"]),
        Order.current_step.in_(PLANNING_STEPS), not_printing_yet,
    )
    candidates = list(db.execute(
        select(Order).where(*unplanned).order_by(Order.queued_at, Order.id).limit(UNSCHEDULED_SHOWN)
    ).scalars())
    unscheduled = candidates
    total = db.execute(select(func.count()).select_from(Order).where(*unplanned)).scalar_one()

    return {
        "timezone": config.APP_TIMEZONE, "now": now, "window_start": start, "window_end": end,
        "printers": printers, "alerts": alerts, "unscheduled_total": total,
        "unscheduled": [
            {"id": o.id, "order_number": o.order_number, "product": o.product, "quantity": o.quantity,
             "current_step": o.current_step, "queued_at": o.queued_at}
            for o in unscheduled
        ],
    }
