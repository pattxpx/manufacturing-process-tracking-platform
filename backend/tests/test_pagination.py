"""Server-side pagination, the capped production board, and the database-counted dashboard."""
from tests.conftest import advance_to_qc, get_resource, make_order, run_step


def get_page(client, path, **params):
    response = client.get(path, params=params)
    assert response.status_code == 200, response.text
    return response.json()


def make_orders(client, count, **extra):
    return [make_order(client, quantity=1 + i, **extra) for i in range(count)]


# ---- Orders: metadata, boundaries, ordering ----

def test_orders_page_metadata_and_boundaries(client):
    orders = make_orders(client, 7)
    ids_newest_first = [o["id"] for o in reversed(orders)]

    first = get_page(client, "/api/orders", page=1, page_size=3)
    assert (first["total"], first["page"], first["page_size"], first["total_pages"]) == (7, 1, 3, 3)
    assert [o["id"] for o in first["items"]] == ids_newest_first[0:3]

    last = get_page(client, "/api/orders", page=3, page_size=3)
    assert last["page"] == 3 and [o["id"] for o in last["items"]] == ids_newest_first[6:7]

    # Pages never overlap and together contain every order exactly once
    seen = []
    for page in (1, 2, 3):
        seen += [o["id"] for o in get_page(client, "/api/orders", page=page, page_size=3)["items"]]
    assert seen == ids_newest_first


def test_default_page_size_is_25(client):
    make_orders(client, 26)
    data = get_page(client, "/api/orders")
    assert (data["page_size"], len(data["items"]), data["total"], data["total_pages"]) == (25, 25, 26, 2)


def test_page_past_the_end_returns_the_last_page(client):
    make_orders(client, 5)
    data = get_page(client, "/api/orders", page=99, page_size=2)
    assert data["page"] == 3 and data["total_pages"] == 3 and len(data["items"]) == 1


def test_empty_list_has_one_empty_page(client):
    data = get_page(client, "/api/orders")
    assert (data["items"], data["total"], data["page"], data["total_pages"]) == ([], 0, 1, 1)


def test_invalid_page_numbers_and_sizes_are_rejected(client):
    assert client.get("/api/orders", params={"page": 0}).status_code == 422
    assert client.get("/api/orders", params={"page": -1}).status_code == 422
    assert client.get("/api/orders", params={"page": "abc"}).status_code == 422
    assert client.get("/api/orders", params={"page_size": 0}).status_code == 422
    assert client.get("/api/orders", params={"page_size": 101}).status_code == 422
    assert client.get("/api/orders", params={"page_size": 100}).status_code == 200  # the maximum is allowed


def test_order_removed_from_a_filter_while_on_a_later_page(client):
    # Two pages of "new" orders. The user is on page 2, then orders leave the filter.
    orders = make_orders(client, 4)
    assert get_page(client, "/api/orders", status="new", page=2, page_size=2)["page"] == 2
    for order in orders[:3]:
        run_step(client, order["id"], "design_review")  # no longer "new"
    data = get_page(client, "/api/orders", status="new", page=2, page_size=2)
    assert data["total"] == 1 and data["page"] == 1 and len(data["items"]) == 1  # clamped to a valid page


# ---- Search and filters cover the whole data set ----

def test_search_and_filters_apply_before_paging(client):
    make_orders(client, 5, product="Hearing Aid Shell")
    make_orders(client, 4, product="Custom Surgical Guide")
    advanced = make_order(client, product="Hearing Aid Shell")
    run_step(client, advanced["id"], "design_review")

    page1 = get_page(client, "/api/orders", search="hearing", page=1, page_size=2)
    page3 = get_page(client, "/api/orders", search="hearing", page=3, page_size=2)
    assert page1["total"] == 6 and page1["total_pages"] == 3
    assert all(o["product"] == "Hearing Aid Shell" for o in page1["items"] + page3["items"])
    assert len(page3["items"]) == 2  # the last page of the matches, not of all orders

    waiting = get_page(client, "/api/orders", status="in_production", search="hearing", page_size=1)
    assert waiting["total"] == 1 and waiting["items"][0]["id"] == advanced["id"]
    by_step = get_page(client, "/api/orders", step="printing")
    assert by_step["total"] == 1


