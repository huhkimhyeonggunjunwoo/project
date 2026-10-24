import asyncio
import json
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from agent import Agent
from db import Database
from hints import ANGLES, parse, prompt
from room import Room
from test_agent import said
from test_chat import ORIGIN, client, hello, receive  # noqa: F401  (fixture)

# The real one: tests get a stand-in by default (see conftest.py).
REAL_WRITE_HINTS = Agent.write_hints


def test_each_set_asks_for_different_angles() -> None:
    task = prompt(
        agent="one", who=["준"], latest="I like jazz", messages="#1 준: hi", notes="- [[jun]]: 준",
        previous=["예전 힌트"],
    )
    picked = [angle for angle in ANGLES if angle in task]
    assert len(picked) == 3
    assert "language of 준's latest message" in task and "<latest>\nI like jazz\n</latest>" in task
    assert '"예전 힌트"' in task and "<notes_index>" in task


def test_hints_are_cleaned_and_need_at_least_two() -> None:
    assert parse(json.dumps({"hints": [" 나와  취향 비슷한 사람 ", "회사에 추천할 사람", "회사에 추천할 사람", "x", "y"]})) == [
        "나와 취향 비슷한 사람",
        "회사에 추천할 사람",
        "x",
    ]
    assert parse(json.dumps({"hints": ["only one"]})) is None
    assert parse("not json") is None
    assert parse(json.dumps({"hints": "nope"})) is None


def test_hints_reach_only_the_people_answered(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    asked: list[tuple[str, list[str]]] = []

    async def reply(self: Agent, messages: list) -> SimpleNamespace:
        return said("Hi!\n\nWhat's up?")

    async def write_hints(self: Agent, history: list, who: list[str]) -> list[str]:
        asked.append(([m["text"] for m in history], who))
        return ["Find me a cofounder", "Someone into jazz"]

    monkeypatch.setattr(Agent, "generate", reply)
    monkeypatch.setattr(Agent, "write_hints", write_hints)

    with client.websocket_connect("/ws", headers=ORIGIN) as a, client.websocket_connect("/ws", headers=ORIGIN) as b:
        first = hello(a)
        me = first["user"]
        other = hello(b)
        a.send_json({"type": "send", "text": "yo"})
        receive(a)
        receive(a)
        last = receive(a)["message"]
        frame = receive(a)
        assert frame == {
            "type": "hints",
            "messageId": last["id"],
            "for": [me["id"]],
            "hints": ["Find me a cofounder", "Someone into jazz"],
        }

    # The hint writer saw the conversation, the agent's reply included, and whom it's for.
    assert asked[0][1] == [me["name"]]
    assert asked[0][0] == ["yo", "Hi!", "What's up?"]
    # Coming back: I still get them, the other person doesn't.
    with client.websocket_connect("/ws", headers=ORIGIN) as a, client.websocket_connect("/ws", headers=ORIGIN) as b:
        assert hello(a, first["token"])["hints"]["messageId"] == last["id"]
        assert hello(b, other["token"])["hints"] is None


def test_hints_are_dropped_if_the_room_moved_on(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "test.db")
        await db.connect()
        agent = Agent(db, Room(), name="one", model="test", context_messages=50)
        await agent.start()
        alice, _ = await db.create_user()

        async def generate(messages: list) -> SimpleNamespace:
            return said("Hello!")

        async def write_hints(history: list, who: list[str]) -> list[str]:
            # Someone speaks while the hints are being written.
            await db.add_message(alice, "wait, one more thing")
            return ["a", "b"]

        agent.generate = generate  # type: ignore[method-assign]
        agent.write_hints = write_hints  # type: ignore[method-assign]
        await db.add_message(alice, "hi")
        agent._dirty = True
        await agent._run()
        assert agent._hint_task is not None
        await agent._hint_task
        assert agent.hints is None
        await agent.close()
        await db.close()

    asyncio.run(scenario())


def test_hint_request_asks_for_json(monkeypatch: pytest.MonkeyPatch) -> None:
    sent: dict = {}

    async def create(**kwargs: object) -> SimpleNamespace:
        sent.update(kwargs)
        return said(json.dumps({"hints": ["나랑 비슷한 사람 찾아줘", "같이 여행 갈 사람 찾아줘", "공동창업자 찾아줘"]}))

    agent = Agent(None, Room(), name="one", model="test", context_messages=50)  # type: ignore[arg-type]
    monkeypatch.setattr(agent.client.beta.messages, "create", create)
    history = [
        {"id": 1, "userId": "a", "userName": "준", "text": "안녕", "createdAt": "2026-10-24T05:00:00.000+00:00"},
        {"id": 2, "userId": "a", "userName": "준", "text": "I like jazz", "createdAt": "2026-10-24T05:01:00.000+00:00"},
        {"id": 3, "userId": "agent", "userName": "one", "text": "Nice!", "createdAt": "2026-10-24T05:01:05.000+00:00"},
    ]
    hints = asyncio.run(REAL_WRITE_HINTS(agent, history, ["준"]))
    assert hints == ["나랑 비슷한 사람 찾아줘", "같이 여행 갈 사람 찾아줘", "공동창업자 찾아줘"]
    assert sent["output_config"]["format"]["type"] == "json_schema"
    task = sent["messages"][0]["content"]
    assert "] 준: 안녕" in task and "<latest>\nI like jazz\n</latest>" in task
