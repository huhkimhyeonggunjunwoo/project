"""Gives the agent a document to remember: it's kept in the wiki's raw/
folder (never changed afterwards) and compiled into the wiki's pages.

    npm run server:add-source -- /path/to/notes.md
    npm run server:add-source -- /path/to/log.md --name discord-day-1 --member 민수 --member "Bloom Ops"
    npm run server:add-source -- --again discord-day-1

--name is the source's name in the wiki (default: the file name).
--member adds a person from the document as a login-less user, so they're
listed with everyone else in the room. --again compiles a source that's
already in raw/ once more, e.g. after the memory schema changed.

Calls Claude, with the current APP_ENV's settings. Paths are relative to the
server directory.
"""

import argparse
import asyncio
import re
import sys
from pathlib import Path

import anthropic

from agent import AGENT_ID, clean_name
from config import settings
from db import Database
from memory import Memory, Wiki


async def run(path: Path | None, name: str, members: list[str]) -> int:
    db = Database(settings.database_file)
    await db.connect()
    client = anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key)
    memory = Memory(Wiki(settings.memory_dir), client, name=settings.agent_name, agent_id=AGENT_ID,
                    model=settings.agent_model, ingest_every=settings.memory_ingest_every,
                    lint_every=settings.memory_lint_every)
    try:
        print(f"Compiling '{name}' into memory...")
        summary = await memory.ingest_source(name, path.read_text(encoding="utf-8") if path else None)
        print(summary or "The pass didn't finish; see the server log. The source is kept in raw/.")
        for member in members:
            user = await db.add_member(clean_name(member))
            print(f"Added {user.name}" if user else f"Skipped {member}: the name is taken")
        return 0 if summary else 1
    finally:
        await client.close()
        await db.close()


def main() -> int:
    parser = argparse.ArgumentParser(description="Add a document to the agent's memory.")
    parser.add_argument("file", type=Path, nargs="?")
    parser.add_argument("--name", help="the source's name in the wiki: lowercase words joined by hyphens")
    parser.add_argument("--member", action="append", default=[], help="a person from it to add as a user")
    parser.add_argument("--again", metavar="NAME", help="compile a source already in the wiki again")
    args = parser.parse_args()
    if (args.file is None) == (args.again is None):
        parser.error("give either a file or --again NAME")
    name = args.again or args.name or re.sub(r"[^a-z0-9]+", "-", args.file.stem.lower()).strip("-")
    try:
        for member in args.member:
            clean_name(member)
        return asyncio.run(run(args.file, name, args.member))
    except ValueError as e:
        print(e)
        return 1


if __name__ == "__main__":
    sys.exit(main())
