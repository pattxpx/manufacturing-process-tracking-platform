"""Products that need several materials (Cranial Implant Plate: titanium + argon,
Custom Surgical Guide: resin + isopropyl alcohol)."""
import threading

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.database import SessionLocal
from app.errors import BusinessRuleError
from app.services.production import complete_step, start_step
from tests.conftest import get_resource, make_order, run_step

TITANIUM = "Ti-6Al-4V Powder"
ARGON = "Argon Gas"
RESIN = "Medical Photopolymer Resin"
ALCOHOL = "Isopropyl Alcohol"


def start(client, order_id, **body):
    return client.post(f"/api/orders/{order_id}/steps/printing/start", json=body)


def complete(client, order_id, **body):
    return client.post(f"/api/orders/{order_id}/steps/printing/complete", json=body)


def order_at_printing(client, product="Cranial Implant Plate", quantity=10):
    order = make_order(client, product=product, quantity=quantity)
    run_step(client, order["id"], "design_review")
    return order


def balances(client, *names):
    return {name: (get_resource(client, name)["on_hand"], get_resource(client, name)["reserved"]) for name in names}


def usage_rows(client, order_id):
    rows = client.get("/api/resources/usage", params={"order_id": order_id}).json()["items"]
    return {row["resource_name"]: row for row in rows}


def set_on_hand(name, amount):
    with SessionLocal() as db:
        db.execute(text("UPDATE resources SET on_hand = :amount WHERE name = :name"), {"amount": amount, "name": name})
        db.commit()


# ---- Catalog and requirements ----

def test_products_list_their_materials(client):
    products = {p["name"]: p for p in client.get("/api/products").json()}
    assert products["Cranial Implant Plate"]["materials"] == [
        {"name": TITANIUM, "unit": "g", "per_unit": 120},
        {"name": ARGON, "unit": "L", "per_unit": 12},
    ]
    assert len(products["Hearing Aid Shell"]["materials"]) == 1  # single-material products still exist


def test_order_and_queue_show_every_required_material(client):
    order = order_at_printing(client, quantity=10)
    expected = [
        {"name": TITANIUM, "quantity": 1200, "unit": "g", "available": 20000},
        {"name": ARGON, "quantity": 120, "unit": "L", "available": 6000},
    ]
    assert client.get(f"/api/orders/{order['id']}").json()["material_requirements"] == expected
    queue = client.get("/api/production/queue").json()
    assert queue[0]["material_requirements"] == expected


# ---- Reserving all materials, or none ----

def test_starting_reserves_every_material(client):
    order = order_at_printing(client, quantity=10)
    assert start(client, order["id"]).status_code == 200

    assert balances(client, TITANIUM, ARGON) == {TITANIUM: (20000, 1200), ARGON: (6000, 120)}
    rows = usage_rows(client, order["id"])
    assert {name: row["reserved_quantity"] for name, row in rows.items()} == {TITANIUM: 1200, ARGON: 120}
    assert all(row["status"] == "reserved" for row in rows.values())


def test_one_short_material_blocks_start_and_reserves_nothing(client):
    set_on_hand(ARGON, 50)  # titanium is fine, but 10 plates need 120 L of argon
    order = order_at_printing(client, quantity=10)

    response = start(client, order["id"])
    assert response.status_code == 409
    detail = response.json()["detail"]
    assert "Insufficient Argon Gas" in detail
    assert "Titanium" not in detail and "Ti-6Al-4V" not in detail

    assert balances(client, TITANIUM, ARGON) == {TITANIUM: (20000, 0), ARGON: (50, 0)}
    assert usage_rows(client, order["id"]) == {}
    assert all(m["status"] == "idle" for m in client.get("/api/machines").json())
    assert client.get(f"/api/orders/{order['id']}").json()["step_state"] == "waiting"


def test_every_insufficient_material_is_reported(client):
    # 1000 plates need 120,000 g of titanium (20,000 in stock) and 12,000 L of argon (6,000 in stock)
    order = order_at_printing(client, quantity=1000)

    detail = start(client, order["id"]).json()["detail"]
    assert "Insufficient Ti-6Al-4V Powder: needs 120000 g, only 20000 g available" in detail
    assert "Insufficient Argon Gas: needs 12000 L, only 6000 L available" in detail

    item = client.get("/api/production/queue").json()[0]
    assert item["can_start"] is False
    assert len(item["blocked_reasons"]) == 2


# ---- Actual consumption per material ----

def test_actual_usage_is_recorded_per_material_and_omitted_ones_default(client):
    order = order_at_printing(client, product="Custom Surgical Guide", quantity=5)  # 300 ml resin, 100 ml IPA
    start(client, order["id"])
    alcohol_id = get_resource(client, ALCOHOL)["id"]

    response = complete(client, order["id"], actual_usage=[{"resource_id": alcohol_id, "actual_quantity": 90}])
    assert response.status_code == 200

    # resin was left out, so the full reservation (300) is used; alcohol used only 90 of 100
    assert balances(client, RESIN, ALCOHOL) == {RESIN: (9700, 0), ALCOHOL: (11910, 0)}
    rows = usage_rows(client, order["id"])
    assert (rows[RESIN]["actual_quantity"], rows[RESIN]["status"]) == (300, "consumed")
    assert (rows[ALCOHOL]["reserved_quantity"], rows[ALCOHOL]["actual_quantity"]) == (100, 90)