def test_search_treats_percent_and_underscore_as_plain_characters(client):
    plain = make_order(client, design_reference="CAD-PLAIN-1")
    special = make_order(client, design_reference="CAD-100%_OFF")
    assert [o["id"] for o in get_page(client, "/api/orders", search="%")["items"]] == [special["id"]]
    assert [o["id"] for o in get_page(client, "/api/orders", search="_")["items"]] == [special["id"]]
    assert get_page(client, "/api/orders", search="CAD-")["total"] == 2
    assert plain["id"] != special["id"]


def test_blank_search_means_no_search(client):
    make_orders(client, 3)
    assert get_page(client, "/api/orders", search="   ")["total"] == 3


# ---- Usage history and inspections ----

def test_usage_history_is_paged_and_filtered_over_everything(client):
    for i in range(3):
        order = make_order(client, product="Custom Surgical Guide", quantity=1)  # resin + alcohol: 2 rows each
        run_step(client, order["id"], "design_review")
        run_step(client, order["id"], "printing")
    everything = get_page(client, "/api/resources/usage", page_size=100)
    assert everything["total"] == 6

    page = get_page(client, "/api/resources/usage", page=2, page_size=4)
    assert (page["total"], page["total_pages"], len(page["items"])) == (6, 2, 2)
    ids = [row["id"] for row in everything["items"]]
    assert ids == sorted(ids, reverse=True)  # newest first

    alcohol = get_resource(client, "Isopropyl Alcohol")["id"]
    filtered = get_page(client, "/api/resources/usage", resource_id=alcohol, page_size=2)
    assert filtered["total"] == 3 and all(row["resource_id"] == alcohol for row in filtered["items"])


def test_inspection_history_keeps_every_record_and_newest_comes_first(client):
    order = make_order(client)
    advance_to_qc(client, order["id"])
    for result, notes in [("fail", "porosity"), ("fail", "rough edge"), ("pass", "ok now")]:
        assert client.post(f"/api/orders/{order['id']}/inspections", json={"result": result, "notes": notes}).status_code == 201

    page1 = get_page(client, "/api/inspections", page=1, page_size=2)
    page2 = get_page(client, "/api/inspections", page=2, page_size=2)
    assert page1["total"] == 3 and page1["total_pages"] == 2
    assert [i["notes"] for i in page1["items"] + page2["items"]] == ["ok now", "rough edge", "porosity"]

    # Paging the history changes nothing about the order: the latest result decides release
    detail = client.get(f"/api/orders/{order['id']}").json()
    assert detail["latest_inspection_result"] == "pass" and detail["release_blockers"] == []
    assert client.post(f"/api/orders/{order['id']}/release").status_code == 200


def test_pending_inspections_are_paged_oldest_first(client):
    orders = make_orders(client, 3)
    for order in orders:
        advance_to_qc(client, order["id"])
    page1 = get_page(client, "/api/inspections/pending", page=1, page_size=2)
    page2 = get_page(client, "/api/inspections/pending", page=2, page_size=2)
    assert page1["total"] == 3
    assert [o["id"] for o in page1["items"] + page2["items"]] == [o["id"] for o in orders]


# ---- Production board and queue: limits never change scheduling ----

def waiting_at_printing(client, product, quantity):
    order = make_order(client, product=product, quantity=quantity)
    run_step(client, order["id"], "design_review")
    return order


def printing_column(client, limit):
    board = get_page(client, "/api/production/board", limit=limit)
    return next(step for step in board["steps"] if step["step"] == "printing")


def test_board_limit_hides_cards_but_not_totals_or_scheduling(client):
    blocked = waiting_at_printing(client, "Cranial Implant Plate", 1000)  # oldest, not enough material
    second = waiting_at_printing(client, "Hearing Aid Shell", 1)
    third = waiting_at_printing(client, "Hearing Aid Shell", 1)
    fourth = waiting_at_printing(client, "Hearing Aid Shell", 1)

    small = printing_column(client, 2)
    assert small["total"] == 4 and len(small["orders"]) == 2
    full = printing_column(client, 25)
    assert len(full["orders"]) == 4

    # The two cards that are shown say exactly the same thing in both views
    for shown, complete in zip(small["orders"], full["orders"][:2]):
        assert shown["order"]["id"] == complete["order"]["id"]
        assert (shown["position"], shown["can_start"], shown["blocked_reasons"]) == \
               (complete["position"], complete["can_start"], complete["blocked_reasons"])

    by_id = {item["order"]["id"]: item for item in full["orders"]}
    assert [by_id[o["id"]]["position"] for o in (blocked, second, third, fourth)] == [1, 2, 3, 4]
    assert by_id[blocked["id"]]["can_start"] is False        # no material
    assert by_id[second["id"]]["can_start"] is True          # the first order that can go
    assert by_id[third["id"]]["can_start"] is False          # FIFO: second goes first
    assert second["order_number"] in by_id[third["id"]]["blocked_reasons"][0]

    # ...and the backend enforces it, even for an order the board did not list
    rejected = client.post(f"/api/orders/{fourth['id']}/steps/printing/start", json={})
    assert rejected.status_code == 409
    assert client.post(f"/api/orders/{second['id']}/steps/printing/start", json={}).status_code == 200


