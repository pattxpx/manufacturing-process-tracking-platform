"""Starting and completing production steps, printers, material reservations and the FIFO queue."""
from sqlalchemy import exists, func, select
from sqlalchemy.orm import Session, selectinload

from app.catalog import BOARD_STEPS, STEP_LABELS, STEPS
from app.errors import BusinessRuleError, not_found
from app.models import (
    Machine, Order, ProductionRecord, Resource, ResourceUsage, utcnow,
)
from app.services.orders import (
    get_order, get_resources, material_requirements, record_history, required_materials,
    required_materials_for,
)


# ---------- Checks (shared by the start endpoint and the queue view) ----------

def sequence_error(order: Order, step: str) -> str | None:
    """Why this step cannot be started or completed for this order right now (None if fine)."""
    if step not in STEPS:
        return f"Unknown step '{step}'"
    if order.status == "released":
        return "Order is released and read-only"
    if step != order.current_step:
        return (
            f"Cannot use {STEP_LABELS[step]} now: this order is at "
            f"{STEP_LABELS[order.current_step]}. Steps cannot be skipped."
        )
    if step not in BOARD_STEPS:
        return f"{STEP_LABELS[step]} is handled on the Quality & Release page"
    return None


def find_printer(db: Session, machine_id: int | None, lock: bool, preferred_id: int | None = None) -> tuple[Machine | None, str | None]:
    """Pick the printer for a job. Returns (printer, None) or (None, reason it is not possible).
    With no explicit printer, the printer the job is PLANNED on is used if it is free, otherwise any free one."""
    query = select(Machine).order_by(Machine.id)
    if machine_id is not None:
        query = query.where(Machine.id == machine_id)
    if lock:
        # Locked rows are re-checked after waiting, so two requests cannot get the same printer.
        query = query.with_for_update().execution_options(populate_existing=True)
    machines = list(db.execute(query).scalars())

    if machine_id is not None:
        if not machines:
            raise not_found("Printer")
        machine = machines[0]
        if machine.status != "idle":
            return None, f"{machine.name} is busy"
        return machine, None

    if preferred_id is not None:
        machines.sort(key=lambda m: m.id != preferred_id)  # the planned printer first (sort is stable)
    for machine in machines:
        if machine.status == "idle":
            return machine, None
    return None, "All printers are busy"


def find_shortages(requirements: list[dict], available: dict[str, int], inactive=frozenset()) -> list[dict]:
    """The materials that cannot be used: switched off (inactive) or not available in the needed amount.
    No database access."""
    return [
        {**need, "available": available[need["name"]], "inactive": need["name"] in inactive}
        for need in requirements if need["name"] in inactive or available[need["name"]] < need["quantity"]
    ]


def shortage_message(short: dict) -> str:
    if short.get("inactive"):
        return f"{short['name']} is inactive and cannot be used. Ask an administrator to activate it"
    return (
        f"Insufficient {short['name']}: needs {short['quantity']} {short['unit']}, "
        f"only {short['available']} {short['unit']} available"
    )


def material_state(db: Session) -> tuple[dict[str, int], set[str]]:
    """Available stock (on hand - reserved) of every material, and which materials are inactive. One query."""
    rows = db.execute(select(Resource.name, Resource.on_hand - Resource.reserved, Resource.is_active)).all()
    return {name: available for name, available, _ in rows}, {name for name, _, active in rows if not active}


def available_by_material(db: Session) -> dict[str, int]:
    return material_state(db)[0]


def material_shortages(db: Session, order: Order, lock: bool = False) -> list[str]:
    """One message per material that is not available in the needed amount (empty list = enough of everything)."""
    resources = get_resources(db, order, lock=lock)
    available = {name: resource.available for name, resource in resources.items()}
    inactive = {name for name, resource in resources.items() if not resource.is_active}
    return [shortage_message(s) for s in find_shortages(required_materials(order), available, inactive)]


