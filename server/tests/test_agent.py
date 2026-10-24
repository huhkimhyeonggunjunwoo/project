import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from agent import AGENT_ID, Agent, to_turns, unanswered
from db import Database
from room import Room
from test_chat import ORIGIN, client, hello, receive  # noqa: F401  (fixture)


def test_history_becomes_named_turns() -> None:
    history = [
        {"id": 1, "userId": AGENT_ID, "userName": "one", "text": "welcome", "contextId": None},
        {"id": 2, "userId": "a", "userName": "anon-aaaa", "text": "hi", "contextId": None},
        {"id": 3, "userId": "b", "userName": "anon-bbbb", "text": "who are you?", "contextId": None},
        {"id": 4, "userId": "a", "userName": "anon-aaaa", "text": "hello?", "contextId": None},
        # Written after reading up to #3, so #4 is still waiting on it.
        {"id": 5, "userId": AGENT_ID, "userName": "one", "text": "I'm one.", "contextId": 3},
    ]
    assert unanswered(history)
    assert to_turns(history) == [
        {"role": "user", "content": "anon-aaaa: hi\nanon-bbbb: who are you?"},
        {"role": "assistant", "content": "I'm one."},
        {"role": "user", "content": "anon-aaaa: hello?"},
    ]
    assert not unanswered([*history, {**history[-1], "id": 6, "contextId": 5}])


def test_agent_reply_reaches_everyone(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[list] = []

    async def reply(self: Agent, turns: list) -> str:
        seen.append(turns)
        return "hello, everyone"

    monkeypatch.setattr(Agent, "generate", reply)

    with client.websocket_connect("/ws", headers=ORIGIN) as a, client.websocket_connect("/ws", headers=ORIGIN) as b:
        me = hello(a)["user"]
        hello(b)
        a.send_json({"type": "send", "text": "anyone here?"})
        assert receive(a)["message"]["text"] == "anyone here?"
        assert receive(b)["message"]["text"] == "anyone here?"

        for ws in (a, b):
            answer = receive(ws)["message"]
            assert answer["userId"] == AGENT_ID
            assert answer["userName"] == "one"
            assert answer["text"] == "hello, everyone"

    assert seen == [[{"role": "user", "content": f"{me['name']}: anyone here?"}]]
    history = client.get("/messages").json()["messages"]
    assert [m["userId"] for m in history] == [me["id"], AGENT_ID]


def test_messages_during_a_reply_are_answered_together(tmp_path: Path) -> None:
    async def scenario() -> list[list]:
        db = Database(tmp_path / "test.db")
        await db.connect()
        agent = Agent(db, Room(), name="one", model="test", context_messages=50)
        await agent.start()
        alice, _ = await db.create_user()
        bob, _ = await db.create_user()

        calls: list[list] = []
        gate = asyncio.Event()

        async def generate(turns: list) -> str:
            calls.append(turns)
            if len(calls) == 1:
                await gate.wait()
            return f"reply {len(calls)}"

        agent.generate = generate  # type: ignore[method-assign]

        await db.add_message(alice, "first question")
        agent.notify()
        await asyncio.sleep(0)  # the first reply is now in flight
        await db.add_message(bob, "second")
        agent.notify()
        await db.add_message(alice, "third")
        agent.notify()
        gate.set()
        assert agent._task is not None
        await agent._task

        history = (await db.messages_before(None, 50))["messages"]
        await agent.close()
        await db.close()
        assert [m["text"] for m in history] == ["first question", "second", "third", "reply 1", "reply 2"]
        return calls

    calls = asyncio.run(scenario())
    assert len(calls) == 2
    # The second reply sees its first answer, then both messages it missed.
    assert [t["role"] for t in calls[1]] == ["user", "assistant", "user"]
    assert calls[1][1]["content"] == "reply 1"
    assert calls[1][2]["content"].endswith(": second\n" + calls[1][0]["content"].split(":")[0] + ": third")
