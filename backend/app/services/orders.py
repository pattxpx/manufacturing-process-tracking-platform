from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.catalog import MATERIALS, PRODUCTS
from app.errors import BusinessRuleError, not_found
from app.models import Order, OrderStatusHistory, Resource
from app.schemas import OrderCreate, OrderUpdate
from app.services.pagination import paginate


def get_order(db: Session, order_id: int, lock: bool = False) -> Order:
    """Load an order. lock=True takes a row lock until the transaction ends (use for changes)."""
    query = select(Order).where(Order.id == order_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    order = db.execute(query).scalar_one_or_none()
    if order is None:
        raise not_found("Order")
    return order


def record_history(db: Session, order: Order, note: str, new_status: str | None = None, actor: str = "system"):
    """Write one history row. If new_status is given the order moves to that status too.
    `actor` is the user name from the verified session ("system" for scripts)."""
    old_status = order.status
    if new_status:
        order.status = new_status
    db.add(OrderStatusHistory(
        order=order, from_status=old_status, to_status=order.status, note=note[:255], actor=actor,
    ))


def required_materials_for(product: str, quantity: int) -> list[dict]:
    """Everything an order of this product and size needs: [{name, unit, quantity}], in catalog order."""
    return [
        {"name": name, "unit": MATERIALS[name]["unit"], "quantity": per_unit * quantity}
        for name, per_unit in PRODUCTS[product]["materials"].items()
    ]


def required_materials(order: Order) -> list[dict]:
    return required_materials_for(order.product, order.quantity)


def get_resources(db: Session, order: Order, lock: bool = False) -> dict[str, Resource]:
    """The stock rows for the order's materials, by name.

    lock=True takes row locks until the transaction ends. The rows are always read in id order,
    so every request locks materials in the same order and two requests cannot deadlock.
    """
    names = [material["name"] for material in required_materials(order)]
    query = select(Resource).where(Resource.name.in_(names)).order_by(Resource.id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    resources = {resource.name: resource for resource in db.execute(query).scalars()}
    for name in names:
        if name not in resources:
            raise BusinessRuleError(f"Material '{name}' is not set up in the database", status_code=500)
    return resources


def material_requirements(db: Session, order: Order) -> list[dict]:
    """required_materials plus how much of each is available right now."""
    resources = get_resources(db, order)
    return [{**material, "available": resources[material["name"]].available} for material in required_materials(order)]


def next_order_number(db: Session) -> str:
    number = db.query(Order).count() + 1001
    while db.query(Order).filter(Order.order_number == f"ORD-{number}").count() > 0:
        number += 1
    return f"ORD-{number}"


def create_order(db: Session, data: OrderCreate, actor: str = "system") -> Order:
    order = Order(
        order_number=data.order_number or next_order_number(db),
        product=data.product,
        quantity=data.quantity,
        design_reference=data.design_reference,
        notes=data.notes,
    )
    db.add(order)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise BusinessRuleError(f"Order number {data.order_number} already exists")
    record_history(db, order, "Order created", new_status="new", actor=actor)
    db.commit()
    return order


def update_order(db: Session, order_id: int, data: OrderUpdate, actor: str = "system") -> Order:
    order = get_order(db, order_id, lock=True)
    changes = data.model_dump(exclude_unset=True)

    if not order.can_edit:
        raise BusinessRuleError("Released orders are read-only")

    production_fields = ["order_number", "product", "quantity", "design_reference"]
    locked = [f for f in production_fields if f in changes and changes[f] != getattr(order, f)]
    if locked and not order.can_edit_production_fields:
        raise BusinessRuleError(
            "Production has started, so these fields can no longer be changed: " + ", ".join(locked)
        )

    for field, value in changes.items():
        setattr(order, field, value.strip() if isinstance(value, str) else value)
    if changes:
        record_history(db, order, "Order details updated", actor=actor)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise BusinessRuleError("That order number already exists")
    return order


def list_orders(db: Session, search: str | None, status: str | None, step: str | None,
                page: int, page_size: int) -> dict:
    """One page of orders, newest first. Search and filters apply to the whole list, not just the page."""
    query = select(Order).options(
        selectinload(Order.production_records), selectinload(Order.inspections)
    )
    if search and search.strip():
        # Escape LIKE wildcards so that searching for "%" or "_" finds those characters
        text = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        like = f"%{text}%"
        query = query.where(or_(
            Order.order_number.ilike(like, escape="\\"),
            Order.product.ilike(like, escape="\\"),
            Order.design_reference.ilike(like, escape="\\"),
        ))
    if status:
        query = query.where(Order.status == status)
    if step:
        query = query.where(Order.current_step == step)
    return paginate(db, query.order_by(Order.id.desc()), page, page_size)
