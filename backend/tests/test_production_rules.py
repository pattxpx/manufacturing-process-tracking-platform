import threading

from app.database import SessionLocal
from app.services.production import start_step
from tests.conftest import advance_to_qc, get_resource, make_order, run_step


def start(client, order_id, step, **body):
    return client.post(f"/api/orders/{order_id}/steps/{step}/start", json=body)


def complete(client, order_id, step, **body):
    return client.post(f"/api/orders/{order_id}/steps/{step}/complete", json=body)


def order_at_printing(client, **kwargs):
    order = make_order(client, **kwargs)
    run_step(client, order["id"], "design_review")
    return order


# ---- Production sequence ----

def test_cannot_skip_production_steps(client):
    order = make_order(client)
    response = start(client, order["id"], "printing")
    assert response.status_code == 409
    assert "Design Review" in response.json()["detail"]

    assert start(client, order["id"], "post_processing").status_code == 409
    assert complete(client, order["id"], "design_review").status_code == 409  # not started yet


def test_next_step_cannot_start_while_previous_is_running(client):
    order = make_order(client)
    assert start(client, order["id"], "design_review").status_code == 200
    assert start(client, order["id"], "printing").status_code == 409


def test_quality_inspection_is_not_started_on_the_board(client):
    order = make_order(client)
    advance_to_qc(client, order["id"])
    assert start(client, order["id"], "quality_inspection").status_code == 409


# ---- Printers ----

def test_busy_printer_cannot_accept_another_job(client):
    first = order_at_printing(client)
    second = order_at_printing(client)
    assert start(client, first["id"], "printing", machine_id=1).status_code == 200

    response = start(client, second["id"], "printing", machine_id=1)
    assert response.status_code == 409
    assert "busy" in response.json()["detail"].lower()


def test_no_printer_available_when_all_three_are_busy(client):
    orders = [order_at_printing(client) for _ in range(4)]
    for order in orders[:3]:
        assert start(client, order["id"], "printing").status_code == 200

    response = start(client, orders[3]["id"], "printing")
    assert response.status_code == 409
    assert "printer" in response.json()["detail"].lower()
    machines = client.get("/api/machines").json()
    assert [m["status"] for m in machines] == ["busy", "busy", "busy"]


def test_printer_becomes_idle_when_printing_completes(client):
    order = order_at_printing(client)
    start(client, order["id"], "printing")
    complete(client, order["id"], "printing")
    assert all(m["status"] == "idle" for m in client.get("/api/machines").json())


# ---- Materials ----

def test_insufficient_material_blocks_production_start(client):
    # 1000 x 120 g = 120,000 g, but only 20,000 g of titanium powder is in stock
    big = order_at_printing(client, product="Cranial Implant Plate", quantity=1000)
    response = start(client, big["id"], "printing")
    assert response.status_code == 409
    assert "Insufficient" in response.json()["detail"]
    assert get_resource(client, "Ti-6Al-4V Powder")["reserved"] == 0


def test_blocked_order_does_not_block_other_orders(client):
    blocked = order_at_printing(client, product="Cranial Implant Plate", quantity=1000)  # older
    ok = order_at_printing(client, product="Hearing Aid Shell", quantity=5)

    queue = {item["order"]["id"]: item for item in client.get("/api/production/queue").json()}
    assert queue[blocked["id"]]["can_start"] is False
    assert "Insufficient" in queue[blocked["id"]]["blocked_reasons"][0]
    assert queue[ok["id"]]["can_start"] is True

    assert start(client, ok["id"], "printing").status_code == 200


def test_material_is_reserved_on_start_and_consumed_on_completion(client):
    order = order_at_printing(client, product="Titanium Spinal Cage", quantity=10)  # 400 g
    start(client, order["id"], "printing")
    titanium = get_resource(client, "Ti-6Al-4V Powder")
    assert (titanium["on_hand"], titanium["reserved"], titanium["available"]) == (20000, 400, 19600)

    titanium_id = get_resource(client, "Ti-6Al-4V Powder")["id"]
    used = [{"resource_id": titanium_id, "actual_quantity": 390}]
    assert complete(client, order["id"], "printing", actual_usage=used).status_code == 200
    titanium = get_resource(client, "Ti-6Al-4V Powder")
    assert (titanium["on_hand"], titanium["reserved"], titanium["available"]) == (19610, 0, 19610)