def waiting_condition(steps: list[str]):
    """SQL condition: the order is at one of these steps and is not running it (it is waiting in the queue)."""
    running = exists().where(
        ProductionRecord.order_id == Order.id,
        ProductionRecord.step == Order.current_step,
        ProductionRecord.status == "in_progress",
    )
    return (Order.current_step.in_(steps)) & (Order.status.in_(["new", "in_production"])) & (~running)


def waiting_printing_rows(db: Session) -> list:
    """The print queue, oldest first (FIFO). Light rows only: just what the scheduling rules need."""
    query = (
        select(Order.id, Order.order_number, Order.product, Order.quantity)
        .where(waiting_condition(["printing"]))
        .order_by(Order.queued_at, Order.id)
    )
    return db.execute(query).all()


def older_order_that_must_go_first(db: Session, order: Order):
    """FIFO: the oldest waiting order ahead of this one that could start (it has enough material)."""
    available, inactive = material_state(db)
    for row in waiting_printing_rows(db):
        if row.id == order.id:
            return None  # we reached ourselves: nobody eligible is ahead
        if not find_shortages(required_materials_for(row.product, row.quantity), available, inactive):
            return row
    return None


def fifo_message(order_number: str) -> str:
    return f"Waiting for older order {order_number} (first in, first out)"


def printing_blockers(db: Session, order: Order, machine_id: int | None = None, lock: bool = False):
    """Returns (printer, reasons). Reasons is empty when printing can start."""
    reasons = []
    printer, printer_problem = find_printer(db, machine_id, lock, preferred_id=order.planned_machine_id)
    if printer_problem:
        reasons.append(printer_problem)
    reasons.extend(material_shortages(db, order, lock=lock))
    first = older_order_that_must_go_first(db, order)
    if first:
        reasons.append(fifo_message(first.order_number))
    return printer, reasons


# ---------- Start / complete ----------

def start_step(db: Session, order_id: int, step: str, machine_id: int | None, actor: str = "system") -> Order:
    order = get_order(db, order_id, lock=True)

    problem = sequence_error(order, step)
    if problem:
        raise BusinessRuleError(problem)
    if order.step_state == "running":
        raise BusinessRuleError(f"{STEP_LABELS[step]} is already in progress")

    note = f"{STEP_LABELS[step]} started"

    if step == "printing":
        printer, reasons = printing_blockers(db, order, machine_id, lock=True)
        if reasons:
            raise BusinessRuleError("; ".join(reasons))
        record = ProductionRecord(order=order, step=step)
        db.add(record)
        needs = required_materials(order)
        resources = get_resources(db, order, lock=True)  # already locked above; same rows

        printer.status = "busy"
        record.machine = printer
        db.flush()
        # Reserve every material. Any failure after this point rolls the whole transaction back.
        for need in needs:
            resource = resources[need["name"]]
            resource.reserved += need["quantity"]
            db.add(ResourceUsage(
                order=order, resource=resource, production_record_id=record.id,
                reserved_quantity=need["quantity"],
            ))
        reserved = ", ".join(f"{n['quantity']} {n['unit']} {n['name']}" for n in needs)
        note = f"{STEP_LABELS[step]} started on {printer.name}, reserved {reserved}"
    else:
        db.add(ProductionRecord(order=order, step=step))

    new_status = "in_production" if order.status == "new" else None
    record_history(db, order, note, new_status=new_status, actor=actor)
    db.commit()
    return order


