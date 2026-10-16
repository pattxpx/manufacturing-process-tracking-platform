from datetime import datetime
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.catalog import PRODUCTS


class RequestModel(BaseModel):
    """Base for everything a client sends. Unknown fields are rejected (HTTP 422), so a client can never
    set a field the endpoint does not explicitly offer, such as a role, a status or a user id."""

    model_config = ConfigDict(extra="forbid")


class OrderCreate(RequestModel):
    order_number: str | None = Field(default=None, max_length=30)
    product: str
    quantity: int = Field(gt=0, le=100000)
    design_reference: str = Field(max_length=100)
    notes: str | None = Field(default=None, max_length=1000)

    @field_validator("order_number", "design_reference", "notes")
    @classmethod
    def strip_text(cls, value):
        return value.strip() if value else value

    @field_validator("order_number")
    @classmethod
    def blank_number_means_auto(cls, value):
        return value or None

    @field_validator("design_reference")
    @classmethod
    def design_reference_required(cls, value):
        if not value:
            raise ValueError("Design reference is required")
        return value

    @field_validator("product")
    @classmethod
    def product_must_exist(cls, value):
        if value not in PRODUCTS:
            raise ValueError("Unknown product")
        return value


class OrderUpdate(RequestModel):
    """Only the fields that are sent are changed."""

    order_number: str | None = Field(default=None, min_length=1, max_length=30)
    product: str | None = None
    quantity: int | None = Field(default=None, gt=0, le=100000)
    design_reference: str | None = Field(default=None, min_length=1, max_length=100)
    notes: str | None = Field(default=None, max_length=1000)

    @field_validator("product")
    @classmethod
    def product_must_exist(cls, value):
        if value is not None and value not in PRODUCTS:
            raise ValueError("Unknown product")
        return value


class StartStepRequest(RequestModel):
    machine_id: int | None = None  # printing only; leave empty to use the first idle printer


class MaterialActual(RequestModel):
    resource_id: int
    actual_quantity: int = Field(gt=0)


class CompleteStepRequest(RequestModel):
    """Printing only. Materials that are left out default to their reserved quantity."""

    actual_usage: list[MaterialActual] | None = None

    @model_validator(mode="after")
    def no_duplicate_materials(self):
        ids = [entry.resource_id for entry in self.actual_usage or []]
        if len(ids) != len(set(ids)):
            raise ValueError("Each material can only be listed once")
        return self


class InspectionCreate(RequestModel):
    result: Literal["pass", "fail"]
    notes: str | None = Field(default=None, max_length=1000)

    @field_validator("notes")
    @classmethod
    def strip_notes(cls, value):
        return value.strip() if value else None

    @model_validator(mode="after")
    def fail_needs_notes(self):
        if self.result == "fail" and not self.notes:
            raise ValueError("Notes are required when an inspection fails")
        return self


# ---- Responses ----

class OrmModel(BaseModel):
    model_config = ConfigDict(from_attributes=True)


T = TypeVar("T")


class Page(BaseModel, Generic[T]):
    """One page of a list. total is the size of the whole filtered list."""

    items: list[T]
    total: int
    page: int         # the page that was actually returned (the last page if a later one was asked for)
    page_size: int
    total_pages: int  # at least 1, even for an empty list


class OrderOut(OrmModel):
    id: int
    order_number: str
    product: str
    quantity: int
    design_reference: str
    notes: str | None
    status: str
    current_step: str
    step_state: str
    queued_at: datetime
    created_at: datetime
    updated_at: datetime
    can_edit: bool
    can_edit_production_fields: bool
    latest_inspection_result: str | None
    release_blockers: list[str]
    # Planning. These are PLANNED times; the actual times are in the production records.
    planned_machine_id: int | None
    planned_start_at: datetime | None
    estimated_duration_minutes: int | None
    planned_end_at: datetime | None
    schedule_state: str | None  # planned | running | delayed | completed (None = not planned)
    can_plan: bool              # the print job may be planned or re-planned now


class ProductionRecordOut(OrmModel):
    id: int
    step: str
    status: str
    machine_name: str | None
    started_at: datetime
    completed_at: datetime | None


class InspectionOut(OrmModel):
    id: int
    order_id: int
    order_number: str
    result: str
    notes: str | None
    inspected_at: datetime
    inspected_by: str


