"""Materials: stock balances, creating and editing them, and the controlled stock-adjustment workflow."""
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from app.catalog import PRODUCTS
from app.errors import BusinessRuleError, not_found
from app.models import Resource, ResourceUsage, StockAdjustment
from app.schemas import MAX_STOCK, ResourceCreate, ResourceUpdate, StockAdjustmentCreate
from app.services import audit
from app.services.orders import required_materials_for
from app.services.pagination import paginate
from app.services.production import find_shortages, material_state, waiting_printing_rows

SHORT_ORDERS_SHOWN = 5


def catalog_material_names() -> set[str]:
    """Materials that the product definitions (in code) refer to by name."""
    return {name for product in PRODUCTS.values() for name in product["materials"]}


def get_resource(db: Session, resource_id: int, lock: bool = False) -> Resource:
    query = select(Resource).where(Resource.id == resource_id)
    if lock:
        query = query.with_for_update().execution_options(populate_existing=True)
    resource = db.execute(query).scalar_one_or_none()
    if resource is None:
        raise not_found("Material")
    return resource


def name_taken(db: Session, name: str, except_id: int | None = None) -> bool:
    query = select(func.count()).select_from(Resource).where(func.lower(Resource.name) == name.lower())
    if except_id is not None:
        query = query.where(Resource.id != except_id)
    return db.execute(query).scalar_one() > 0


def has_history(db: Session, resource: Resource) -> bool:
    """Has this material ever been reserved, used or adjusted? Then its unit can no longer change."""
    used = db.execute(select(func.count()).select_from(ResourceUsage).where(ResourceUsage.resource_id == resource.id)).scalar_one()
    adjusted = db.execute(select(func.count()).select_from(StockAdjustment).where(StockAdjustment.resource_id == resource.id)).scalar_one()
    return bool(used or adjusted or resource.reserved)


# ---------- Reading ----------

def list_usage(db: Session, order_id: int | None, resource_id: int | None, page: int, page_size: int) -> dict:
    """Material usage history, newest first, filtered and paged by the database."""
    query = (
        select(ResourceUsage)
        .options(selectinload(ResourceUsage.order), selectinload(ResourceUsage.resource))
        .order_by(ResourceUsage.id.desc())
    )
    if order_id:
        query = query.where(ResourceUsage.order_id == order_id)
    if resource_id:
        query = query.where(ResourceUsage.resource_id == resource_id)
    return paginate(db, query, page, page_size)


def resource_out(resource: Resource, short: list | None = None) -> dict:
    short = short or []
    return {
        "id": resource.id, "name": resource.name, "unit": resource.unit, "on_hand": resource.on_hand,
        "reserved": resource.reserved, "available": resource.available, "category": resource.category,
        "min_stock": resource.min_stock, "is_active": resource.is_active, "low_stock": resource.low_stock,
        "waiting_short_total": len(short), "waiting_short_orders": short[:SHORT_ORDERS_SHOWN],
    }


def list_resources(db: Session) -> list[dict]:
    """Stock balances, plus which waiting print jobs cannot get enough of each material."""
    resources = list(db.execute(select(Resource).order_by(Resource.id)).scalars())
    available, inactive = material_state(db)
    short = {resource.name: [] for resource in resources}  # material name -> waiting orders, oldest first
    for row in waiting_printing_rows(db):
        for need in find_shortages(required_materials_for(row.product, row.quantity), available, inactive):
            if not need["inactive"]:
                short[need["name"]].append({"id": row.id, "order_number": row.order_number})
    return [resource_out(r, short[r.name]) for r in resources]


def list_adjustments(db: Session, resource_id: int, page: int, page_size: int) -> dict:
    get_resource(db, resource_id)  # 404 for an unknown material
    query = (
        select(StockAdjustment).where(StockAdjustment.resource_id == resource_id)
        .options(selectinload(StockAdjustment.resource)).order_by(StockAdjustment.id.desc())
    )
    return paginate(db, query, page, page_size)


# ---------- Creating and editing (details only, never quantities) ----------

