"""SQLite storage for anonymous users and the shared chat history."""

import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import aiosqlite

SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    token_hash   TEXT NOT NULL UNIQUE,
    created_at   TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id),
    text       TEXT NOT NULL,
    created_at TEXT NOT NULL,
    -- Agent replies only: id of the newest message it had read when replying.
    context_id INTEGER,
    -- Agent tool calls only: JSON {name, input, output, isError}.
    tool       TEXT
);
"""

# Columns added after the first release, for databases created before them.
ADDED_COLUMNS = {"context_id": "INTEGER", "tool": "TEXT"}

MESSAGE_COLUMNS = "m.id, m.user_id, u.name, m.text, m.created_at, m.context_id, m.tool"


@dataclass(frozen=True)
class User:
    id: str
    name: str


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds")


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _message(row: aiosqlite.Row) -> dict[str, Any]:
    return {
        "id": row["id"],
        "userId": row["user_id"],
        "userName": row["name"],
        "text": row["text"],
        "createdAt": row["created_at"],
        "tool": json.loads(row["tool"]) if row["tool"] else None,
    }


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._conn: aiosqlite.Connection | None = None

    @property
    def conn(self) -> aiosqlite.Connection:
        if self._conn is None:
            raise RuntimeError("Database is not connected")
        return self._conn

    async def connect(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._conn = await aiosqlite.connect(self.path)
        self._conn.row_factory = aiosqlite.Row
        await self._conn.execute("PRAGMA journal_mode=WAL")
        await self._conn.execute("PRAGMA foreign_keys=ON")
        await self._conn.executescript(SCHEMA)
        async with self._conn.execute("PRAGMA table_info(messages)") as cursor:
            columns = {row["name"] for row in await cursor.fetchall()}
        for column, kind in ADDED_COLUMNS.items():
            if column not in columns:
                await self._conn.execute(f"ALTER TABLE messages ADD COLUMN {column} {kind}")
        await self._conn.commit()

    async def close(self) -> None:
        if self._conn is not None:
            await self._conn.close()
            self._conn = None

    async def create_user(self) -> tuple[User, str]:
        """Issues a new anonymous user. The token is only ever returned here."""
        user_id = uuid.uuid4().hex
        user = User(id=user_id, name=f"anon-{user_id[:4]}")
        token = secrets.token_urlsafe(32)
        now = _now()
        await self.conn.execute(
            "INSERT INTO users (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)",
            (user.id, user.name, _hash_token(token), now, now),
        )
        await self.conn.commit()
        return user, token

    async def ensure_user(self, user: User) -> None:
        """Creates a fixed, login-less user (the agent) if it doesn't exist yet.
        Its token hash isn't a sha256 digest, so no token can ever match it."""
        now = _now()
        await self.conn.execute(
            "INSERT INTO users (id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET name = excluded.name",
            (user.id, user.name, f"!{user.id}", now, now),
        )
        await self.conn.commit()

    async def user_by_token(self, token: str) -> User | None:
        token_hash = _hash_token(token)
        async with self.conn.execute(
            "SELECT id, name FROM users WHERE token_hash = ?", (token_hash,)
        ) as cursor:
            row = await cursor.fetchone()
        if row is None:
            return None
        await self.conn.execute("UPDATE users SET last_seen_at = ? WHERE id = ?", (_now(), row["id"]))
        await self.conn.commit()
        return User(id=row["id"], name=row["name"])

    async def list_users(self, exclude: str) -> list[User]:
        """Everyone who has ever joined, most recently seen first."""
        async with self.conn.execute(
            "SELECT id, name FROM users WHERE id != ? ORDER BY last_seen_at DESC, id", (exclude,)
        ) as cursor:
            rows = await cursor.fetchall()
        return [User(id=row["id"], name=row["name"]) for row in rows]

    async def rename_user(self, user_id: str, name: str) -> User | None:
        """Renames a user, or returns None if someone else already has that
        name (ignoring case)."""
        async with self.conn.execute(
            "SELECT 1 FROM users WHERE lower(name) = lower(?) AND id != ?", (name, user_id)
        ) as cursor:
            if await cursor.fetchone() is not None:
                return None
        await self.conn.execute("UPDATE users SET name = ? WHERE id = ?", (name, user_id))
        await self.conn.commit()
        return User(id=user_id, name=name)

    async def add_message(
        self,
        user: User,
        text: str,
        context_id: int | None = None,
        tool: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        cursor = await self.conn.execute(
            "INSERT INTO messages (user_id, text, created_at, context_id, tool) VALUES (?, ?, ?, ?, ?)",
            (user.id, text, _now(), context_id, json.dumps(tool) if tool else None),
        )
        await self.conn.commit()
        async with self.conn.execute(
            f"SELECT {MESSAGE_COLUMNS}"
            " FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?",
            (cursor.lastrowid,),
        ) as rows:
            row = await rows.fetchone()
        assert row is not None
        return _message(row)

    async def messages_before(self, before: int | None, limit: int) -> dict[str, Any]:
        """Newest `limit` messages older than `before` (or the newest overall),
        returned oldest-first, plus whether anything older remains."""
        async with self.conn.execute(
            f"SELECT {MESSAGE_COLUMNS}"
            " FROM messages m JOIN users u ON u.id = m.user_id"
            " WHERE (:before IS NULL OR m.id < :before)"
            " ORDER BY m.id DESC LIMIT :limit",
            {"before": before, "limit": limit + 1},
        ) as cursor:
            rows = await cursor.fetchall()
        has_more = len(rows) > limit
        messages = [_message(row) for row in rows[:limit]]
        messages.reverse()
        return {"messages": messages, "hasMore": has_more}

    async def recent_context(self, limit: int) -> list[dict[str, Any]]:
        """The newest `limit` messages, oldest first, with each agent reply's
        context_id (what the agent had read when it wrote it)."""
        async with self.conn.execute(
            f"SELECT {MESSAGE_COLUMNS}"
            " FROM messages m JOIN users u ON u.id = m.user_id"
            " ORDER BY m.id DESC LIMIT ?",
            (limit,),
        ) as cursor:
            rows = await cursor.fetchall()
        return [{**_message(row), "contextId": row["context_id"]} for row in reversed(rows)]