class HistoryOut(OrmModel):
    id: int
    order_id: int
    order_number: str
    from_status: str | None
    to_status: str
    note: str
    actor: str
    created_at: datetime


class MaterialRequirement(BaseModel):
    name: str
    unit: str
    quantity: int   # needed by the whole order
    available: int  # in stock right now (on hand - reserved)


class ProductMaterial(BaseModel):
    name: str
    unit: str
    per_unit: int


class ProductOut(BaseModel):
    name: str
    materials: list[ProductMaterial]


class OrderDetail(OrderOut):
    production_records: list[ProductionRecordOut]
    inspections: list[InspectionOut]
    history: list[HistoryOut]
    material_requirements: list[MaterialRequirement]


class MachineOut(BaseModel):
    id: int
    name: str
    status: str
    current_order_id: int | None
    current_order_number: str | None


class ShortOrder(BaseModel):
    id: int
    order_number: str


class ResourceOut(OrmModel):
    id: int
    name: str
    unit: str
    on_hand: int
    reserved: int
    available: int
    category: str = "other"
    min_stock: int = 0
    is_active: bool = True
    low_stock: bool = False  # available stock is below the minimum
    # Only filled in by GET /api/resources: waiting print jobs that cannot get enough of this material
    waiting_short_total: int = 0
    waiting_short_orders: list[ShortOrder] = []  # the oldest few


class ResourceUsageOut(OrmModel):
    id: int
    order_id: int
    order_number: str
    resource_id: int
    resource_name: str
    unit: str
    reserved_quantity: int
    actual_quantity: int | None
    status: str
    created_at: datetime
    consumed_at: datetime | None


class QueueItem(BaseModel):
    position: int
    step: str
    order: OrderOut
    can_start: bool
    blocked_reasons: list[str]
    material_requirements: list[MaterialRequirement]  # empty for steps that use no material


class BoardItem(BaseModel):
    """One order on the production board. position is set for orders that are waiting in the FIFO queue."""

    order: OrderOut
    position: int | None
    can_start: bool
    blocked_reasons: list[str]
    material_requirements: list[MaterialRequirement]


class BoardStep(BaseModel):
    step: str
    label: str
    total: int               # all orders at this step, even if only some are listed
    orders: list[BoardItem]


class BoardOut(BaseModel):
    steps: list[BoardStep]
    released_total: int
    limit: int


class StepSummary(BaseModel):
    step: str
    label: str
    waiting: int
    running: int
    completed: int


class DashboardSummary(BaseModel):
    total_orders: int
    in_production: int
    awaiting_qc: int
    qc_failed: int
    released: int
    steps: list[StepSummary]
    machines: list[MachineOut]
    resources: list[ResourceOut]
    recent_activity: list[HistoryOut]


# ---------- Authentication and users ----------

ROLE_PATTERN = r"^[a-z_]{3,30}$"


class LoginRequest(RequestModel):
    username: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=128)


class ChangePasswordRequest(RequestModel):
    current_password: str = Field(min_length=1, max_length=128)
    new_password: str = Field(min_length=1, max_length=128)


class UserCreate(RequestModel):
    username: str = Field(pattern=r"^[A-Za-z0-9._-]{3,50}$")
    full_name: str = Field(min_length=1, max_length=100)
    password: str = Field(min_length=1, max_length=128)
    role: str = Field(default="admin", pattern=ROLE_PATTERN)  # checked against the defined roles by the service

    @field_validator("full_name")
    @classmethod
    def strip_name(cls, value):
        value = value.strip()
        if not value:
            raise ValueError("Name is required")
        return value


class UserUpdate(RequestModel):
    full_name: str | None = Field(default=None, min_length=1, max_length=100)
    role: str | None = Field(default=None, pattern=ROLE_PATTERN)
    is_active: bool | None = None


class PasswordReset(RequestModel):
    new_password: str = Field(min_length=1, max_length=128)


class UserOut(OrmModel):
    id: int
    username: str
    full_name: str
    role: str
    is_active: bool
    created_at: datetime
    last_login_at: datetime | None


class MeOut(BaseModel):
    user: UserOut
    permissions: list[str]
    csrf_token: str      # send this in the X-CSRF-Token header on every POST, PATCH, PUT and DELETE
    timezone: str


