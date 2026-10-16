from tests.conftest import make_order


def test_create_and_get_order(client):
    order = make_order(client, quantity=25)
    assert order["order_number"].startswith("ORD-")
    assert order["status"] == "new"
    assert order["current_step"] == "design_review"

    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["quantity"] == 25
    assert detail["history"][0]["note"] == "Order created"
    assert detail["material_requirements"] == [
        {"name": "Ti-6Al-4V Powder", "quantity": 1000, "unit": "g", "available": 20000}
    ]


def test_order_number_must_be_unique(client):
    make_order(client, order_number="ORD-9001")
    response = client.post(
        "/api/orders",
        json={"order_number": "ORD-9001", "product": "Hearing Aid Shell", "quantity": 1, "design_reference": "D"},
    )
    assert response.status_code == 409


def test_create_validates_input(client):
    base = {"product": "Hearing Aid Shell", "quantity": 1, "design_reference": "DR-1"}
    assert client.post("/api/orders", json={**base, "quantity": 0}).status_code == 422
    assert client.post("/api/orders", json={**base, "product": "Not a product"}).status_code == 422
    assert client.post("/api/orders", json={**base, "design_reference": " "}).status_code == 422


def test_order_can_be_edited_before_production_starts(client):
    order = make_order(client)
    response = client.patch(
        f"/api/orders/{order['id']}", json={"quantity": 99, "design_reference": "DR-NEW"}
    )
    assert response.status_code == 200
    assert response.json()["quantity"] == 99


def test_production_fields_are_locked_after_production_starts(client):
    order = make_order(client)
    client.post(f"/api/orders/{order['id']}/steps/design_review/start", json={})

    assert client.patch(f"/api/orders/{order['id']}", json={"quantity": 5}).status_code == 409
    assert client.patch(f"/api/orders/{order['id']}", json={"product": "Hearing Aid Shell"}).status_code == 409
    # notes are not production-critical
    assert client.patch(f"/api/orders/{order['id']}", json={"notes": "Customer called"}).status_code == 200


def test_orders_cannot_be_deleted(client):
    order = make_order(client)
    assert client.delete(f"/api/orders/{order['id']}").status_code == 405


def test_search_and_filter(client):
    make_order(client, product="Hearing Aid Shell", order_number="ORD-5001")
    make_order(client, product="Custom Surgical Guide", order_number="ORD-5002")
    assert len(client.get("/api/orders", params={"search": "hearing"}).json()["items"]) == 1
    assert len(client.get("/api/orders", params={"search": "5002"}).json()["items"]) == 1
    assert len(client.get("/api/orders", params={"status": "new"}).json()["items"]) == 2
    assert client.get("/api/orders", params={"status": "released"}).json()["items"] == []


def test_status_history_records_every_transition(client):
    order = make_order(client)
    oid = order["id"]
    client.post(f"/api/orders/{oid}/steps/design_review/start", json={})
    client.post(f"/api/orders/{oid}/steps/design_review/complete", json={})
    notes = [h["note"] for h in client.get(f"/api/orders/{oid}").json()["history"]]
    assert notes == ["Design Review completed", "Design Review started", "Order created"]


def test_dashboard_summary_counts(client):
    make_order(client)
    started = make_order(client)
    client.post(f"/api/orders/{started['id']}/steps/design_review/start", json={})

    summary = client.get("/api/dashboard").json()
    assert summary["total_orders"] == 2
    assert summary["in_production"] == 1
    assert len(summary["machines"]) == 3
    assert len(summary["steps"]) == 5
    assert summary["recent_activity"]