def test_duplicate_completion_cannot_consume_material_twice(client):
    order = order_at_printing(client, product="Titanium Spinal Cage", quantity=10)
    start(client, order["id"], "printing")

    assert complete(client, order["id"], "printing").status_code == 200
    assert complete(client, order["id"], "printing").status_code == 409

    titanium = get_resource(client, "Ti-6Al-4V Powder")
    assert (titanium["on_hand"], titanium["reserved"]) == (19600, 0)
    usage = client.get("/api/resources/usage", params={"order_id": order["id"]}).json()["items"]
    assert len(usage) == 1
    assert usage[0]["status"] == "consumed"
    assert usage[0]["actual_quantity"] == 400


def test_actual_usage_cannot_exceed_reservation(client):
    order = order_at_printing(client, product="Titanium Spinal Cage", quantity=10)
    start(client, order["id"], "printing")
    titanium_id = get_resource(client, "Ti-6Al-4V Powder")["id"]
    too_much = [{"resource_id": titanium_id, "actual_quantity": 401}]
    assert complete(client, order["id"], "printing", actual_usage=too_much).status_code == 422


def test_starting_the_same_step_twice_is_rejected(client):
    order = order_at_printing(client)
    assert start(client, order["id"], "printing").status_code == 200
    assert start(client, order["id"], "printing").status_code == 409
    assert get_resource(client, "Ti-6Al-4V Powder")["reserved"] == 400


# ---- FIFO ----

def test_printing_queue_is_first_in_first_out(client):
    first = order_at_printing(client)
    second = order_at_printing(client)

    queue = client.get("/api/production/queue").json()
    printing = [item for item in queue if item["step"] == "printing"]
    assert [item["order"]["id"] for item in printing] == [first["id"], second["id"]]
    assert printing[1]["can_start"] is False
    assert first["order_number"] in printing[1]["blocked_reasons"][0]

    response = start(client, second["id"], "printing")
    assert response.status_code == 409
    assert start(client, first["id"], "printing").status_code == 200
    assert start(client, second["id"], "printing").status_code == 200


# ---- Concurrency ----

def test_concurrent_starts_never_double_allocate_a_printer(client):
    # Two orders race for the last idle printer. Exactly one may win.
    orders = [order_at_printing(client, product="Hearing Aid Shell", quantity=1) for _ in range(5)]
    for order in orders[:2]:
        assert start(client, order["id"], "printing").status_code == 200

    results = []

    def try_start(order_id):
        with SessionLocal() as db:
            try:
                start_step(db, order_id, "printing", machine_id=None)
                results.append("started")
            except Exception as error:
                db.rollback()
                results.append(type(error).__name__)

    threads = [threading.Thread(target=try_start, args=(o["id"],)) for o in orders[2:4]]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert results.count("started") == 1
    assert results.count("BusinessRuleError") == 1
    assert [m["status"] for m in client.get("/api/machines").json()] == ["busy"] * 3


def test_concurrent_starts_never_over_reserve_material(client):
    # Each order needs 12,000 g of the 20,000 g in stock, so only one can reserve.
    orders = [order_at_printing(client, product="Cranial Implant Plate", quantity=100) for _ in range(2)]
    results = []

    def try_start(order_id):
        with SessionLocal() as db:
            try:
                start_step(db, order_id, "printing", machine_id=None)
                results.append("started")
            except Exception as error:
                db.rollback()
                results.append(type(error).__name__)

    threads = [threading.Thread(target=try_start, args=(o["id"],)) for o in orders]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert results.count("started") == 1
    assert get_resource(client, "Ti-6Al-4V Powder")["reserved"] == 12000
