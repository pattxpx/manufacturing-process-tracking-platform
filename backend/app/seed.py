"""Seed data. Run:  python -m app.seed            (demo data)
                   python -m app.seed --empty    (printers and materials only, no orders)
                   add --yes to SKIP the typed confirmation (for scripts and tests only)

THIS DELETES DATA: orders, printers, materials and everything that belongs to them (accounts and the audit trail are kept).
So it shows what it is about to delete and asks you to type the database name first, and it refuses to run at all when
ENVIRONMENT=production or when the database is not on this computer (unless --allow-remote). It never creates the tables: that is Alembic's job (alembic upgrade head), and it refuses to
run on a database that is not at the latest migration."""
import argparse
import sys
from pathlib import Path

from alembic.config import Config
from alembic.runtime.migration import MigrationContext
from alembic.script import ScriptDirectory
from sqlalchemy import text
from sqlalchemy.orm import Session

from app import config
from app.catalog import MATERIALS
from app.database import SessionLocal, engine
from app.models import Machine, Resource
from app.schemas import InspectionCreate, OrderCreate
from app.services import orders as order_service
from app.services import production, quality


def seed_reference_data(db: Session):
    for number in (1, 2, 3):
        db.add(Machine(name=f"Printer {number}", status="idle"))
    for name, info in MATERIALS.items():
        db.add(Resource(name=name, unit=info["unit"], on_hand=info["stock"], reserved=0,
                        category=info["category"], min_stock=info["min_stock"]))
    db.commit()


def new_order(db, number, product, quantity, design_reference, notes=None):
    return order_service.create_order(db, OrderCreate(
        order_number=number, product=product, quantity=quantity,
        design_reference=design_reference, notes=notes,
    )).id


def run(db, order_id, *steps):
    """Start and complete the given steps in order."""
    for step in steps:
        production.start_step(db, order_id, step, machine_id=None)
        production.complete_step(db, order_id, step, actual_usage=None)


def seed_demo_orders(db: Session):
    # Released
    a = new_order(db, "ORD-1001", "Titanium Spinal Cage", 20, "DR-SC-210-A")
    run(db, a, "design_review", "printing", "post_processing")
    quality.record_inspection(db, a, InspectionCreate(result="pass", notes="All dimensions in tolerance"))
    quality.release_order(db, a)

    # QC failed (then waits for re-inspection)
    b = new_order(db, "ORD-1002", "Custom Surgical Guide", 12, "DR-SG-045-C")
    run(db, b, "design_review", "printing", "post_processing")
    quality.record_inspection(db, b, InspectionCreate(result="fail", notes="Layer delamination on edge"))

    # Awaiting QC
    c = new_order(db, "ORD-1003", "Orthopedic Knee Insert", 8, "DR-KI-118-B")
    run(db, c, "design_review", "printing", "post_processing")

    # Passed QC, ready to release
    d = new_order(db, "ORD-1004", "Hearing Aid Shell", 40, "DR-HA-002-D")
    run(db, d, "design_review", "printing", "post_processing")
    quality.record_inspection(db, d, InspectionCreate(result="pass", notes="Fit check OK"))

    # Currently post-processing
    e = new_order(db, "ORD-1005", "Titanium Spinal Cage", 15, "DR-SC-210-B")
    run(db, e, "design_review", "printing")
    production.start_step(db, e, "post_processing", machine_id=None)

    # Currently printing (two printers busy)
    f = new_order(db, "ORD-1006", "Cranial Implant Plate", 30, "DR-CP-077-A")
    run(db, f, "design_review")
    production.start_step(db, f, "printing", machine_id=None)
    g = new_order(db, "ORD-1007", "Hearing Aid Shell", 25, "DR-HA-003-A")
    run(db, g, "design_review")
    production.start_step(db, g, "printing", machine_id=None)

    # Waiting to print (FIFO queue). ORD-1009 needs more titanium powder AND argon than is in stock.
    h = new_order(db, "ORD-1008", "Titanium Spinal Cage", 10, "DR-SC-211-A")
    run(db, h, "design_review")
    i = new_order(db, "ORD-1009", "Cranial Implant Plate", 600, "DR-CP-078-A",
                  "Large batch for hospital group, needs titanium and argon restock")
    run(db, i, "design_review")
    j = new_order(db, "ORD-1010", "Custom Surgical Guide", 6, "DR-SG-046-A")
    run(db, j, "design_review")

    # Design review running / not started
    k = new_order(db, "ORD-1011", "Orthopedic Knee Insert", 5, "DR-KI-119-A")
    production.start_step(db, k, "design_review", machine_id=None)
    new_order(db, "ORD-1012", "Hearing Aid Shell", 60, "DR-HA-004-A")


