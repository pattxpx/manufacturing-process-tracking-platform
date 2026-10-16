"""Creating and editing materials, deactivation, and the controlled stock-adjustment workflow."""
import threading

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.auth.dependencies import Actor
from app.database import SessionLocal
from app.errors import BusinessRuleError
from app.schemas import StockAdjustmentCreate
from app.services import resources
from tests.conftest import ADMIN_USERNAME, get_resource, make_order, run_step

NEW = {"name": "Ceramic Slurry", "category": "other", "unit": "ml", "min_stock": 500, "initial_stock": 2000}
TITANIUM = "Ti-6Al-4V Powder"


def create(client, **change):
    return client.post("/api/resources", json={**NEW, **change})


def adjust(client, resource_id, change, reason="stock count"):
    return client.post(f"/api/resources/{resource_id}/adjustments", json={"quantity_change": change, "reason": reason})


def waiting_to_print(client, product="Titanium Spinal Cage", quantity=10):
    order = make_order(client, product=product, quantity=quantity)
    run_step(client, order["id"], "design_review")
    return order


# ---- Creating ----

def test_a_material_is_created_with_its_opening_stock_in_the_history(client):
    response = create(client)
    assert response.status_code == 201
    material = response.json()
    assert (material["name"], material["unit"], material["on_hand"], material["reserved"], material["available"]) == ("Ceramic Slurry", "ml", 2000, 0, 2000)
    assert material["is_active"] is True and material["min_stock"] == 500 and material["low_stock"] is False

    history = client.get(f"/api/resources/{material['id']}/adjustments").json()["items"]
    assert len(history) == 1 and history[0]["quantity_change"] == 2000 and history[0]["reason"] == "Initial stock"
    assert history[0]["on_hand_before"] == 0 and history[0]["on_hand_after"] == 2000 and history[0]["actor_username"] == ADMIN_USERNAME


def test_a_material_can_start_with_no_stock_and_no_history(client):
    material = create(client, initial_stock=0).json()
    assert material["on_hand"] == 0
    assert client.get(f"/api/resources/{material['id']}/adjustments").json()["total"] == 0


def test_creating_validates_everything_on_the_server(client):
    assert create(client, name=TITANIUM).status_code == 409                  # duplicate
    assert create(client, name=TITANIUM.lower()).status_code == 409          # case-insensitive
    assert create(client, name="  ti-6al-4v   POWDER ").status_code == 409   # extra spaces
    assert create(client, name="   ").status_code == 422
    assert create(client, unit="furlongs").status_code == 422                # not a valid unit
    assert create(client, category="magic").status_code == 422
    assert create(client, min_stock=-1).status_code == 422
    assert create(client, initial_stock=-5).status_code == 422
    assert create(client, initial_stock=10**10).status_code == 422
    assert create(client, name="x" * 101).status_code == 422
    assert client.post("/api/resources", json={"name": "No unit"}).status_code == 422


# ---- Editing details only ----

def test_details_can_be_edited_but_quantities_cannot(client):
    material = create(client).json()
    updated = client.patch(f"/api/resources/{material['id']}", json={"name": "Ceramic Paste", "category": "resin", "min_stock": 100})
    assert updated.status_code == 200 and updated.json()["name"] == "Ceramic Paste" and updated.json()["on_hand"] == 2000
    for field in ["on_hand", "reserved", "available"]:
        assert client.patch(f"/api/resources/{material['id']}", json={field: 5}).status_code == 422
    assert get_resource(client, "Ceramic Paste")["on_hand"] == 2000


def test_names_stay_unique_and_catalog_materials_keep_their_name(client):
    material = create(client).json()
    assert client.patch(f"/api/resources/{material['id']}", json={"name": "argon gas"}).status_code == 409
    titanium = get_resource(client, TITANIUM)
    refused = client.patch(f"/api/resources/{titanium['id']}", json={"name": "Titanium Powder"})
    assert refused.status_code == 409 and "product definitions" in refused.json()["detail"]
    assert client.patch(f"/api/resources/{titanium['id']}", json={"name": TITANIUM, "min_stock": 1}).status_code == 200  # same name is fine