def consume_materials(db: Session, record: ProductionRecord, actual_usage: dict[int, int]) -> str:
    """Turn the job's reservations into consumption and free the printer.
    All materials are handled together: if anything is wrong, nothing is changed."""
    usages = list(db.execute(
        select(ResourceUsage).where(ResourceUsage.production_record_id == record.id)
        .order_by(ResourceUsage.resource_id)
    ).scalars())
    if any(usage.status != "reserved" for usage in usages):
        raise BusinessRuleError("Material for this job was already consumed")

    by_resource = {usage.resource_id: usage for usage in usages}
    problems = []
    for resource_id, quantity in actual_usage.items():
        usage = by_resource.get(resource_id)
        if usage is None:
            problems.append(f"Material {resource_id} was not reserved for this job")
        elif quantity > usage.reserved_quantity:
            problems.append(
                f"Actual usage of {usage.resource_name} ({quantity} {usage.unit}) cannot be more than "
                f"the reserved {usage.reserved_quantity} {usage.unit}"
            )
    if problems:
        raise BusinessRuleError("; ".join(problems), status_code=422)

    # Lock in the same order as starting a job: printer first, then materials by id.
    printer = db.execute(
        select(Machine).where(Machine.id == record.machine_id).with_for_update()
        .execution_options(populate_existing=True)
    ).scalar_one()
    resources = {
        resource.id: resource
        for resource in db.execute(
            select(Resource).where(Resource.id.in_(by_resource)).order_by(Resource.id)
            .with_for_update().execution_options(populate_existing=True)
        ).scalars()
    }

    used_parts = []
    for usage in usages:
        resource = resources[usage.resource_id]
        used = actual_usage.get(usage.resource_id, usage.reserved_quantity)
        resource.on_hand -= used
        resource.reserved -= usage.reserved_quantity  # the whole reservation is released
        usage.actual_quantity = used
        usage.status = "consumed"
        usage.consumed_at = utcnow()
        used_parts.append(f"{used} {resource.unit} {resource.name}")
    printer.status = "idle"
    return ", used " + ", ".join(used_parts)


def complete_step(db: Session, order_id: int, step: str, actual_usage: dict[int, int] | None, actor: str = "system") -> Order:
    """actual_usage maps resource id -> quantity really used. Materials not listed use their reservation."""
    order = get_order(db, order_id, lock=True)

    problem = sequence_error(order, step)
    if problem:
        raise BusinessRuleError(problem)
    record = next((r for r in order.production_records if r.step == step), None)
    if record is None or record.status != "in_progress":
        raise BusinessRuleError(f"{STEP_LABELS[step]} is not in progress, so it cannot be completed")

    note = f"{STEP_LABELS[step]} completed"
    if step == "printing":
        note += consume_materials(db, record, actual_usage or {})

    record.status = "completed"
    record.completed_at = utcnow()

    next_step = STEPS[STEPS.index(step) + 1]
    order.current_step = next_step
    order.queued_at = utcnow()
    new_status = "awaiting_qc" if next_step == "quality_inspection" else None
    if step == "printing":
        order.plan_active = False  # the job is done: its planned printer slot is free again
    record_history(db, order, note, new_status=new_status, actor=actor)
    db.commit()
    return order


# ---------- Read models ----------

def load_orders(db: Session, ids: list[int]) -> dict[int, Order]:
    """Full orders (with what the API needs to describe them) for just these ids."""
    if not ids:
        return {}
    query = select(Order).where(Order.id.in_(ids)).options(
        selectinload(Order.production_records), selectinload(Order.inspections)
    )
    return {order.id: order for order in db.execute(query).scalars()}


def compute_waiting(db: Session, limit_per_step: int | None) -> dict[str, dict]:
    """The waiting orders of design review, printing and post-processing: {step: {total, items}}.

    Which orders can start, and why not, is decided here over the WHOLE queue. limit_per_step only limits
    how many of the oldest orders are described in the result, never what is allowed to start.
    """
    result = {}

    # Design review and post-processing: no resources, so every waiting order can start. Plain FIFO.
    for step in ["design_review", "post_processing"]:
        condition = waiting_condition([step])
        total = db.execute(select(func.count()).select_from(Order).where(condition)).scalar_one()
        query = select(Order.id).where(condition).order_by(Order.queued_at, Order.id)
        if limit_per_step:
            query = query.limit(limit_per_step)
        ids = list(db.execute(query).scalars())
        result[step] = {"total": total, "ids": ids, "info": {i: ([], []) for i in ids}}

    # Printing: scan the whole queue once (cheap rows) to find who is blocked and why.
    available, inactive = material_state(db)
    printer, printer_problem = find_printer(db, None, lock=False)
    rows = waiting_printing_rows(db)
    first_eligible = None  # the oldest order that has enough material
    info = {}
    for row in rows:
        shortages = find_shortages(required_materials_for(row.product, row.quantity), available, inactive)
        reasons = [printer_problem] if printer_problem else []
        reasons += [shortage_message(s) for s in shortages]
        if first_eligible is not None:
            reasons.append(fifo_message(first_eligible.order_number))
        if not shortages and first_eligible is None:
            first_eligible = row
        info[row.id] = (reasons, required_materials_for(row.product, row.quantity))
    shown = rows[:limit_per_step] if limit_per_step else rows
    result["printing"] = {
        "total": len(rows), "ids": [row.id for row in shown], "info": {row.id: info[row.id] for row in shown},
    }

    orders = load_orders(db, [i for step in result.values() for i in step["ids"]])
    for step in result.values():
        step["items"] = []
        for position, order_id in enumerate(step["ids"], start=1):
            reasons, requirements = step["info"][order_id]
            order = orders[order_id]
            step["items"].append({
                "position": position,
                "step": order.current_step,
                "order": order,
                "can_start": not reasons,
                "blocked_reasons": reasons,
                "material_requirements": [
                    {**need, "available": available[need["name"]]} for need in requirements
                ] if requirements else [],
            })
    return result


