from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from achievements import shares_link
from agent import Agent
from test_agent import calls_tool, said
from test_chat import ORIGIN, client, hello  # noqa: F401  (fixture)


def answered(ws) -> list[str]:
    """Achievements this client is told about until the agent's next "ok"."""
    keys = []
    while True:
        frame = ws.receive_json()
        if frame["type"] == "achievement":
            keys.append(frame["key"])
        elif frame["type"] == "message" and frame["message"]["text"] == "ok":
            return keys


def test_links_count_as_profiles() -> None:
    assert shares_link("here's mine: https://www.linkedin.com/in/jun")
    assert shares_link("github.com/DipokalLab")
    assert shares_link("my site http://jun.dev")
    assert not shares_link("I use github a lot")
    assert not shares_link("change my name to jun.dev")


def test_achievements_are_earned_and_kept(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    steps: list[list] = []

    async def step(self: Agent, messages: list) -> SimpleNamespace:
        steps.append(list(messages))
        last = messages[-1]["content"]
        if isinstance(last, str) and "match" in last:
            return calls_tool("list_people")
        if isinstance(last, str) and "name" in last:
            return calls_tool("rename_user", current_name=last.split(":")[0], new_name="Jun")
        return said("ok")

    monkeypatch.setattr(Agent, "generate", step)

    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        first = hello(ws)
        assert first["achievements"] == []

        # Looking for people before sharing a profile doesn't count.
        ws.send_json({"type": "send", "text": "find me a match"})
        assert answered(ws) == []
        ws.send_json({"type": "send", "text": "here's me: github.com/jun"})
        assert answered(ws) == ["profile"]
        ws.send_json({"type": "send", "text": "now find me a match"})
        assert answered(ws) == ["match"]
        # Sharing another link isn't new.
        ws.send_json({"type": "send", "text": "also https://jun.dev"})
        assert answered(ws) == []
        ws.send_json({"type": "send", "text": "change my name please"})
        assert answered(ws) == ["rename"]

    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        assert sorted(hello(ws, first["token"])["achievements"]) == ["match", "profile", "rename"]