def test_the_unit_can_only_change_while_there_is_no_history(client):
    fresh = create(client, initial_stock=0).json()
    assert client.patch(f"/api/resources/{fresh['id']}", json={"unit": "L"}).status_code == 200
    stocked = create(client, name="Stocked", initial_stock=100).json()
    refused = client.patch(f"/api/resources/{stocked['id']}", json={"unit": "L"})
    assert refused.status_code == 409 and "unit" in refused.json()["detail"].lower()
    used = get_resource(client, TITANIUM)  # has usage after a job ran
    order = waiting_to_print(client)
    run_step(client, order["id"], "printing")
    assert client.patch(f"/api/resources/{used['id']}", json={"unit": "kg"}).status_code == 409
    assert get_resource(client, TITANIUM)["unit"] == "g"


def test_there_is_no_way_to_delete_a_material(client):
    assert client.delete("/api/resources/1").status_code == 405
    assert client.delete("/api/resources/1/adjustments").status_code == 405


def test_unknown_materials_are_404(client):
    assert client.patch("/api/resources/999", json={"min_stock": 1}).status_code == 404
    assert adjust(client, 999, 5).status_code == 404
    assert client.get("/api/resources/999/adjustments").status_code == 404


# ---- Deactivation ----

def test_an_inactive_material_cannot_be_used_and_can_be_switched_back_on(client):
    order = waiting_to_print(client)  # needs titanium
    titanium = get_resource(client, TITANIUM)
    assert client.patch(f"/api/resources/{titanium['id']}", json={"is_active": False}).status_code == 200

    refused = client.post(f"/api/orders/{order['id']}/steps/printing/start", json={})
    assert refused.status_code == 409 and "inactive" in refused.json()["detail"]
    queue_item = client.get("/api/production/queue").json()[0]
    assert queue_item["can_start"] is False and "inactive" in queue_item["blocked_reasons"][0]
    assert get_resource(client, TITANIUM)["reserved"] == 0

    client.patch(f"/api/resources/{titanium['id']}", json={"is_active": True})
    assert client.post(f"/api/orders/{order['id']}/steps/printing/start", json={}).status_code == 200


def test_a_material_that_is_reserved_cannot_be_deactivated(client):
    order = waiting_to_print(client)
    client.post(f"/api/orders/{order['id']}/steps/printing/start", json={})
    titanium = get_resource(client, TITANIUM)
    refused = client.patch(f"/api/resources/{titanium['id']}", json={"is_active": False})
    assert refused.status_code == 409 and "reserved" in refused.json()["detail"]
    client.post(f"/api/orders/{order['id']}/steps/printing/complete", json={})
    assert client.patch(f"/api/resources/{titanium['id']}", json={"is_active": False}).status_code == 200


# ---- Stock adjustments ----

def test_adding_and_removing_stock_records_who_what_and_why(client):
    titanium = get_resource(client, TITANIUM)
    added = adjust(client, titanium["id"], 500, "Delivery note 4711")
    assert added.status_code == 201
    row = added.json()
    assert (row["quantity_change"], row["on_hand_before"], row["on_hand_after"]) == (500, 20000, 20500)
    assert row["actor_username"] == ADMIN_USERNAME and row["reason"] == "Delivery note 4711" and row["created_at"]
    assert adjust(client, titanium["id"], -300, "Spilled during handling").status_code == 201
    assert get_resource(client, TITANIUM)["on_hand"] == 20200

    items = client.get(f"/api/resources/{titanium['id']}/adjustments").json()["items"]
    assert [i["quantity_change"] for i in items] == [-300, 500]  # newest first


def test_stock_adjustments_are_validated(client):
    assert adjust(client, 1, 0).status_code == 422
    assert adjust(client, 1, 5, reason="").status_code == 422
    assert adjust(client, 1, 5, reason="  a ").status_code == 422
    assert adjust(client, 1, 5, reason="x" * 256).status_code == 422
    assert adjust(client, 1, 10**10).status_code == 422
    assert adjust(client, 1, 1_000_000_000).status_code == 422       # would be above the maximum
    assert client.post("/api/resources/1/adjustments", json={"quantity_change": "lots", "reason": "abc"}).status_code == 422
    assert get_resource(client, TITANIUM)["on_hand"] == 20000


def test_available_stock_can_never_go_negative(client):
    titanium = get_resource(client, TITANIUM)
    order = waiting_to_print(client)                                  # 400 g
    client.post(f"/api/orders/{order['id']}/steps/printing/start", json={})   # reserves 400
    refused = adjust(client, titanium["id"], -19700, "too much")      # would leave 300 on hand but 400 reserved
    assert refused.status_code == 409 and "reserved" in refused.json()["detail"]
    assert adjust(client, titanium["id"], -19600, "all that is free").status_code == 201
    after = get_resource(client, TITANIUM)
    assert (after["on_hand"], after["reserved"], after["available"]) == (400, 400, 0)
    assert adjust(client, titanium["id"], -1, "one more").status_code == 409


