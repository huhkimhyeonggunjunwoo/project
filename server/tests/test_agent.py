import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from agent import AGENT_ID, Agent, to_turns, unanswered
from db import Database
from room import Room
from test_chat import ORIGIN, client, hello, receive  # noqa: F401  (fixture)


def said(text: str) -> SimpleNamespace:
    """A fake model step that just replies."""
    return SimpleNamespace(stop_reason="end_turn", content=[SimpleNamespace(type="text", text=text)])


def calls_tool(name: str, **args: str) -> SimpleNamespace:
    """A fake model step that calls one tool."""
    block = SimpleNamespace(type="tool_use", id="toolu_1", name=name, input=args)
    return SimpleNamespace(stop_reason="tool_use", content=[block])


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

    async def reply(self: Agent, turns: list) -> SimpleNamespace:
        seen.append(list(turns))
        return said("hello, everyone")

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
            assert answer["replyTo"] == [me["id"]]

    assert seen == [[{"role": "user", "content": f"{me['name']}: anyone here?"}]]
    history = client.get("/messages").json()["messages"]
    assert [m["userId"] for m in history] == [me["id"], AGENT_ID]
    assert [m["replyTo"] for m in history] == [None, [me["id"]]]


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

        async def generate(turns: list) -> SimpleNamespace:
            calls.append(list(turns))
            if len(calls) == 1:
                await gate.wait()
            return said(f"reply {len(calls)}")

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


