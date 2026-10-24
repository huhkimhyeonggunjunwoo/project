import asyncio
from pathlib import Path
from types import SimpleNamespace

import pytest

from agent import AGENT_ID, Agent
from db import Database
from memory import Memory, Wiki
from room import Room
from test_agent import calls_tool, said


def uses(*calls: tuple[str, dict[str, str]]) -> SimpleNamespace:
    """A fake model step that calls wiki tools, several at once if given."""
    blocks = [
        SimpleNamespace(type="tool_use", id=f"toolu_{i}", name=name, input=args)
        for i, (name, args) in enumerate(calls)
    ]
    return SimpleNamespace(stop_reason="tool_use", content=blocks)


def test_wiki_pages_are_flat_and_the_log_is_server_only(tmp_path: Path) -> None:
    wiki = Wiki(tmp_path / "wiki")
    assert wiki.read("index") is None and wiki.pages() == []

    wiki.write("jun", "# Jun\nA designer.")
    wiki.write("index", "- [[jun]]: Jun")
    assert wiki.read("jun") == "# Jun\nA designer.\n"
    assert wiki.pages() == ["jun"]

    for bad in ("../secret", "Jun", "a/b", "", "x" * 65):
        with pytest.raises(ValueError):
            wiki.write(bad, "nope")
    with pytest.raises(ValueError):
        wiki.write("log", "rewritten history")
    with pytest.raises(ValueError):
        wiki.delete("index")
    with pytest.raises(ValueError):
        wiki.write("long", "x" * 6001)

    wiki.delete("jun")
    assert wiki.pages() == []
    assert not (tmp_path / "secret.md").exists()


def test_ingest_waits_for_a_batch_then_compiles_it(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "test.db")
        await db.connect()
        agent = Agent(db, Room(), name="one", model="test", context_messages=50,
                      memory_dir=tmp_path / "wiki", ingest_every=3, lint_every=2)
        await agent.start()
        memory = agent.memory
        assert memory is not None
        jun, _ = await db.create_user()

        requests: list[dict] = []

        async def create(**kwargs: object) -> SimpleNamespace:
            requests.append(kwargs)
            step = sum(1 for r in requests if r["messages"] is kwargs["messages"])
            task = kwargs["messages"][0]["content"]  # type: ignore[index]
            if task.startswith("Time to check"):
                return said("All consistent.")
            if step == 1:
                return uses(("read_page", {"name": "jun"}))
            if step == 2:
                return uses(
                    ("write_page", {"name": "jun", "content": "# Jun\nA designer (#2)."}),
                    ("write_page", {"name": "index", "content": "- [[jun]]: Jun, a designer"}),
                )
            return said("Added a page for Jun.")

        monkeypatch.setattr(memory.client.beta.messages, "create", create)

        await db.add_message(jun, "hi")
        await db.add_message(jun, "I'm a designer")
        await memory.catch_up(db)
        assert requests == []  # not enough yet

        await db.add_message(agent.user, "Nice to meet you!")
        await memory.catch_up(db)
        await agent.close()
        await db.close()

        task = requests[0]["messages"][0]["content"]
        assert "#1 to #3" in task
        assert f"] {jun.name}: I'm a designer" in task
        assert "] one (you): Nice to meet you!" in task
        assert "Pages now: none yet" in task
        # The missing page came back as an error, then both writes went back together.
        assert requests[1]["messages"][2]["content"][0]["is_error"] is True
        assert [r["is_error"] for r in requests[2]["messages"][4]["content"]] == [False, False]

        wiki = memory.wiki
        assert wiki.pages() == ["jun"]
        assert memory.index() == "- [[jun]]: Jun, a designer"
        assert wiki.state == {"readUpTo": 3, "ingests": 1}
        log = wiki.read("log") or ""
        assert "ingest #1-#3\nAdded a page for Jun." in log
        assert "lint" not in log  # every 2nd ingest

    asyncio.run(scenario())


def test_lint_runs_every_few_ingests_and_failures_move_on(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "test.db")
        await db.connect()
        jun, _ = await db.create_user()

        memory = Memory(Wiki(tmp_path / "wiki"), None, name="one", agent_id=AGENT_ID,  # type: ignore[arg-type]
                        model="test", ingest_every=2, lint_every=2)
        tasks: list[str] = []

        async def compile(task: str) -> str | None:
            tasks.append(task.split("\n")[0])
            return None if len(tasks) == 1 else "ok"

        monkeypatch.setattr(memory, "_compile", compile)
        for i in range(4):
            await db.add_message(jun, f"message {i}")
            await memory.catch_up(db)
        await db.close()

        assert tasks == [
            "New messages from the room, #1 to #2. Lines marked \"(you)\" are one's own.",
            "New messages from the room, #3 to #4. Lines marked \"(you)\" are one's own.",
            tasks[2],
        ]
        assert tasks[2].startswith("Time to check the whole wiki.")
        log = memory.wiki.read("log") or ""
        assert "ingest #1-#2\n(failed)" in log and "ingest #3-#4\nok" in log and "] lint\nok" in log
        assert memory.wiki.state == {"readUpTo": 4, "ingests": 2}

    asyncio.run(scenario())


def test_agent_reads_its_notes_while_replying(tmp_path: Path) -> None:
    async def scenario() -> None:
        db = Database(tmp_path / "test.db")
        await db.connect()
        agent = Agent(db, Room(), name="one", model="test", context_messages=50, memory_dir=tmp_path / "wiki")
        await agent.start()
        assert agent.memory is not None
        agent.memory.wiki.write("index", "- [[jun]]: Jun, a designer")
        agent.memory.wiki.write("jun", "# Jun\nA designer (#2).")
        jun, _ = await db.create_user()

        steps: list[list] = []

        async def generate(messages: list) -> SimpleNamespace:
            steps.append(list(messages))
            if len(steps) == 1:
                return calls_tool("read_notes", page="jun")
            return said("You're the designer!")

        agent.generate = generate  # type: ignore[method-assign]
        await db.add_message(jun, "remember me?")
        await agent._reply()
        history = (await db.messages_before(None, 50))["messages"]
        await agent.close()
        await db.close()

        # The model got the page; the room only sees which page was opened.
        assert steps[1][-1]["content"][0]["content"] == "# Jun\nA designer (#2).\n"
        assert history[1]["text"] == "Checked my notes on jun"
        assert history[1]["tool"]["isError"] is False
        assert history[2]["text"] == "You're the designer!"

    asyncio.run(scenario())


def test_request_shows_the_notes_index(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    sent: dict = {}

    async def create(**kwargs: object) -> SimpleNamespace:
        sent.update(kwargs)
        return said("ok")

    agent = Agent(None, Room(), name="one", model="test", context_messages=50,  # type: ignore[arg-type]
                  memory_dir=tmp_path / "wiki")
    monkeypatch.setattr(agent.client.beta.messages, "create", create)
    turns = [{"role": "user", "content": "anon-1a2b: hi"}]

    asyncio.run(agent.generate(turns))  # type: ignore[arg-type]
    assert sent["system"].endswith("You have no notes yet.")
    assert [t["name"] for t in sent["tools"]][-1] == "read_notes"

    assert agent.memory is not None
    agent.memory.wiki.write("index", "- [[jun]]: Jun")
    asyncio.run(agent.generate(turns))  # type: ignore[arg-type]
    assert sent["system"].endswith("<notes_index>\n- [[jun]]: Jun\n</notes_index>")
