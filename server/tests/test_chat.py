from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
from db import Database

ORIGIN = {"origin": "http://localhost:5173"}


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(main, "db", Database(tmp_path / "test.db"))
    with TestClient(main.app) as c:
        yield c


def hello(ws, token: str | None = None) -> dict:
    ws.send_json({"type": "hello", "token": token})
    welcome = ws.receive_json()
    assert welcome["type"] == "welcome"
    return welcome


def test_root(client: TestClient) -> None:
    assert client.get("/").json() == {"name": "One House", "status": "ok"}


def test_anonymous_id_is_remembered_with_token(client: TestClient) -> None:
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        first = hello(ws)
    assert first["user"]["id"] and first["token"]

    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        again = hello(ws, first["token"])
    assert again["user"] == first["user"]

    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        stranger = hello(ws, "not-a-real-token")
    assert stranger["user"]["id"] != first["user"]["id"]


def test_messages_reach_everyone_in_the_room(client: TestClient) -> None:
    with client.websocket_connect("/ws", headers=ORIGIN) as a, client.websocket_connect("/ws", headers=ORIGIN) as b:
        me = hello(a)["user"]
        hello(b)
        a.send_json({"type": "send", "text": "  hi all  ", "clientId": "c1"})

        mine = a.receive_json()
        theirs = b.receive_json()

    assert mine["clientId"] == "c1"
    assert "clientId" not in theirs
    assert mine["message"] == theirs["message"]
    assert theirs["message"]["text"] == "hi all"
    assert theirs["message"]["userId"] == me["id"]


def test_history_is_paginated_newest_first(client: TestClient) -> None:
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        hello(ws)
        for i in range(75):
            ws.send_json({"type": "send", "text": f"m{i}"})
            ws.receive_json()

    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        page = hello(ws)["history"]
    assert [m["text"] for m in page["messages"]] == [f"m{i}" for i in range(45, 75)]
    assert page["hasMore"] is True

    older = client.get("/messages", params={"before": page["messages"][0]["id"]}).json()
    assert [m["text"] for m in older["messages"]] == [f"m{i}" for i in range(15, 45)]
    assert older["hasMore"] is True

    oldest = client.get("/messages", params={"before": older["messages"][0]["id"]}).json()
    assert [m["text"] for m in oldest["messages"]] == [f"m{i}" for i in range(15)]
    assert oldest["hasMore"] is False


def test_rejects_unknown_origin_and_long_messages(client: TestClient) -> None:
    with pytest.raises(Exception):
        with client.websocket_connect("/ws", headers={"origin": "https://evil.example"}) as ws:
            ws.receive_json()

    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        hello(ws)
        ws.send_json({"type": "send", "text": "x" * 5000})
        assert ws.receive_json()["type"] == "error"
