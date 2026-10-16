from tests.conftest import advance_to_qc, make_order, run_step


def inspect(client, order_id, result, notes=""):
    return client.post(f"/api/orders/{order_id}/inspections", json={"result": result, "notes": notes})


def release(client, order_id):
    return client.post(f"/api/orders/{order_id}/release")


def test_release_is_blocked_until_all_steps_are_complete(client):
    order = make_order(client)
    response = release(client, order["id"])
    assert response.status_code == 409
    assert "Design Review" in response.json()["detail"]

    run_step(client, order["id"], "design_review")
    run_step(client, order["id"], "printing")
    assert release(client, order["id"]).status_code == 409  # post-processing and QC still open


def test_inspection_is_only_possible_after_post_processing(client):
    order = make_order(client)
    assert inspect(client, order["id"], "pass").status_code == 409


def test_failed_qc_blocks_release(client):
    order = make_order(client)
    advance_to_qc(client, order["id"])
    assert inspect(client, order["id"], "fail", "Surface porosity").status_code == 201

    response = release(client, order["id"])
    assert response.status_code == 409
    assert "failed" in response.json()["detail"].lower()
    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["status"] == "qc_failed"
    assert detail["release_blockers"]


def test_passing_qc_after_all_steps_allows_release(client):
    order = make_order(client)
    advance_to_qc(client, order["id"])
    assert client.get(f"/api/orders/{order['id']}").json()["status"] == "awaiting_qc"
    assert inspect(client, order["id"], "pass", "All dimensions in tolerance").status_code == 201

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["status"] == "ready_for_release"
    assert detail["release_blockers"] == []

    response = release(client, order["id"])
    assert response.status_code == 200
    assert response.json()["status"] == "released"


def test_failed_order_can_be_reinspected_and_old_records_are_kept(client):
    order = make_order(client)
    advance_to_qc(client, order["id"])
    inspect(client, order["id"], "fail", "Surface porosity")
    inspect(client, order["id"], "pass", "Re-polished, now fine")

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert [i["result"] for i in detail["inspections"]] == ["pass", "fail"]  # newest first
    assert detail["inspections"][1]["notes"] == "Surface porosity"
    assert release(client, order["id"]).status_code == 200


def test_failed_inspection_requires_notes(client):
    order = make_order(client)
    advance_to_qc(client, order["id"])
    assert inspect(client, order["id"], "fail", "").status_code == 422


def test_released_order_is_read_only(client):
    order = make_order(client)
    advance_to_qc(client, order["id"])
    inspect(client, order["id"], "pass")
    release(client, order["id"])

    assert client.patch(f"/api/orders/{order['id']}", json={"notes": "x"}).status_code == 409
    assert inspect(client, order["id"], "fail", "late").status_code == 409
    assert release(client, order["id"]).status_code == 409
    assert client.post(f"/api/orders/{order['id']}/steps/design_review/start", json={}).status_code == 409


def test_pending_inspection_list(client):
    waiting = make_order(client)
    advance_to_qc(client, waiting["id"])
    make_order(client)  # still at design review

    pending = client.get("/api/inspections/pending").json()["items"]
    assert [o["id"] for o in pending] == [waiting["id"]]
