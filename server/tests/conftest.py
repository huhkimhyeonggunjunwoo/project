import pytest

from agent import Agent


@pytest.fixture(autouse=True)
def no_hints(monkeypatch: pytest.MonkeyPatch) -> None:
    """Never call Claude for hints in tests; tests that want them swap this out."""

    async def none(self: Agent, history: list, who: list[str]) -> None:
        return None

    monkeypatch.setattr(Agent, "write_hints", none)
