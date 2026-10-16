"""multi-material printing jobs

A printing job can now reserve several materials, so resource_usage may hold several rows per job
(one per material). Also adds the two new demo materials, so existing databases can print the
multi-material products.

Revision ID: 0002_multi_material
Revises: e46a7cf043ca
"""
from alembic import op

revision = "0002_multi_material"
down_revision = "e46a7cf043ca"
branch_labels = None
depends_on = None

NEW_MATERIALS = [("Argon Gas", "L", 6000), ("Isopropyl Alcohol", "ml", 12000)]


def upgrade() -> None:
    # Was: one usage row per job. Now: one row per job AND material.
    op.drop_constraint("resource_usage_production_record_id_key", "resource_usage", type_="unique")
    op.create_unique_constraint(
        "uq_resource_usage_job_material", "resource_usage", ["production_record_id", "resource_id"]
    )
    op.create_check_constraint(
        "ck_resource_usage_actual_within_reserved", "resource_usage",
        "actual_quantity IS NULL OR actual_quantity <= reserved_quantity",
    )
    for name, unit, stock in NEW_MATERIALS:
        op.execute(
            f"INSERT INTO resources (name, unit, on_hand, reserved) VALUES ('{name}', '{unit}', {stock}, 0) "
            "ON CONFLICT (name) DO NOTHING"
        )


def downgrade() -> None:
    names = ", ".join(f"'{name}'" for name, _, _ in NEW_MATERIALS)
    # Only remove the new materials if nothing has used them. Otherwise the downgrade stops here.
    op.execute(f"DELETE FROM resources WHERE name IN ({names})")
    op.drop_constraint("ck_resource_usage_actual_within_reserved", "resource_usage", type_="check")
    op.drop_constraint("uq_resource_usage_job_material", "resource_usage", type_="unique")
    # Fails if any job has several usage rows (multi-material data). Remove or merge them first.
    op.create_unique_constraint("resource_usage_production_record_id_key", "resource_usage", ["production_record_id"])