def test_board_always_lists_running_orders_first(client):
    running = waiting_at_printing(client, "Hearing Aid Shell", 1)
    client.post(f"/api/orders/{running['id']}/steps/printing/start", json={})
    waiting = [waiting_at_printing(client, "Hearing Aid Shell", 1) for _ in range(3)]

    column = printing_column(client, 2)
    assert column["total"] == 4
    assert column["orders"][0]["order"]["id"] == running["id"] and column["orders"][0]["position"] is None
    assert column["orders"][1]["order"]["id"] == waiting[0]["id"] and column["orders"][1]["position"] == 1


def test_board_lists_every_step_and_counts_released_orders(client):
    make_order(client)                                           # design review, waiting
    qc = make_order(client)
    advance_to_qc(client, qc["id"])                              # quality inspection
    done = make_order(client)
    advance_to_qc(client, done["id"])
    client.post(f"/api/orders/{done['id']}/inspections", json={"result": "pass"})
    client.post(f"/api/orders/{done['id']}/release")             # released

    board = get_page(client, "/api/production/board")
    totals = {step["step"]: step["total"] for step in board["steps"]}
    assert totals == {"design_review": 1, "printing": 0, "post_processing": 0, "quality_inspection": 1, "final_release": 0}
    assert board["released_total"] == 1 and board["limit"] == 25
    assert client.get("/api/production/board", params={"limit": 0}).status_code == 422
    assert client.get("/api/production/board", params={"limit": 201}).status_code == 422


def test_queue_limit_returns_the_oldest_per_step_without_changing_decisions(client):
    first = waiting_at_printing(client, "Hearing Aid Shell", 1)
    waiting_at_printing(client, "Hearing Aid Shell", 1)
    full = get_page(client, "/api/production/queue")
    limited = get_page(client, "/api/production/queue", limit_per_step=1)
    assert len(full) == 2 and len(limited) == 1
    assert limited[0]["order"]["id"] == first["id"] and limited[0]["can_start"] == full[0]["can_start"]


def test_resources_list_who_is_waiting_short(client):
    big = waiting_at_printing(client, "Cranial Implant Plate", 1000)
    waiting_at_printing(client, "Hearing Aid Shell", 1)
    resources = {r["name"]: r for r in get_page(client, "/api/resources")}
    titanium = resources["Ti-6Al-4V Powder"]
    assert titanium["waiting_short_total"] == 1
    assert titanium["waiting_short_orders"] == [{"id": big["id"], "order_number": big["order_number"]}]
    assert resources["Argon Gas"]["waiting_short_total"] == 1
    assert resources["Medical Photopolymer Resin"]["waiting_short_total"] == 0


# ---- Dashboard numbers come from the database ----

def test_dashboard_step_counts(client):
    make_order(client)                                             # design review, waiting
    running_review = make_order(client)
    client.post(f"/api/orders/{running_review['id']}/steps/design_review/start", json={})
    older = waiting_at_printing(client, "Hearing Aid Shell", 1)
    waiting_at_printing(client, "Hearing Aid Shell", 1)
    assert client.post(f"/api/orders/{older['id']}/steps/printing/start", json={}).status_code == 200

    steps = {s["step"]: s for s in get_page(client, "/api/dashboard")["steps"]}
    assert (steps["design_review"]["waiting"], steps["design_review"]["running"]) == (1, 1)
    assert steps["design_review"]["completed"] == 2
    assert (steps["printing"]["waiting"], steps["printing"]["running"]) == (1, 1)