def test_consumption_above_a_reservation_is_rejected_and_nothing_changes(client):
    order = order_at_printing(client, product="Custom Surgical Guide", quantity=5)
    start(client, order["id"])
    resin_id = get_resource(client, RESIN)["id"]
    alcohol_id = get_resource(client, ALCOHOL)["id"]

    response = complete(client, order["id"], actual_usage=[
        {"resource_id": resin_id, "actual_quantity": 250},     # fine
        {"resource_id": alcohol_id, "actual_quantity": 101},   # more than the 100 reserved
    ])
    assert response.status_code == 422
    assert "Isopropyl Alcohol" in response.json()["detail"]

    # All or nothing: the valid resin figure was not applied either
    assert balances(client, RESIN, ALCOHOL) == {RESIN: (10000, 300), ALCOHOL: (12000, 100)}
    assert client.get(f"/api/orders/{order['id']}").json()["step_state"] == "running"
    assert next(m for m in client.get("/api/machines").json() if m["current_order_id"] == order["id"])["status"] == "busy"

    # ...and a correct request still works afterwards
    assert complete(client, order["id"]).status_code == 200


def test_actual_usage_for_a_material_the_job_did_not_reserve_is_rejected(client):
    order = order_at_printing(client, product="Hearing Aid Shell", quantity=2)
    start(client, order["id"])
    argon_id = get_resource(client, ARGON)["id"]
    response = complete(client, order["id"], actual_usage=[{"resource_id": argon_id, "actual_quantity": 1}])
    assert response.status_code == 422


def test_the_same_material_twice_in_actual_usage_is_rejected(client):
    order = order_at_printing(client, quantity=2)
    start(client, order["id"])
    titanium_id = get_resource(client, TITANIUM)["id"]
    twice = [{"resource_id": titanium_id, "actual_quantity": 10}] * 2
    assert complete(client, order["id"], actual_usage=twice).status_code == 422


# ---- No double consumption ----

def test_duplicate_completion_consumes_each_material_once(client):
    order = order_at_printing(client, quantity=10)
    start(client, order["id"])

    assert complete(client, order["id"]).status_code == 200
    assert complete(client, order["id"]).status_code == 409

    assert balances(client, TITANIUM, ARGON) == {TITANIUM: (18800, 0), ARGON: (5880, 0)}
    rows = usage_rows(client, order["id"])
    assert len(rows) == 2 and all(row["status"] == "consumed" for row in rows.values())


def run_in_threads(functions):
    results = []
    barrier = threading.Barrier(len(functions))

    def wrap(function):
        barrier.wait()  # release all threads at the same moment
        try:
            function()
            results.append("ok")
        except BusinessRuleError:
            results.append("rule")
        except Exception as error:  # e.g. a database deadlock would show up here
            results.append(f"UNEXPECTED {type(error).__name__}: {error}")

    threads = [threading.Thread(target=wrap, args=(f,)) for f in functions]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    return results


def test_concurrent_duplicate_completion_consumes_once(client):
    order = order_at_printing(client, quantity=10)
    start(client, order["id"])

    def finish():
        with SessionLocal() as db:
            complete_step(db, order["id"], "printing", actual_usage=None)

    results = run_in_threads([finish, finish, finish])
    assert sorted(results) == ["ok", "rule", "rule"]
    assert balances(client, TITANIUM, ARGON) == {TITANIUM: (18800, 0), ARGON: (5880, 0)}
    assert len(client.get("/api/resources/usage", params={"order_id": order["id"]}).json()["items"]) == 2


def test_concurrent_starts_and_completions_do_not_deadlock_or_corrupt_stock(client):
    # Three jobs are printing; two more are waiting. Complete and start them all at once.
    running = [order_at_printing(client, quantity=5 + i) for i in range(3)]
    for order in running:
        assert start(client, order["id"]).status_code == 200
    waiting = [order_at_printing(client, quantity=4 + i) for i in range(2)]

    def finish(order_id):
        def call():
            with SessionLocal() as db:
                complete_step(db, order_id, "printing", actual_usage=None)
        return call

    def begin(order_id):
        def call():
            with SessionLocal() as db:
                start_step(db, order_id, "printing", machine_id=None)
        return call

    functions = [finish(o["id"]) for o in running] + [begin(o["id"]) for o in waiting]
    results = run_in_threads(functions)
    assert not [r for r in results if r.startswith("UNEXPECTED")], results
    assert results.count("ok") >= 3  # at least the three completions

    # Stock is consistent: reserved = open reservations, on hand = initial - consumed
    with SessionLocal() as db:
        for name, initial in [(TITANIUM, 20000), (ARGON, 6000)]:
            on_hand, reserved = db.execute(
                text("SELECT on_hand, reserved FROM resources WHERE name = :n"), {"n": name}
            ).one()
            open_reservations, consumed = db.execute(text(
                "SELECT COALESCE(SUM(CASE WHEN u.status = 'reserved' THEN u.reserved_quantity END), 0), "
                "COALESCE(SUM(u.actual_quantity), 0) FROM resource_usage u "
                "JOIN resources r ON r.id = u.resource_id WHERE r.name = :n"
            ), {"n": name}).one()
            assert reserved == open_reservations
            assert on_hand == initial - consumed


# ---- Database-level safety nets ----

def test_database_rejects_usage_above_reservation_and_duplicate_material_rows(client):
    order = order_at_printing(client, quantity=1)
    start(client, order["id"])
    with SessionLocal() as db:
        with pytest.raises(IntegrityError):
            db.execute(text("UPDATE resource_usage SET actual_quantity = reserved_quantity + 1"))
        db.rollback()
        with pytest.raises(IntegrityError):  # same job + same material again
            db.execute(text(
                "INSERT INTO resource_usage (order_id, resource_id, production_record_id, reserved_quantity, status, created_at) "
                "SELECT order_id, resource_id, production_record_id, 1, 'reserved', now() FROM resource_usage LIMIT 1"
            ))
        db.rollback()
