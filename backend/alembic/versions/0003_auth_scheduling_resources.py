"""users and sessions, audit trail, printer scheduling, resource management

All changes are additive: existing rows keep working and get safe defaults.
  * users, user_sessions, websocket_tickets, audit_events  (authentication and audit)
  * orders: planned_machine_id, planned_start_at, estimated_duration_minutes, planned_end_at, plan_active
  * resources: category, min_stock, is_active, created_at, updated_at;  new table stock_adjustments
  * order_status_history.actor, quality_inspections.inspected_by (who did it; existing rows say "system")
  * append-only triggers on the audit and history tables
Needs the btree_gist extension (CREATE EXTENSION), which is used to forbid overlapping printer plans.

Revision ID: 0003_auth_scheduling
Revises: 0002_multi_material
"""
import sqlalchemy as sa
from alembic import op

from app import db_triggers

revision = "0003_auth_scheduling"
down_revision = "0002_multi_material"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")

    # ---- authentication and audit ----
    op.create_table(
        "users",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("username", sa.String(50), nullable=False),
        sa.Column("full_name", sa.String(100), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("role", sa.String(30), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_login_at", sa.DateTime(timezone=True)),
        sa.Column("password_changed_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("username"),
        sa.CheckConstraint("username = lower(username)", name="ck_users_username_lowercase"),
    )
    op.create_table(
        "user_sessions",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("csrf_token", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("ip", sa.String(45)),
        sa.Column("user_agent", sa.String(200)),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index("ix_user_sessions_user_id", "user_sessions", ["user_id"])
    op.create_index("ix_user_sessions_expires_at", "user_sessions", ["expires_at"])
    op.create_table(
        "websocket_tickets",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("session_id", sa.Integer(), sa.ForeignKey("user_sessions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index("ix_websocket_tickets_expires_at", "websocket_tickets", ["expires_at"])
    op.create_table(
        "audit_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("actor_user_id", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("actor_username", sa.String(50)),
        sa.Column("action", sa.String(60), nullable=False),
        sa.Column("target_type", sa.String(30)),
        sa.Column("target_id", sa.String(40)),
        sa.Column("success", sa.Boolean(), nullable=False),
        sa.Column("ip", sa.String(45)),
        sa.Column("details", sa.String(500)),
    )
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])
    op.create_index("ix_audit_events_action_created", "audit_events", ["action", "created_at"])

    # ---- who did it ----
    op.add_column("order_status_history", sa.Column("actor", sa.String(50), server_default="system", nullable=False))
    op.add_column("quality_inspections", sa.Column("inspected_by", sa.String(50), server_default="system", nullable=False))

    # ---- resource management ----
    op.add_column("resources", sa.Column("category", sa.String(30), server_default="other", nullable=False))
    op.add_column("resources", sa.Column("min_stock", sa.Integer(), server_default="0", nullable=False))
    op.add_column("resources", sa.Column("is_active", sa.Boolean(), server_default=sa.text("true"), nullable=False))
    op.add_column("resources", sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False))
    op.add_column("resources", sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False))
    op.create_check_constraint("ck_resources_min_stock", "resources", "min_stock >= 0")
    # The demo materials get a sensible category. Anything else stays "other" and can be edited in the app.
    op.execute(
        "UPDATE resources SET category = CASE "
        "WHEN name LIKE '%Powder' THEN 'powder' WHEN name LIKE '%Resin' THEN 'resin' "
        "WHEN name = 'Argon Gas' THEN 'gas' WHEN name = 'Isopropyl Alcohol' THEN 'solvent' ELSE category END"
    )
    op.create_table(
        "stock_adjustments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("resource_id", sa.Integer(), sa.ForeignKey("resources.id"), nullable=False),
        sa.Column("quantity_change", sa.Integer(), nullable=False),
        sa.Column("on_hand_before", sa.Integer(), nullable=False),
        sa.Column("on_hand_after", sa.Integer(), nullable=False),
        sa.Column("reason", sa.String(255), nullable=False),
        sa.Column("actor_user_id", sa.Integer(), sa.ForeignKey("users.id")),
        sa.Column("actor_username", sa.String(50), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("quantity_change <> 0", name="ck_stock_adjustments_change"),
        sa.CheckConstraint("on_hand_after >= 0", name="ck_stock_adjustments_not_negative"),
        sa.CheckConstraint("on_hand_after = on_hand_before + quantity_change", name="ck_stock_adjustments_arithmetic"),
    )
    op.create_index("ix_stock_adjustments_resource_id", "stock_adjustments", ["resource_id", "id"])

    # ---- printer scheduling ----
    op.add_column("orders", sa.Column("planned_machine_id", sa.Integer(), sa.ForeignKey("machines.id", name="fk_orders_planned_machine")))
    op.add_column("orders", sa.Column("planned_start_at", sa.DateTime(timezone=True)))
    op.add_column("orders", sa.Column("estimated_duration_minutes", sa.Integer()))
    op.add_column("orders", sa.Column("planned_end_at", sa.DateTime(timezone=True)))
    op.add_column("orders", sa.Column("plan_active", sa.Boolean(), server_default=sa.text("true"), nullable=False))
    op.create_index("ix_orders_planned_start", "orders", ["planned_machine_id", "planned_start_at"])
    op.create_check_constraint(
        "ck_orders_plan_complete", "orders",
        "(planned_machine_id IS NULL AND planned_start_at IS NULL AND estimated_duration_minutes IS NULL "
        "AND planned_end_at IS NULL) OR (planned_machine_id IS NOT NULL AND planned_start_at IS NOT NULL "
        "AND estimated_duration_minutes IS NOT NULL AND planned_end_at IS NOT NULL)",
    )
    op.create_check_constraint(
        "ck_orders_plan_duration", "orders",
        "estimated_duration_minutes IS NULL OR estimated_duration_minutes BETWEEN 1 AND 10080",
    )
    op.create_check_constraint(
        "ck_orders_plan_end_matches", "orders",
        "planned_end_at IS NULL OR planned_end_at = planned_start_at + estimated_duration_minutes * interval '1 minute'",
    )
    op.execute(
        "ALTER TABLE orders ADD CONSTRAINT ex_orders_no_printer_overlap EXCLUDE USING gist "
        "(planned_machine_id WITH =, tstzrange(planned_start_at, planned_end_at) WITH &&) "
        "WHERE (planned_machine_id IS NOT NULL AND plan_active)"
    )

    # ---- history can only grow ----
    for statement in db_triggers.create_statements():
        op.execute(statement)


def downgrade() -> None:
    for statement in db_triggers.drop_statements():
        op.execute(statement)

    op.execute("ALTER TABLE orders DROP CONSTRAINT ex_orders_no_printer_overlap")
    op.drop_constraint("ck_orders_plan_end_matches", "orders")
    op.drop_constraint("ck_orders_plan_duration", "orders")
    op.drop_constraint("ck_orders_plan_complete", "orders")
    op.drop_index("ix_orders_planned_start", table_name="orders")
    op.drop_column("orders", "plan_active")
    op.drop_column("orders", "planned_end_at")
    op.drop_column("orders", "estimated_duration_minutes")
    op.drop_column("orders", "planned_start_at")
    op.drop_constraint("fk_orders_planned_machine", "orders", type_="foreignkey")
    op.drop_column("orders", "planned_machine_id")

    op.drop_index("ix_stock_adjustments_resource_id", table_name="stock_adjustments")
    op.drop_table("stock_adjustments")
    op.drop_constraint("ck_resources_min_stock", "resources")
    op.drop_column("resources", "updated_at")
    op.drop_column("resources", "created_at")
    op.drop_column("resources", "is_active")
    op.drop_column("resources", "min_stock")
    op.drop_column("resources", "category")

    op.drop_column("quality_inspections", "inspected_by")
    op.drop_column("order_status_history", "actor")

    op.drop_index("ix_audit_events_action_created", table_name="audit_events")
    op.drop_index("ix_audit_events_created_at", table_name="audit_events")
    op.drop_table("audit_events")
    op.drop_index("ix_websocket_tickets_expires_at", table_name="websocket_tickets")
    op.drop_table("websocket_tickets")
    op.drop_index("ix_user_sessions_expires_at", table_name="user_sessions")
    op.drop_index("ix_user_sessions_user_id", table_name="user_sessions")
    op.drop_table("user_sessions")
    op.drop_table("users")