def reset_database(db: Session):
    db.execute(text(
        "TRUNCATE order_status_history, quality_inspections, resource_usage, production_records, "
        "stock_adjustments, orders, machines, resources RESTART IDENTITY CASCADE"
    ))
    db.commit()


def ensure_migrated() -> None:
    """Exit with a clear message unless the database is at the latest Alembic revision.
    (Creating the tables here instead would leave out the migrations' triggers and the alembic_version table.)"""
    script = ScriptDirectory.from_config(Config(str(Path(__file__).resolve().parents[1] / "alembic.ini")))
    with engine.connect() as connection:
        current = MigrationContext.configure(connection).get_current_revision()
    head = script.get_current_head()
    if current != head:
        sys.exit(
            f"The database is at revision {current or 'none (no tables)'}, but the latest is {head}.\n"
            "Run 'alembic upgrade head' first (from the backend folder), then run the seed again."
        )


def confirm_deletion(assume_yes: bool) -> None:
    """Show what is about to be deleted and get an explicit yes (the database name, typed). Exits otherwise."""
    with engine.connect() as connection:
        counts = {
            name: connection.execute(text(f"SELECT count(*) FROM {table}")).scalar_one()
            for name, table in [("orders", "orders"), ("printers", "machines"), ("materials", "resources"),
                                ("stock adjustments", "stock_adjustments")]
        }
    database = engine.url.database
    where = f"database '{database}' on {engine.url.host or 'the local socket'}"
    print(f"This will DELETE {', '.join(f'{n} {name}' for name, n in counts.items())} from {where}")
    print("and everything that belongs to them (history, inspections, usage). Accounts and the audit trail are kept.")
    if assume_yes:
        return
    if not sys.stdin.isatty():
        sys.exit("No terminal to confirm on. Nothing was deleted. Run it in a terminal, or add --yes if you are sure.")
    if input(f"Type the database name ({database}) to continue: ").strip() != database:
        sys.exit("Cancelled. Nothing was deleted.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(prog="python -m app.seed", description="Delete orders, printers and materials and load demo data.")
    parser.add_argument("--empty", action="store_true", help="load only the printers and materials, no demo orders")
    parser.add_argument("--yes", action="store_true",
                        help="SKIP the typed confirmation (deletes at once; still refused in production and on remote databases)")
    parser.add_argument("--allow-remote", action="store_true",
                        help="allow a database that is not on this computer (never use on real data)")
    arguments = parser.parse_args()

    if config.IS_PRODUCTION:
        sys.exit("Refusing to seed: ENVIRONMENT=production. The seed deletes data and is for demo and test databases only.")
    if engine.url.host not in (None, "localhost", "127.0.0.1", "::1") and not (engine.url.host or "").startswith("/") \
            and not arguments.allow_remote:
        sys.exit(f"Refusing to seed: the database is on '{engine.url.host}', not on this computer. If this really is a "
                 "disposable demo database, add --allow-remote. Nothing was deleted.")
    ensure_migrated()
    if arguments.yes:
        print("--yes: skipping the typed confirmation.")
    confirm_deletion(arguments.yes)
    with SessionLocal() as session:
        reset_database(session)
        seed_reference_data(session)
        if not arguments.empty:
            seed_demo_orders(session)
    print("Seeded:", "printers and materials only" if arguments.empty else "demo data")