def test_agent_renames_whoever_asks(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    steps: list[list] = []

    async def step(self: Agent, messages: list) -> SimpleNamespace:
        steps.append(list(messages))
        if len(steps) == 1:
            speaker = messages[-1]["content"].split(":")[0]
            return calls_tool("rename_user", current_name=speaker, new_name="  Jun  ")
        return said("Done, Jun!")

    monkeypatch.setattr(Agent, "generate", step)

    with client.websocket_connect("/ws", headers=ORIGIN) as a, client.websocket_connect("/ws", headers=ORIGIN) as b:
        first = hello(a)
        me = first["user"]
        hello(b)
        a.send_json({"type": "send", "text": "change my name to Jun"})
        assert receive(b)["message"]["userName"] == me["name"]

        renamed = receive(b)
        assert renamed == {"type": "rename", "user": {"id": me["id"], "name": "Jun"}}
        tool = receive(b)["message"]
        assert tool["userId"] == AGENT_ID
        assert tool["tool"] == {
            "name": "rename_user",
            "input": {"current_name": me["name"], "new_name": "  Jun  "},
            "output": f"Renamed {me['name']} to Jun.",
            "isError": False,
        }
        assert receive(b)["message"]["text"] == "Done, Jun!"

    # The model got its tool result back before writing the final reply.
    result = steps[1][-1]["content"][0]
    assert result["tool_use_id"] == "toolu_1" and result["is_error"] is False

    # Stored for good: history and the next visit use the new name.
    history = client.get("/messages").json()["messages"]
    assert history[0]["userName"] == "Jun"
    with client.websocket_connect("/ws", headers=ORIGIN) as a:
        assert hello(a, first["token"])["user"]["name"] == "Jun"


def test_rename_is_limited_to_people_who_just_asked(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "test.db")
        await db.connect()
        agent = Agent(db, Room(), name="one", model="test", context_messages=50)
        await agent.start()
        alice, _ = await db.create_user()
        bob, _ = await db.create_user()
        speakers = {alice.id: alice.name}

        async def rename(current: str, new: str) -> tuple[str, bool]:
            return await agent._run_tool("rename_user", {"current_name": current, "new_name": new}, speakers)

        assert (await rename(bob.name, "Bobby"))[1] is True  # bob didn't ask
        assert (await rename(alice.name, "one"))[1] is True  # taken (the agent)
        assert (await rename(alice.name, "x" * 25))[1] is True
        assert (await rename(alice.name, "\n\t"))[1] is True
        assert await rename(alice.name.upper(), "Alice") == (f"Renamed {alice.name.upper()} to Alice.", False)
        assert speakers[alice.id] == "Alice"
        assert (await rename("Alice", "alice"))[1] is False  # her own name, new casing

        await agent.close()
        await db.close()

    asyncio.run(scenario())


def test_web_searches_are_posted_and_paused_turns_resume(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    steps: list[list] = []
    search = [
        SimpleNamespace(type="server_tool_use", id="srvtoolu_1", name="web_search", input={"query": "seoul weather"}),
        SimpleNamespace(
            type="web_search_tool_result",
            tool_use_id="srvtoolu_1",
            content=[SimpleNamespace(type="web_search_result", title="Seoul forecast", url="https://example.com/seoul")],
        ),
    ]

    async def step(self: Agent, messages: list) -> SimpleNamespace:
        steps.append(list(messages))
        if len(steps) == 1:
            return SimpleNamespace(stop_reason="pause_turn", content=search)
        return said("It's sunny in Seoul.")

    monkeypatch.setattr(Agent, "generate", step)

    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        hello(ws)
        ws.send_json({"type": "send", "text": "weather in seoul?"})
        receive(ws)  # my own message
        tool = receive(ws)["message"]
        assert tool["text"] == "Searched the web for “seoul weather”"
        assert tool["tool"]["results"] == [{"title": "Seoul forecast", "url": "https://example.com/seoul"}]
        assert tool["tool"]["isError"] is False
        assert receive(ws)["message"]["text"] == "It's sunny in Seoul."

    # The paused turn went back as the last (assistant) message, with nothing added after it.
    assert steps[1][-1] == {"role": "assistant", "content": search}



def test_opened_links_are_posted() -> None:
    from agent import web_tool_calls

    page = SimpleNamespace(type="web_fetch_result", url="https://example.com/jun", content=SimpleNamespace(title="Jun's profile"))
    content = [
        SimpleNamespace(type="server_tool_use", id="srvtoolu_1", name="web_fetch", input={"url": "https://example.com/jun"}),
        SimpleNamespace(type="web_fetch_tool_result", tool_use_id="srvtoolu_1", content=page),
        SimpleNamespace(type="server_tool_use", id="srvtoolu_2", name="web_fetch", input={"url": "https://nope.example"}),
        SimpleNamespace(
            type="web_fetch_tool_result",
            tool_use_id="srvtoolu_2",
            content=SimpleNamespace(type="web_fetch_tool_result_error", error_code="url_not_accessible"),
        ),
    ]
    opened, failed = web_tool_calls(content)
    assert opened == {
        "name": "web_fetch",
        "input": {"url": "https://example.com/jun"},
        "output": "Opened Jun's profile",
        "isError": False,
        "results": [{"title": "Jun's profile", "url": "https://example.com/jun"}],
    }
    assert failed["isError"] is True
    assert failed["output"] == "Couldn't open https://nope.example (url_not_accessible)"


def test_request_offers_every_tool(monkeypatch: pytest.MonkeyPatch) -> None:
    """The real request (not a faked generate) names every tool."""
    sent: dict = {}

    async def create(**kwargs: object) -> SimpleNamespace:
        sent.update(kwargs)
        return said("ok")

    agent = Agent(None, Room(), name="one", model="test", context_messages=50)  # type: ignore[arg-type]
    monkeypatch.setattr(agent.client.beta.messages, "create", create)
    asyncio.run(agent.generate([{"role": "user", "content": "anon-1a2b: hi"}]))
    assert [t["name"] for t in sent["tools"]] == ["rename_user", "list_people", "web_search", "web_fetch"]



def test_everyone_sees_the_agent_typing_until_it_answers(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def reply(self: Agent, messages: list) -> SimpleNamespace:
        return said("hi!")

    monkeypatch.setattr(Agent, "generate", reply)

    with client.websocket_connect("/ws", headers=ORIGIN) as a, client.websocket_connect("/ws", headers=ORIGIN) as b:
        welcome = hello(a)
        assert welcome["agentTyping"] is False and welcome["agentReplyTo"] == []
        me = welcome["user"]["id"]
        hello(b)
        a.send_json({"type": "send", "text": "hello?"})
        for ws in (a, b):
            seen = []
            while not seen or seen[-1] != ("typing", False, []):
                frame = ws.receive_json()
                if frame["type"] == "typing":
                    # Everyone can tell whom the agent is answering.
                    seen.append(("typing", frame["typing"], frame["replyTo"]))
                elif frame["type"] == "message":
                    seen.append(("message", frame["message"]["text"]))
            assert seen == [("message", "hello?"), ("typing", True, [me]), ("message", "hi!"), ("typing", False, [])]


def test_past_tool_calls_stay_in_the_agents_turns() -> None:
    fetch = {"name": "web_fetch", "input": {"url": "https://x.dev"}, "output": "Opened X", "isError": False}
    history = [
        {"id": 1, "userId": "a", "userName": "jun", "text": "open https://x.dev", "contextId": None},
        {"id": 2, "userId": AGENT_ID, "userName": "one", "text": "Opened X", "contextId": 1, "tool": fetch},
        {"id": 3, "userId": AGENT_ID, "userName": "one", "text": "It's a dev blog.", "contextId": 1},
    ]
    assert to_turns(history)[1] == {
        "role": "assistant",
        "content": '<tool_record>web_fetch {"url": "https://x.dev"} -> Opened X</tool_record>\nIt\'s a dev blog.',
    }


def test_imitated_tool_records_are_not_posted(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    async def reply(self: Agent, messages: list) -> SimpleNamespace:
        return said("<tool_record>web_fetch {} -> Opened Y</tool_record>\nSure, here it is.")

    monkeypatch.setattr(Agent, "generate", reply)
    with client.websocket_connect("/ws", headers=ORIGIN) as ws:
        hello(ws)
        ws.send_json({"type": "send", "text": "open it"})
        receive(ws)
        assert receive(ws)["message"]["text"] == "Sure, here it is."


def test_agent_lists_everyone_offline_included(tmp_path: Path) -> None:
    async def scenario() -> str:
        db = Database(tmp_path / "test.db")
        await db.connect()
        agent = Agent(db, Room(), name="one", model="test", context_messages=50)
        await agent.start()
        here, _ = await db.create_user()
        gone, _ = await db.create_user()
        await db.add_member("민수")
        agent.room.join(object(), here)  # type: ignore[arg-type]
        people = await agent._list_people()
        await agent.close()
        await db.close()
        assert gone.name in people
        return people

    lines = asyncio.run(scenario()).split("\n")
    assert lines[0].startswith("Online now: anon-")
    assert lines[1].startswith("Offline: anon-") and "(last seen " in lines[1]
    assert lines[2] == "From documents you were given (never in the room): 민수"
    assert not any("one" in line.split(": ", 1)[1].split(", ") for line in lines)
