"""Alembic is the only thing that creates the schema. The seed must refuse to run on a database that has not been
migrated (and must not create tables itself), because tables created any other way miss the migrations' triggers
and the alembic_version table."""
import os
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import create_engine, text

from app.database import engine

BACKEND = Path(__file__).resolve().parents[1]
APPEND_ONLY = {"audit_events", "stock_adjustments", "quality_inspections", "order_status_history"}


def run(database_url: str, *args: str) -> subprocess.CompletedProcess:
    environment = {**os.environ, "DATABASE_URL": database_url, "ENVIRONMENT": "test"}
    return subprocess.run([sys.executable, *args], cwd=BACKEND, env=environment, capture_output=True, text=True, timeout=120)


@pytest.fixture()
def scratch_database():
    """An empty database with btree_gist already installed: the situation in which the old seed script silently built an unmigrated schema."""
    name = f"{engine.url.database}_seedcheck"
    admin = create_engine(engine.url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
        connection.execute(text(f'CREATE DATABASE "{name}"'))
    scratch_url = engine.url.set(database=name)
    scratch = create_engine(scratch_url, isolation_level="AUTOCOMMIT")
    with scratch.connect() as connection:
        connection.execute(text("CREATE EXTENSION btree_gist"))
    yield scratch_url.render_as_string(hide_password=False), scratch
    scratch.dispose()
    with admin.connect() as connection:
        connection.execute(text(f'DROP DATABASE IF EXISTS "{name}" WITH (FORCE)'))
    admin.dispose()


def table_names(scratch) -> set[str]:
    with scratch.connect() as connection:
        return {row[0] for row in connection.execute(text("SELECT tablename FROM pg_tables WHERE schemaname = 'public'"))}


def trigger_tables(scratch) -> set[str]:
    with scratch.connect() as connection:
        rows = connection.execute(text("SELECT tgrelid::regclass::text FROM pg_trigger WHERE tgname LIKE '%_append_only'"))
        return {row[0] for row in rows}


def test_seeding_an_unmigrated_database_is_refused_and_creates_nothing(scratch_database):
    url, scratch = scratch_database
    result = run(url, "-m", "app.seed", "--empty", "--yes")
    assert result.returncode != 0
    assert "alembic upgrade head" in result.stderr
    assert table_names(scratch) == set()  # no tables, so no half-built schema to trip over later


def test_migrate_then_seed_gives_a_complete_schema(scratch_database):
    url, scratch = scratch_database
    assert run(url, "-m", "alembic", "upgrade", "head").returncode == 0
    seeded = run(url, "-m", "app.seed", "--empty", "--yes")
    assert seeded.returncode == 0, seeded.stderr

    assert "alembic_version" in table_names(scratch)
    assert trigger_tables(scratch) == APPEND_ONLY  # the append-only triggers are there
    with scratch.connect() as connection:
        assert connection.execute(text("SELECT count(*) FROM machines")).scalar_one() == 3
        assert connection.execute(text("SELECT count(*) FROM users")).scalar_one() == 0  # the seed never creates accounts


def test_seeding_a_database_that_is_behind_the_latest_migration_is_refused(scratch_database):
    url, scratch = scratch_database
    assert run(url, "-m", "alembic", "upgrade", "head").returncode == 0
    assert run(url, "-m", "alembic", "downgrade", "-1").returncode == 0
    result = run(url, "-m", "app.seed", "--empty", "--yes")
    assert result.returncode != 0
    assert "0002_multi_material" in result.stderr and "0003_auth_scheduling" in result.stderr
    with scratch.connect() as connection:  # and it did not touch the data
        assert connection.execute(text("SELECT count(*) FROM machines")).scalar_one() == 0


# ---- The seed deletes data, so it needs an explicit yes ----

def count(scratch, sql: str) -> int:
    with scratch.connect() as connection:
        return connection.execute(text(sql)).scalar_one()


@pytest.fixture()
def seeded_database(scratch_database):
    """A migrated scratch database that holds data worth losing (a marker material plus the seeded printers)."""
    url, scratch = scratch_database
    assert run(url, "-m", "alembic", "upgrade", "head").returncode == 0
    assert run(url, "-m", "app.seed", "--empty", "--yes").returncode == 0
    with scratch.connect() as connection:
        connection.execute(text("INSERT INTO resources (name, unit, on_hand, reserved) VALUES ('Marker material', 'g', 5, 0)"))
    return url, scratch


def run_in_terminal(url: str, typed: str) -> tuple[int, str]:
    """Run the seed in a real (pseudo) terminal and type an answer at its prompt."""
    import pty
    import time
    environment = {**os.environ, "DATABASE_URL": url, "ENVIRONMENT": "test"}
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(BACKEND)
        os.execve(sys.executable, [sys.executable, "-m", "app.seed", "--empty"], environment)
    output = b""
    answered = False
    while True:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            break
        if not chunk:
            break
        output += chunk
        if b"to continue:" in output and not answered:
            time.sleep(0.1)
            os.write(fd, typed.encode() + b"\n")
            answered = True
    _, status = os.waitpid(pid, 0)
    return os.waitstatus_to_exitcode(status), output.decode(errors="replace")


def test_without_a_terminal_and_without_yes_nothing_is_deleted(seeded_database):
    url, scratch = seeded_database
    result = run(url, "-m", "app.seed", "--empty")  # no terminal to ask on, no --yes
    assert result.returncode != 0
    assert "Nothing was deleted" in result.stderr and "--yes" in result.stderr
    assert "This will DELETE" in result.stdout  # it said what it was about to do
    assert count(scratch, "SELECT count(*) FROM resources WHERE name = 'Marker material'") == 1


def test_typing_the_wrong_database_name_cancels(seeded_database):
    url, scratch = seeded_database
    code, output = run_in_terminal(url, "not-the-name")
    assert code != 0 and "Cancelled" in output
    assert count(scratch, "SELECT count(*) FROM resources WHERE name = 'Marker material'") == 1


def test_typing_the_database_name_confirms_and_then_deletes(seeded_database):
    url, scratch = seeded_database
    code, output = run_in_terminal(url, scratch.url.database)
    assert code == 0, output
    assert "This will DELETE" in output and "6 materials" in output  # it listed what it would delete: 5 seeded + the marker
    assert count(scratch, "SELECT count(*) FROM resources WHERE name = 'Marker material'") == 0  # the data really was replaced
    assert count(scratch, "SELECT count(*) FROM machines") == 3


def test_yes_confirms_in_advance_and_keeps_accounts(seeded_database):
    url, scratch = seeded_database
    with scratch.connect() as connection:
        connection.execute(text(
            "INSERT INTO users (username, full_name, password_hash, role, is_active, created_at, updated_at, password_changed_at) "
            "VALUES ('keeper', 'Keeper', 'x', 'admin', true, now(), now(), now())"))
    assert run(url, "-m", "app.seed", "--empty", "--yes").returncode == 0
    assert count(scratch, "SELECT count(*) FROM users WHERE username = 'keeper'") == 1  # accounts are never deleted


def test_the_seed_refuses_to_run_in_production_even_with_yes(seeded_database):
    url, scratch = seeded_database
    environment = {**os.environ, "DATABASE_URL": url, "ENVIRONMENT": "production"}
    result = subprocess.run([sys.executable, "-m", "app.seed", "--empty", "--yes"], cwd=BACKEND, env=environment,
                            capture_output=True, text=True, timeout=120)
    assert result.returncode != 0 and "ENVIRONMENT=production" in result.stderr
    assert count(scratch, "SELECT count(*) FROM resources WHERE name = 'Marker material'") == 1


def test_the_seed_refuses_a_database_on_another_computer_even_with_yes():
    # Nothing is contacted: the host is refused before any connection is made
    result = run("postgresql://someone@db.example.invalid:5432/railway", "-m", "app.seed", "--empty", "--yes")
    assert result.returncode != 0 and "not on this computer" in result.stderr and "db.example.invalid" in result.stderr
