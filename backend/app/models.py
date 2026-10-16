from datetime import datetime, timezone

from sqlalchemy import (
    Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, Text, UniqueConstraint, text,
)
from sqlalchemy.dialects.postgresql import ExcludeConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.catalog import STEP_LABELS, STEPS
from app.database import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="ck_orders_quantity_positive"),
        CheckConstraint(
            "status IN ('new','in_production','awaiting_qc','qc_failed','ready_for_release','released')",
            name="ck_orders_status",
        ),
        CheckConstraint(
            "current_step IN ('design_review','printing','post_processing','quality_inspection','final_release')",
            name="ck_orders_current_step",
        ),
        # A plan is either complete (printer, start, duration, end) or absent.
        CheckConstraint(
            "(planned_machine_id IS NULL AND planned_start_at IS NULL AND estimated_duration_minutes IS NULL "
            "AND planned_end_at IS NULL) OR (planned_machine_id IS NOT NULL AND planned_start_at IS NOT NULL "
            "AND estimated_duration_minutes IS NOT NULL AND planned_end_at IS NOT NULL)",
            name="ck_orders_plan_complete",
        ),
        CheckConstraint(
            "estimated_duration_minutes IS NULL OR estimated_duration_minutes BETWEEN 1 AND 10080",
            name="ck_orders_plan_duration",
        ),
        CheckConstraint(
            "planned_end_at IS NULL OR planned_end_at = planned_start_at + estimated_duration_minutes * interval '1 minute'",
            name="ck_orders_plan_end_matches",
        ),
        # Two plans can never overlap on the same printer (back-to-back is fine). The service checks first and
        # gives a clear message; this constraint is the guarantee when two requests race.
        ExcludeConstraint(
            ("planned_machine_id", "="),
            (text("tstzrange(planned_start_at, planned_end_at)"), "&&"),
            using="gist",
            where=text("planned_machine_id IS NOT NULL AND plan_active"),
            name="ex_orders_no_printer_overlap",
        ),
        Index("ix_orders_status", "status"),
        Index("ix_orders_planned_start", "planned_machine_id", "planned_start_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    order_number: Mapped[str] = mapped_column(String(30), unique=True)
    product: Mapped[str] = mapped_column(String(100))
    quantity: Mapped[int] = mapped_column(Integer)
    design_reference: Mapped[str] = mapped_column(String(100))
    notes: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="new")
    # The step that is running now, or the next one to start.
    current_step: Mapped[str] = mapped_column(String(30), default="design_review")
    # When the order started waiting for current_step. This is what the FIFO queue sorts on.
    queued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    # Planning (manual scheduling). These are PLANNED times. The ACTUAL times are in production_records.
    planned_machine_id: Mapped[int | None] = mapped_column(ForeignKey("machines.id"))
    planned_start_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    estimated_duration_minutes: Mapped[int | None] = mapped_column(Integer)
    planned_end_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # = start + duration
    # True while the plan still holds its printer slot. It is switched off when printing is completed.
    plan_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    production_records: Mapped[list["ProductionRecord"]] = relationship(
        back_populates="order", order_by="ProductionRecord.id"
    )
    inspections: Mapped[list["QualityInspection"]] = relationship(
        back_populates="order", order_by="QualityInspection.id.desc()"
    )
    history: Mapped[list["OrderStatusHistory"]] = relationship(
        back_populates="order", order_by="OrderStatusHistory.id.desc()"
    )

    # Simple derived values, so the API (and the UI) never has to re-implement these rules.
    @property
    def step_state(self) -> str:
        """'running' if the current step is in progress, 'done' if released, else 'waiting'."""
        if self.status == "released":
            return "done"
        for record in self.production_records:
            if record.step == self.current_step and record.status == "in_progress":
                return "running"
        return "waiting"

    @property
    def schedule_state(self) -> str | None:
        """planned / running / delayed / completed, from the plan and the ACTUAL printing record. None = no plan."""
        if self.planned_start_at is None:
            return None
        printing = next((r for r in self.production_records if r.step == "printing"), None)
        if printing is not None and printing.status == "completed":
            return "completed"
        now = utcnow()
        if printing is not None:
            return "delayed" if now > self.planned_end_at else "running"
        return "delayed" if now > self.planned_start_at else "planned"

    @property
    def latest_inspection_result(self) -> str | None:
        return self.inspections[0].result if self.inspections else None

    @property
    def release_blockers(self) -> list[str]:
        """Reasons this order cannot be released. Empty list = releasable."""
        if self.status == "released":
            return ["Order is already released"]

        reasons = []
        done = {r.step for r in self.production_records if r.status == "completed"}
        for step in STEPS[:4]:  # everything before Final Release
            if step not in done:
                reasons.append(f"{STEP_LABELS[step]} is not complete")

        latest = self.latest_inspection_result
        if latest is None:
            reasons.append("No inspection has been recorded")
        elif latest == "fail":
            reasons.append("The latest inspection failed. Re-inspect and pass it before release")
        return reasons

    @property
    def can_plan(self) -> bool:
        """May this order's print job be planned or re-planned? (not released, not yet printing, still before printing ends)"""
        started_printing = any(r.step == "printing" for r in self.production_records)
        return (self.status in ("new", "in_production") and self.current_step in ("design_review", "printing")
                and not started_printing)

    @property
    def can_edit(self) -> bool:
        return self.status != "released"

    @property
    def can_edit_production_fields(self) -> bool:
        return self.status == "new"


