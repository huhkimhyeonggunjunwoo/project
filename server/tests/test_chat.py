from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

import main
from agent import Agent
from db import Database

ORIGIN = {"origin": "http://localhost:5173"}


async def silent(self: Agent, turns: list) -> None:
    return None


@pytest.fixture
def client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[TestClient]:
    monkeypatch.setattr(main, "db", Database(tmp_path / "test.db"))
    monkeypatch.setattr(main.settings, "memory_path", tmp_path / "wiki")
    # Never call Claude in tests; tests that want replies swap this out.
    monkeypatch.setattr(Agent, "generate", silent)
    with TestClient(main.app) as c:
        yield c


def receive(ws) -> dict:
    """Next frame, skipping presence updates, private notes and typing signals."""
    while (frame := ws.receive_json())["type"] in ("presence", "private", "typing"):
        pass
    return frame


def presence(ws) -> list[str]:
    """Names in the next presence update."""
    while (frame := ws.receive_json())["type"] != "presence":
        pass
    return [u["name"] for u in frame["users"]]


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

        mine = receive(a)
        theirs = receive(b)

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
            receive(ws)

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
            receive(ws)

    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        hello(ws)
        ws.send_json({"type": "send", "text": "x" * 5000})
        assert receive(ws)["type"] == "error"


def test_online_users_are_announced(client: TestClient) -> None:
    with client.websocket_connect("/ws", headers=ORIGIN) as a:
        first = hello(a)
        assert [u["name"] for u in first["online"]] == [first["user"]["name"]]
        assert first["agent"] == {"id": "agent", "name": "one"}
        assert presence(a) == [first["user"]["name"]]

        with client.websocket_connect("/ws", headers=ORIGIN) as b:
            second = hello(b)
            both = [first["user"]["name"], second["user"]["name"]]
            assert [u["name"] for u in second["online"]] == both
            assert presence(a) == both

            # A second tab of the same user doesn't list them twice.
            with client.websocket_connect("/ws", headers=ORIGIN) as b2:
                hello(b2, second["token"])
            b.send_json({"type": "send", "text": "still one of me"})
            assert receive(a)["message"]["text"] == "still one of me"

        assert presence(a) == [first["user"]["name"]]


def test_private_greeting_only_reaches_the_newcomer(client: TestClient) -> None:
    with client.websocket_connect("/ws", headers=ORIGIN) as a:
        hello(a)
        greeting = a.receive_json()
        assert greeting["type"] == "private"
        assert greeting["message"]["key"] == "welcome"
        assert greeting["message"]["userId"] == "agent"
        assert "id" not in greeting["message"]

        with client.websocket_connect("/ws", headers=ORIGIN) as b:
            hello(b)
            b.send_json({"type": "send", "text": "hi"})
            # Everything a gets up to b's message: presence updates, never b's greeting.
            types = []
            while (frame := a.receive_json())["type"] != "message":
                types.append(frame["type"])
        assert "private" not in types

    assert client.get("/messages").json()["messages"][0]["text"] == "hi"


def test_welcome_lists_everyone_who_ever_joined(client: TestClient) -> None:
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        gone = hello(ws)["user"]
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        here = hello(ws)
    assert here["users"][0] == here["user"]  # most recently seen first
    assert gone in here["users"]
    assert all(u["id"] != "agent" for u in here["users"])