def create_resource(db: Session, data: ResourceCreate, actor) -> Resource:
    if name_taken(db, data.name):
        raise BusinessRuleError(f"A material named '{data.name}' already exists")
    resource = Resource(name=data.name, category=data.category, unit=data.unit, min_stock=data.min_stock,
                        on_hand=0, reserved=0, is_active=True)
    db.add(resource)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise BusinessRuleError(f"A material named '{data.name}' already exists")
    if data.initial_stock > 0:
        # Opening stock is a normal, recorded adjustment, so the history explains every unit
        db.add(StockAdjustment(
            resource=resource, quantity_change=data.initial_stock, on_hand_before=0, on_hand_after=data.initial_stock,
            reason="Initial stock", actor_user_id=actor.user_id, actor_username=actor.username,
        ))
        resource.on_hand = data.initial_stock
    audit.record(db, "resource_created", actor, target_type="resource", target_id=resource.id,
                 details={"name": resource.name, "unit": resource.unit, "initial_stock": data.initial_stock})
    db.commit()
    return resource


def update_resource(db: Session, resource_id: int, data: ResourceUpdate, actor) -> Resource:
    resource = get_resource(db, resource_id, lock=True)
    changes = data.model_dump(exclude_unset=True)
    changed = {}

    if "name" in changes and changes["name"] != resource.name:
        if resource.name in catalog_material_names():
            raise BusinessRuleError(
                f"'{resource.name}' is used by product definitions under that name, so it cannot be renamed"
            )
        if name_taken(db, changes["name"], except_id=resource.id):
            raise BusinessRuleError(f"A material named '{changes['name']}' already exists")
        changed["name"] = [resource.name, changes["name"]]
        resource.name = changes["name"]

    if "unit" in changes and changes["unit"] != resource.unit:
        if has_history(db, resource):
            raise BusinessRuleError(
                "The unit cannot be changed: this material has stock movements, reservations or usage recorded "
                "in the old unit. Create a new material instead"
            )
        changed["unit"] = [resource.unit, changes["unit"]]
        resource.unit = changes["unit"]

    if "is_active" in changes and changes["is_active"] != resource.is_active:
        if not changes["is_active"] and resource.reserved > 0:
            raise BusinessRuleError(
                f"Cannot deactivate: {resource.reserved} {resource.unit} is reserved for printing jobs. "
                "Complete those jobs first"
            )
        changed["is_active"] = [resource.is_active, changes["is_active"]]
        resource.is_active = changes["is_active"]

    for field in ("category", "min_stock"):
        if field in changes and changes[field] != getattr(resource, field):
            changed[field] = [getattr(resource, field), changes[field]]
            setattr(resource, field, changes[field])

    if changed:
        audit.record(db, "resource_updated", actor, target_type="resource", target_id=resource.id, details=changed)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise BusinessRuleError("That change conflicts with an existing material")
    return resource


# ---------- Stock adjustments ----------

def adjust_stock(db: Session, resource_id: int, data: StockAdjustmentCreate, actor) -> StockAdjustment:
    """Add or remove stock. The material row is locked, so this cannot race with reservations or other
    adjustments, and available stock can never go negative."""
    resource = get_resource(db, resource_id, lock=True)
    new_on_hand = resource.on_hand + data.quantity_change
    if new_on_hand > MAX_STOCK:
        raise BusinessRuleError(f"Stock cannot be more than {MAX_STOCK:,} {resource.unit}", status_code=422)
    if new_on_hand < resource.reserved:
        most = resource.on_hand - resource.reserved
        raise BusinessRuleError(
            f"Cannot remove {-data.quantity_change} {resource.unit}: only {most} {resource.unit} is available "
            f"({resource.reserved} {resource.unit} is reserved for printing jobs)"
        )
    adjustment = StockAdjustment(
        resource=resource, quantity_change=data.quantity_change, on_hand_before=resource.on_hand,
        on_hand_after=new_on_hand, reason=data.reason, actor_user_id=actor.user_id, actor_username=actor.username,
    )
    resource.on_hand = new_on_hand
    db.add(adjustment)
    audit.record(db, "stock_adjusted", actor, target_type="resource", target_id=resource.id,
                 details={"change": data.quantity_change, "after": new_on_hand, "reason": data.reason[:120]})
    db.commit()
    return adjustment
