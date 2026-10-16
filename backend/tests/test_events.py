from tests.conftest import make_order, ws_connect


def test_websocket_receives_events_for_order_changes(client):
    with ws_connect(client) as websocket:
        order = make_order(client)
        assert websocket.receive_json() == {"type": "order.created", "order_id": order["id"]}

        client.post(f"/api/orders/{order['id']}/steps/design_review/start", json={})
        assert websocket.receive_json()["type"] == "production.started"