class AuditEventOut(OrmModel):
    id: int
    created_at: datetime
    actor_username: str | None
    action: str
    target_type: str | None
    target_id: str | None
    success: bool
    ip: str | None
    details: str | None


# ---------- Scheduling ----------

class ScheduleRequest(RequestModel):
    machine_id: int
    planned_start_at: datetime  # must include a time zone (for example "2026-10-20T09:00:00+07:00" or "...Z")
    estimated_duration_minutes: int = Field(ge=1, le=10080)

    @field_validator("planned_start_at")
    @classmethod
    def must_have_timezone(cls, value):
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError("Include a time zone, for example 2026-10-20T09:00:00+07:00 or ending in Z")
        return value


class ScheduleJob(BaseModel):
    order_id: int
    order_number: str
    product: str
    quantity: int
    machine_id: int
    planned_start_at: datetime
    planned_end_at: datetime
    estimated_duration_minutes: int
    state: str                       # planned | running | delayed | completed
    actual_start_at: datetime | None
    actual_end_at: datetime | None
    material_short_now: bool         # printing could not start right now for lack of material
    can_change: bool                 # still allowed to move or clear (printing has not started)


class SchedulePrinter(BaseModel):
    id: int
    name: str
    status: str                      # idle | busy (the app's own record, not a machine signal)
    current_order_number: str | None
    next_planned_order_number: str | None
    next_planned_start_at: datetime | None
    jobs: list[ScheduleJob]


class UnscheduledOrder(BaseModel):
    id: int
    order_number: str
    product: str
    quantity: int
    current_step: str
    queued_at: datetime


class ScheduleOut(BaseModel):
    timezone: str
    now: datetime
    window_start: datetime
    window_end: datetime
    printers: list[SchedulePrinter]
    unscheduled: list[UnscheduledOrder]
    unscheduled_total: int
    alerts: list[str]                # delayed jobs, with the printer and order


# ---------- Resource management ----------

UNITS = ("g", "kg", "ml", "L", "pcs")
CATEGORIES = ("powder", "resin", "gas", "solvent", "other")
MAX_STOCK = 1_000_000_000


class ResourceCreate(RequestModel):
    name: str = Field(min_length=1, max_length=100)
    category: Literal["powder", "resin", "gas", "solvent", "other"] = "other"
    unit: Literal["g", "kg", "ml", "L", "pcs"]
    min_stock: int = Field(default=0, ge=0, le=MAX_STOCK)
    initial_stock: int = Field(default=0, ge=0, le=MAX_STOCK)  # recorded as the first stock adjustment

    @field_validator("name")
    @classmethod
    def strip_name(cls, value):
        value = " ".join(value.split())
        if not value:
            raise ValueError("Name is required")
        return value


class ResourceUpdate(RequestModel):
    """Details only. Quantities can NOT be set here: stock changes go through stock adjustments."""

    name: str | None = Field(default=None, min_length=1, max_length=100)
    category: Literal["powder", "resin", "gas", "solvent", "other"] | None = None
    unit: Literal["g", "kg", "ml", "L", "pcs"] | None = None
    min_stock: int | None = Field(default=None, ge=0, le=MAX_STOCK)
    is_active: bool | None = None

    @field_validator("name")
    @classmethod
    def strip_name(cls, value):
        if value is None:
            return value
        value = " ".join(value.split())
        if not value:
            raise ValueError("Name is required")
        return value


class StockAdjustmentCreate(RequestModel):
    quantity_change: int = Field(ge=-MAX_STOCK, le=MAX_STOCK)  # positive adds stock, negative removes it
    reason: str = Field(min_length=3, max_length=255)

    @field_validator("quantity_change")
    @classmethod
    def not_zero(cls, value):
        if value == 0:
            raise ValueError("The change must not be zero")
        return value

    @field_validator("reason")
    @classmethod
    def strip_reason(cls, value):
        value = value.strip()
        if len(value) < 3:
            raise ValueError("Give a reason (at least 3 characters)")
        return value


class StockAdjustmentOut(OrmModel):
    id: int
    resource_id: int
    resource_name: str
    unit: str
    quantity_change: int
    on_hand_before: int
    on_hand_after: int
    reason: str
    actor_username: str
    created_at: datetime