def test_low_stock_is_flagged_from_the_minimum(client):
    titanium = get_resource(client, TITANIUM)
    client.patch(f"/api/resources/{titanium['id']}", json={"min_stock": 19000})
    assert get_resource(client, TITANIUM)["low_stock"] is False
    adjust(client, titanium["id"], -1500, "used elsewhere")
    assert get_resource(client, TITANIUM)["low_stock"] is True


def test_adjustment_history_is_paged_and_audited(client):
    for i in range(7):
        adjust(client, 2, i + 1, f"delivery {i}")
    page = client.get("/api/resources/2/adjustments", params={"page": 2, "page_size": 3}).json()
    assert (page["total"], page["total_pages"], len(page["items"])) == (7, 3, 3)
    events = client.get("/api/audit-events", params={"action": "stock_adjusted"}).json()
    assert events["total"] == 7 and events["items"][0]["target_type"] == "resource"


def test_adjustments_cannot_be_changed_afterwards(client):
    adjust(client, 1, 5)
    for statement in ["UPDATE stock_adjustments SET quantity_change = 500", "DELETE FROM stock_adjustments"]:
        with SessionLocal() as db, pytest.raises(Exception):
            db.execute(text(statement))
            db.commit()


def test_the_database_checks_the_adjustment_arithmetic(client):
    with SessionLocal() as db, pytest.raises(IntegrityError):
        db.execute(text(
            "INSERT INTO stock_adjustments (resource_id, quantity_change, on_hand_before, on_hand_after, reason, actor_username, created_at) "
            "VALUES (1, 5, 100, 999, 'cooked books', 'x', now())"))
        db.commit()


# ---- Races ----

def test_two_big_withdrawals_cannot_both_succeed(client):
    actor = Actor(1, ADMIN_USERNAME, "Test", "admin", 1, "")
    results = []
    barrier = threading.Barrier(2)

    def withdraw():
        barrier.wait()
        with SessionLocal() as db:
            try:
                resources.adjust_stock(db, 1, StockAdjustmentCreate(quantity_change=-15000, reason="race"), actor)
                results.append("ok")
            except BusinessRuleError:
                results.append("refused")

    threads = [threading.Thread(target=withdraw) for _ in range(2)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["ok", "refused"]
    assert get_resource(client, TITANIUM)["on_hand"] == 5000


def test_a_withdrawal_and_a_reservation_cannot_overdraw_the_stock(client):
    order = waiting_to_print(client, product="Cranial Implant Plate", quantity=100)  # needs 12000 g titanium
    actor = Actor(1, ADMIN_USERNAME, "Test", "admin", 1, "")
    results = []
    barrier = threading.Barrier(2)

    def withdraw():
        barrier.wait()
        with SessionLocal() as db:
            try:
                resources.adjust_stock(db, 1, StockAdjustmentCreate(quantity_change=-10000, reason="race"), actor)
                results.append("withdrawn")
            except BusinessRuleError:
                results.append("withdraw refused")

    def start():
        barrier.wait()
        client.post(f"/api/orders/{order['id']}/steps/printing/start", json={})

    threads = [threading.Thread(target=withdraw), threading.Thread(target=start)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    titanium = get_resource(client, TITANIUM)
    state = (titanium["on_hand"], titanium["reserved"])
    # Exactly two outcomes are possible, and both keep the stock whole:
    #  the job reserved first (so the withdrawal was refused), or the withdrawal came first (so the job was refused)
    assert state in {(20000, 12000), (10000, 0)}, state
    assert titanium["available"] >= 0
    assert (state == (20000, 12000)) == (results == ["withdraw refused"])


def test_existing_manufacturing_behaviour_is_unchanged_by_resource_management(client):
    order = waiting_to_print(client, product="Custom Surgical Guide", quantity=5)
    client.post(f"/api/orders/{order['id']}/steps/printing/start", json={})
    assert get_resource(client, "Medical Photopolymer Resin")["reserved"] == 300
    client.post(f"/api/orders/{order['id']}/steps/printing/complete", json={})
    assert get_resource(client, "Medical Photopolymer Resin")["on_hand"] == 9700
    assert client.post(f"/api/orders/{order['id']}/steps/printing/complete", json={}).status_code == 409  # still no double use