def get_queue(db: Session, limit_per_step: int | None = None) -> list[dict]:
    """Every order waiting for a design review, printing or post-processing, oldest first within each step."""
    waiting = compute_waiting(db, limit_per_step)
    return [item for step in BOARD_STEPS for item in waiting[step]["items"]]


def get_board(db: Session, limit: int) -> dict:
    """What the production board shows: for each step the total, and the first `limit` orders."""
    waiting = compute_waiting(db, limit)
    totals = dict(db.execute(
        select(Order.current_step, func.count()).where(Order.status != "released").group_by(Order.current_step)
    ).all())

    steps = []
    for step in STEPS:
        if step in BOARD_STEPS:
            # Running orders first (never hidden by the limit), then the waiting queue
            running_ids = list(db.execute(
                select(Order.id).where(
                    Order.current_step == step, Order.status == "in_production", ~waiting_condition([step])
                ).order_by(Order.queued_at, Order.id).limit(limit)
            ).scalars())
            orders = load_orders(db, running_ids)
            items = [
                {"order": orders[i], "position": None, "can_start": False, "blocked_reasons": [],
                 "material_requirements": []}
                for i in running_ids
            ]
            items += [
                {k: item[k] for k in ("order", "position", "can_start", "blocked_reasons", "material_requirements")}
                for item in waiting[step]["items"]
            ]
            items = items[:limit]
        else:
            statuses = ["awaiting_qc", "qc_failed"] if step == "quality_inspection" else ["ready_for_release"]
            ids = list(db.execute(
                select(Order.id).where(Order.current_step == step, Order.status.in_(statuses))
                .order_by(Order.queued_at, Order.id).limit(limit)
            ).scalars())
            orders = load_orders(db, ids)
            items = [
                {"order": orders[i], "position": None, "can_start": False, "blocked_reasons": [],
                 "material_requirements": []}
                for i in ids
            ]
        steps.append({"step": step, "label": STEP_LABELS[step], "total": totals.get(step, 0), "orders": items})

    released_total = db.execute(
        select(func.count()).select_from(Order).where(Order.status == "released")
    ).scalar_one()
    return {"steps": steps, "released_total": released_total, "limit": limit}


def get_machines(db: Session) -> list[dict]:
    machines = list(db.execute(select(Machine).order_by(Machine.id)).scalars())
    running = db.execute(
        select(ProductionRecord).where(
            ProductionRecord.status == "in_progress", ProductionRecord.machine_id.is_not(None)
        )
    ).scalars()
    order_by_machine = {r.machine_id: r.order for r in running}
    return [
        {
            "id": m.id,
            "name": m.name,
            "status": m.status,
            "current_order_id": order_by_machine[m.id].id if m.id in order_by_machine else None,
            "current_order_number": order_by_machine[m.id].order_number if m.id in order_by_machine else None,
        }
        for m in machines
    ]
