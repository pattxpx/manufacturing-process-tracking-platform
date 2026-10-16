"""Manual print scheduling: planned times are separate from actual ones and never bypass any production rule."""
import threading
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.auth.dependencies import Actor
from app.database import SessionLocal
from app.errors import BusinessRuleError
from app.schemas import ScheduleRequest
from app.services import scheduling
from tests.conftest import get_resource, make_order, run_step


def hours_from_now(hours: float) -> datetime:
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).replace(microsecond=0)


def plan(client, order_id, machine=1, start=None, minutes=60):
    start = start or hours_from_now(2)
    return client.put(f"/api/orders/{order_id}/schedule", json={
        "machine_id": machine, "planned_start_at": start.isoformat(), "estimated_duration_minutes": minutes,
    })


def at_printing(client, product="Hearing Aid Shell", quantity=1):
    order = make_order(client, product=product, quantity=quantity)
    run_step(client, order["id"], "design_review")
    return order


# ---- Creating a plan ----

def test_an_order_can_be_planned_and_the_plan_is_kept_in_utc(client):
    order = make_order(client)
    start = hours_from_now(3)
    response = plan(client, order["id"], machine=2, start=start, minutes=90)
    assert response.status_code == 200
    body = response.json()
    assert body["planned_machine_id"] == 2 and body["estimated_duration_minutes"] == 90
    assert body["schedule_state"] == "planned"
    assert datetime.fromisoformat(body["planned_start_at"]) == start
    assert datetime.fromisoformat(body["planned_end_at"]) - start == timedelta(minutes=90)  # end = start + duration
    assert body["planned_start_at"].endswith(("Z", "+00:00"))
    assert body["history"][0]["note"].startswith("Planned on Printer 2")


def test_a_plan_with_a_time_zone_offset_is_converted_to_the_same_instant(client):
    order = make_order(client)
    local = hours_from_now(5).astimezone(timezone(timedelta(hours=7)))
    body = plan(client, order["id"], start=local).json()
    assert datetime.fromisoformat(body["planned_start_at"]) == local


