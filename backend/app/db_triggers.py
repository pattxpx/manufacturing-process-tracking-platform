"""Database triggers that make history tables append-only.

Rows in these tables can be added but never changed or deleted, not even by a bug or by someone who
reaches the database through the application's account. (TRUNCATE is deliberately not blocked, so the
seed script and the tests can reset a database.)
Used by the Alembic migration and by the test setup, so both create exactly the same triggers.
"""

APPEND_ONLY_TABLES = ["audit_events", "stock_adjustments", "quality_inspections", "order_status_history"]

CREATE_FUNCTION = """
CREATE OR REPLACE FUNCTION forbid_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'table % is append-only: rows cannot be changed or deleted', TG_TABLE_NAME
        USING ERRCODE = '42501';
END;
$$ LANGUAGE plpgsql;
"""


def create_statements() -> list[str]:
    statements = [CREATE_FUNCTION]
    for table in APPEND_ONLY_TABLES:
        statements.append(f"DROP TRIGGER IF EXISTS {table}_append_only ON {table}")
        statements.append(
            f"CREATE TRIGGER {table}_append_only BEFORE UPDATE OR DELETE ON {table} "
            "FOR EACH ROW EXECUTE FUNCTION forbid_change()"
        )
    return statements


def drop_statements() -> list[str]:
    statements = [f"DROP TRIGGER IF EXISTS {table}_append_only ON {table}" for table in APPEND_ONLY_TABLES]
    statements.append("DROP FUNCTION IF EXISTS forbid_change()")
    return statements