class Machine(Base):
    __tablename__ = "machines"
    __table_args__ = (CheckConstraint("status IN ('idle','busy')", name="ck_machines_status"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(50), unique=True)
    status: Mapped[str] = mapped_column(String(10), default="idle")


class ProductionRecord(Base):
    """One row per order per step. Created when the step starts."""

    __tablename__ = "production_records"
    __table_args__ = (
        UniqueConstraint("order_id", "step", name="uq_production_records_order_step"),
        CheckConstraint("status IN ('in_progress','completed')", name="ck_production_records_status"),
        # A machine can only be running one job at a time (double-allocation guard).
        Index(
            "uq_production_records_machine_running", "machine_id", unique=True,
            postgresql_where="status = 'in_progress'",
        ),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    step: Mapped[str] = mapped_column(String(30))
    status: Mapped[str] = mapped_column(String(15), default="in_progress")
    machine_id: Mapped[int | None] = mapped_column(ForeignKey("machines.id"))
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    order: Mapped[Order] = relationship(back_populates="production_records")
    machine: Mapped[Machine | None] = relationship()

    @property
    def machine_name(self) -> str | None:
        return self.machine.name if self.machine else None


class Resource(Base):
    __tablename__ = "resources"
    __table_args__ = (
        CheckConstraint("on_hand >= 0", name="ck_resources_on_hand"),
        CheckConstraint("reserved >= 0", name="ck_resources_reserved"),
        CheckConstraint("reserved <= on_hand", name="ck_resources_not_over_reserved"),
        CheckConstraint("min_stock >= 0", name="ck_resources_min_stock"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(100), unique=True)
    unit: Mapped[str] = mapped_column(String(10))
    on_hand: Mapped[int] = mapped_column(Integer)
    reserved: Mapped[int] = mapped_column(Integer, default=0)
    category: Mapped[str] = mapped_column(String(30), default="other", server_default="other")
    min_stock: Mapped[int] = mapped_column(Integer, default=0, server_default="0")  # low-stock warning level
    # Inactive materials cannot be reserved. They are never deleted, because history refers to them.
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, server_default=text("now()"))
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, server_default=text("now()")
    )

    @property
    def available(self) -> int:
        return self.on_hand - self.reserved

    @property
    def low_stock(self) -> bool:
        return self.is_active and self.min_stock > 0 and self.available < self.min_stock


class ResourceUsage(Base):
    """One material reserved for one printing job. actual_quantity is filled in when the job completes."""

    __tablename__ = "resource_usage"
    __table_args__ = (
        CheckConstraint("status IN ('reserved','consumed')", name="ck_resource_usage_status"),
        CheckConstraint("reserved_quantity > 0", name="ck_resource_usage_reserved_positive"),
        CheckConstraint(
            "actual_quantity IS NULL OR actual_quantity <= reserved_quantity",
            name="ck_resource_usage_actual_within_reserved",
        ),
        # One row per material per printing job, so a material can never be consumed twice for a job.
        UniqueConstraint("production_record_id", "resource_id", name="uq_resource_usage_job_material"),
        Index("ix_resource_usage_resource_id", "resource_id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    resource_id: Mapped[int] = mapped_column(ForeignKey("resources.id"))
    production_record_id: Mapped[int] = mapped_column(ForeignKey("production_records.id"))
    reserved_quantity: Mapped[int] = mapped_column(Integer)
    actual_quantity: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(10), default="reserved")
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    consumed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    order: Mapped[Order] = relationship()
    resource: Mapped[Resource] = relationship()

    @property
    def order_number(self) -> str:
        return self.order.order_number

    @property
    def resource_name(self) -> str:
        return self.resource.name

    @property
    def unit(self) -> str:
        return self.resource.unit


class QualityInspection(Base):
    """Inspection results are only ever added, never changed, so the full history is kept."""

    __tablename__ = "quality_inspections"
    __table_args__ = (CheckConstraint("result IN ('pass','fail')", name="ck_quality_inspections_result"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    result: Mapped[str] = mapped_column(String(4))
    notes: Mapped[str | None] = mapped_column(Text)
    inspected_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    inspected_by: Mapped[str] = mapped_column(String(50), default="system", server_default="system")  # from the session

    order: Mapped[Order] = relationship(back_populates="inspections")

    @property
    def order_number(self) -> str:
        return self.order.order_number


class OrderStatusHistory(Base):
    __tablename__ = "order_status_history"
    __table_args__ = (Index("ix_order_status_history_created_at", "created_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    order_id: Mapped[int] = mapped_column(ForeignKey("orders.id"), index=True)
    from_status: Mapped[str | None] = mapped_column(String(20))
    to_status: Mapped[str] = mapped_column(String(20))
    note: Mapped[str] = mapped_column(String(255))
    actor: Mapped[str] = mapped_column(String(50), default="system", server_default="system")  # from the session
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    order: Mapped[Order] = relationship(back_populates="history")

    @property
    def order_number(self) -> str:
        return self.order.order_number


# ---------- Users, sessions and security records ----------

class User(Base):
    __tablename__ = "users"
    __table_args__ = (CheckConstraint("username = lower(username)", name="ck_users_username_lowercase"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    username: Mapped[str] = mapped_column(String(50), unique=True)  # always stored in lower case
    full_name: Mapped[str] = mapped_column(String(100))
    password_hash: Mapped[str] = mapped_column(String(255))  # Argon2id. The password itself is never stored
    # Validated in the application (see app/auth/permissions.py), so a new role needs no migration.
    role: Mapped[str] = mapped_column(String(30), default="admin")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    password_changed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)


class UserSession(Base):
    """A login. The browser holds a random token; only its SHA-256 hash is stored here."""

    __tablename__ = "user_sessions"
    __table_args__ = (Index("ix_user_sessions_user_id", "user_id"), Index("ix_user_sessions_expires_at", "expires_at"))

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    csrf_token: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))  # absolute end of the session
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ip: Mapped[str | None] = mapped_column(String(45))
    user_agent: Mapped[str | None] = mapped_column(String(200))

    user: Mapped[User] = relationship()


class WebSocketTicket(Base):
    """A short-lived, single-use pass for opening the live-updates WebSocket (browsers cannot send cookies cross-site)."""

    __tablename__ = "websocket_tickets"
    __table_args__ = (Index("ix_websocket_tickets_expires_at", "expires_at"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    session_id: Mapped[int] = mapped_column(ForeignKey("user_sessions.id", ondelete="CASCADE"))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditEvent(Base):
    """Security and business audit trail. Append-only: the database refuses UPDATE and DELETE (see db_triggers.py)."""

    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_created_at", "created_at"),
        Index("ix_audit_events_action_created", "action", "created_at"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    actor_username: Mapped[str | None] = mapped_column(String(50))  # a copy, so the record stays readable
    action: Mapped[str] = mapped_column(String(60))
    target_type: Mapped[str | None] = mapped_column(String(30))
    target_id: Mapped[str | None] = mapped_column(String(40))
    success: Mapped[bool] = mapped_column(Boolean, default=True)
    ip: Mapped[str | None] = mapped_column(String(45))
    details: Mapped[str | None] = mapped_column(String(500))


class StockAdjustment(Base):
    """One manual change of a material's stock. Append-only: the full history is kept."""

    __tablename__ = "stock_adjustments"
    __table_args__ = (
        CheckConstraint("quantity_change <> 0", name="ck_stock_adjustments_change"),
        CheckConstraint("on_hand_after >= 0", name="ck_stock_adjustments_not_negative"),
        CheckConstraint("on_hand_after = on_hand_before + quantity_change", name="ck_stock_adjustments_arithmetic"),
        Index("ix_stock_adjustments_resource_id", "resource_id", "id"),
    )

    id: Mapped[int] = mapped_column(primary_key=True)
    resource_id: Mapped[int] = mapped_column(ForeignKey("resources.id"))
    quantity_change: Mapped[int] = mapped_column(Integer)
    on_hand_before: Mapped[int] = mapped_column(Integer)
    on_hand_after: Mapped[int] = mapped_column(Integer)
    reason: Mapped[str] = mapped_column(String(255))
    actor_user_id: Mapped[int | None] = mapped_column(ForeignKey("users.id"))
    actor_username: Mapped[str] = mapped_column(String(50))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    resource: Mapped[Resource] = relationship()

    @property
    def resource_name(self) -> str:
        return self.resource.name

    @property
    def unit(self) -> str:
        return self.resource.unit