def test_invalid_plans_are_rejected(client):
    order = make_order(client)
    base = {"machine_id": 1, "planned_start_at": hours_from_now(2).isoformat(), "estimated_duration_minutes": 60}
    put = lambda **change: client.put(f"/api/orders/{order['id']}/schedule", json={**base, **change}).status_code  # noqa: E731
    assert put(planned_start_at="2030-01-01T09:00:00") == 422            # no time zone
    assert put(planned_start_at=(datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()) == 422  # in the past
    assert put(estimated_duration_minutes=0) == 422
    assert put(estimated_duration_minutes=10081) == 422
    assert put(estimated_duration_minutes="soon") == 422
    assert put(machine_id=99) == 404
    assert client.put("/api/orders/9999/schedule", json=base).status_code == 404
    assert client.put(f"/api/orders/{order['id']}/schedule", json={**base, "plan_active": False}).status_code == 422


# ---- One job at a time per printer ----

def test_overlapping_plans_on_one_printer_are_refused(client):
    first, second = make_order(client), make_order(client)
    assert plan(client, first["id"], start=hours_from_now(2), minutes=120).status_code == 200
    clash = plan(client, second["id"], start=hours_from_now(3), minutes=60)
    assert clash.status_code == 409 and first["order_number"] in clash.json()["detail"]
    assert plan(client, second["id"], machine=2, start=hours_from_now(3), minutes=60).status_code == 200  # another printer


def test_back_to_back_jobs_are_fine(client):
    first, second = make_order(client), make_order(client)
    start = hours_from_now(2)
    assert plan(client, first["id"], start=start, minutes=60).status_code == 200
    assert plan(client, second["id"], start=start + timedelta(minutes=60), minutes=60).status_code == 200
    third = make_order(client)
    assert plan(client, third["id"], start=start + timedelta(minutes=119), minutes=10).status_code == 409


def test_an_order_can_be_moved_over_its_own_old_slot_and_that_frees_the_slot(client):
    first, second = make_order(client), make_order(client)
    start = hours_from_now(2)
    plan(client, first["id"], start=start, minutes=60)
    assert plan(client, first["id"], start=start + timedelta(minutes=30), minutes=60).status_code == 200  # overlaps itself: fine
    assert plan(client, second["id"], start=start, minutes=20).status_code == 200  # the freed time at the start
    assert [h["note"][:11] for h in client.get(f"/api/orders/{first['id']}").json()["history"]][0] == "Rescheduled"


def test_clearing_a_plan_frees_the_printer(client):
    first, second = make_order(client), make_order(client)
    start = hours_from_now(2)
    plan(client, first["id"], start=start)
    assert plan(client, second["id"], start=start).status_code == 409
    cleared = client.delete(f"/api/orders/{first['id']}/schedule")
    assert cleared.status_code == 200 and cleared.json()["planned_start_at"] is None and cleared.json()["schedule_state"] is None
    assert plan(client, second["id"], start=start).status_code == 200
    assert client.delete(f"/api/orders/{first['id']}/schedule").status_code == 409  # nothing left to clear


# ---- Which orders may be planned ----

def test_only_orders_that_have_not_started_printing_can_be_planned(client):
    running = at_printing(client)
    client.post(f"/api/orders/{running['id']}/steps/printing/start", json={})
    assert plan(client, running["id"]).status_code == 409
    done = make_order(client)
    for step in ["design_review", "printing", "post_processing"]:
        run_step(client, done["id"], step)
    assert plan(client, done["id"]).status_code == 409
    waiting = at_printing(client)
    assert plan(client, waiting["id"], machine=3).status_code == 200  # waiting to print: yes
    assert client.delete(f"/api/orders/{running['id']}/schedule").status_code == 409


def test_released_orders_are_read_only(client):
    order = make_order(client)
    for step in ["design_review", "printing", "post_processing"]:
        run_step(client, order["id"], step)
    client.post(f"/api/orders/{order['id']}/inspections", json={"result": "pass"})
    client.post(f"/api/orders/{order['id']}/release")
    assert plan(client, order["id"]).status_code == 409


def test_an_order_whose_materials_cannot_exist_is_not_planned(client):
    huge = make_order(client, product="Cranial Implant Plate", quantity=1000)
    refused = plan(client, huge["id"])
    assert refused.status_code == 409 and "not enough" in refused.json()["detail"]
    client.patch("/api/resources/3", json={"is_active": False})  # the photopolymer resin
    resin_order = make_order(client, product="Hearing Aid Shell")
    assert "inactive" in plan(client, resin_order["id"]).json()["detail"]


# ---- Planning never changes the production rules ----

def test_planning_reserves_nothing_and_changes_no_stock(client):
    order = at_printing(client)
    before = {r["name"]: (r["on_hand"], r["reserved"]) for r in client.get("/api/resources").json()}
    plan(client, order["id"])
    assert {r["name"]: (r["on_hand"], r["reserved"]) for r in client.get("/api/resources").json()} == before
    assert all(m["status"] == "idle" for m in client.get("/api/machines").json())


def test_fifo_still_decides_who_may_start_whatever_the_plan_says(client):
    older, newer = at_printing(client), at_printing(client)
    plan(client, newer["id"], start=hours_from_now(1))   # planned EARLIER than the older order
    plan(client, older["id"], machine=2, start=hours_from_now(4))
    refused = client.post(f"/api/orders/{newer['id']}/steps/printing/start", json={})
    assert refused.status_code == 409 and older["order_number"] in refused.json()["detail"]
    assert client.post(f"/api/orders/{older['id']}/steps/printing/start", json={}).status_code == 200


def test_the_planned_printer_is_preferred_when_it_is_free(client):
    order = at_printing(client)
    plan(client, order["id"], machine=3)
    client.post(f"/api/orders/{order['id']}/steps/printing/start", json={})
    machines = {m["name"]: m for m in client.get("/api/machines").json()}
    assert machines["Printer 3"]["current_order_id"] == order["id"]


def test_a_busy_planned_printer_falls_back_to_a_free_one(client):
    blocker, order = at_printing(client), at_printing(client)
    client.post(f"/api/orders/{blocker['id']}/steps/printing/start", json={"machine_id": 3})
    plan(client, order["id"], machine=3)
    assert client.post(f"/api/orders/{order['id']}/steps/printing/start", json={}).status_code == 200
    machines = {m["name"]: m for m in client.get("/api/machines").json()}
    assert machines["Printer 3"]["current_order_id"] == blocker["id"] and machines["Printer 1"]["current_order_id"] == order["id"]


def test_planned_and_actual_times_are_separate_and_the_slot_is_freed_when_printing_is_done(client):
    order = at_printing(client)
    start = hours_from_now(5)
    plan(client, order["id"], machine=1, start=start, minutes=60)
    client.post(f"/api/orders/{order['id']}/steps/printing/start", json={})
    running = client.get(f"/api/orders/{order['id']}").json()
    assert running["schedule_state"] == "running"
    assert datetime.fromisoformat(running["planned_start_at"]) == start  # the plan is untouched by starting early
    printing = next(r for r in running["production_records"] if r["step"] == "printing")
    assert datetime.fromisoformat(printing["started_at"]) < start         # the ACTUAL start is its own value

    client.post(f"/api/orders/{order['id']}/steps/printing/complete", json={})
    finished = client.get(f"/api/orders/{order['id']}").json()
    assert finished["schedule_state"] == "completed" and datetime.fromisoformat(finished["planned_start_at"]) == start
    other = make_order(client)
    assert plan(client, other["id"], machine=1, start=start, minutes=60).status_code == 200  # the planned slot is free again


# ---- The schedule view ----

def test_schedule_view_lists_printers_jobs_and_unplanned_orders(client):
    planned, unplanned = make_order(client), make_order(client)
    plan(client, planned["id"], machine=2)
    data = client.get("/api/schedule").json()
    assert [p["name"] for p in data["printers"]] == ["Printer 1", "Printer 2", "Printer 3"]
    printer2 = data["printers"][1]
    assert printer2["jobs"][0]["order_number"] == planned["order_number"] and printer2["jobs"][0]["state"] == "planned"
    assert printer2["next_planned_order_number"] == planned["order_number"]
    assert [o["id"] for o in data["unscheduled"]] == [unplanned["id"]] and data["unscheduled_total"] == 1
    assert data["timezone"] and data["window_end"] > data["window_start"]


def test_schedule_window_is_validated(client):
    assert client.get("/api/schedule", params={"days": 0}).status_code == 422
    assert client.get("/api/schedule", params={"days": 15}).status_code == 422
    assert client.get("/api/schedule", params={"start": "2030-01-01T00:00:00"}).status_code == 422  # no time zone
    assert client.get("/api/schedule", params={"start": "2030-01-01T00:00:00Z", "days": 7}).status_code == 200


def test_late_jobs_are_shown_as_delayed(client, monkeypatch):
    waiting = make_order(client)
    plan(client, waiting["id"], start=hours_from_now(1))
    later = datetime.now(timezone.utc) + timedelta(hours=3)
    monkeypatch.setattr("app.models.utcnow", lambda: later)  # the clock moves past the planned start
    data = client.get("/api/schedule").json()
    job = data["printers"][0]["jobs"][0]
    assert job["state"] == "delayed" and any(waiting["order_number"] in alert for alert in data["alerts"])


# ---- Races and the database guarantee ----

def test_two_requests_for_the_same_slot_cannot_both_win(client):
    first, second = make_order(client), make_order(client)
    start = hours_from_now(2)
    actor = Actor(1, "admin1", "Test", "admin", 1, "")
    results = []
    barrier = threading.Barrier(2)

    def book(order_id):
        barrier.wait()
        with SessionLocal() as db:
            try:
                scheduling.set_schedule(db, order_id, ScheduleRequest(machine_id=1, planned_start_at=start, estimated_duration_minutes=60), actor)
                results.append("ok")
            except BusinessRuleError:
                results.append("conflict")

    threads = [threading.Thread(target=book, args=(o["id"],)) for o in (first, second)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sorted(results) == ["conflict", "ok"]


def test_the_database_itself_refuses_overlapping_plans(client):
    first, second = make_order(client), make_order(client)
    start = hours_from_now(2)
    plan(client, first["id"], start=start, minutes=60)
    plan(client, second["id"], start=start + timedelta(hours=3), minutes=60)
    with SessionLocal() as db, pytest.raises(IntegrityError):  # bypassing the service on purpose
        db.execute(text(
            "UPDATE orders SET planned_start_at = :s, planned_end_at = :s + interval '60 minutes' WHERE id = :id"
        ), {"s": start + timedelta(minutes=10), "id": second["id"]})
        db.commit()


def test_the_database_refuses_inconsistent_plans(client):
    order = make_order(client)
    with SessionLocal() as db, pytest.raises(IntegrityError):  # a printer but no times
        db.execute(text("UPDATE orders SET planned_machine_id = 1 WHERE id = :id"), {"id": order["id"]})
        db.commit()
    with SessionLocal() as db, pytest.raises(IntegrityError):  # an end that does not match start + duration
        db.execute(text(
            "UPDATE orders SET planned_machine_id=1, planned_start_at=now(), estimated_duration_minutes=60, "
            "planned_end_at = now() + interval '5 minutes' WHERE id = :id"), {"id": order["id"]})
        db.commit()


def test_scheduling_is_audited(client):
    order = make_order(client)
    plan(client, order["id"])
    plan(client, order["id"], machine=2)
    client.delete(f"/api/orders/{order['id']}/schedule")
    actions = [e["action"] for e in client.get("/api/audit-events", params={"page_size": 100}).json()["items"]]
    assert {"order_scheduled", "order_rescheduled", "order_schedule_cleared"} <= set(actions)
