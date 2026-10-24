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
    tool       TEXT,
    -- Agent messages only: JSON list of the user ids it was answering.
    reply_to   TEXT
);

CREATE TABLE IF NOT EXISTS achievements (
    user_id   TEXT NOT NULL REFERENCES users(id),
    key       TEXT NOT NULL,
    earned_at TEXT NOT NULL,
    PRIMARY KEY (user_id, key)
);
"""

# Columns added after the first release, for databases created before them.
ADDED_COLUMNS = {"context_id": "INTEGER", "tool": "TEXT", "reply_to": "TEXT"}

MESSAGE_COLUMNS = "m.id, m.user_id, u.name, m.text, m.created_at, m.context_id, m.tool, m.reply_to"


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
        "replyTo": json.loads(row["reply_to"]) if row["reply_to"] else None,
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

    async def add_member(self, name: str) -> User | None:
        """Adds someone who can't log in, like a person from a document the
        agent was given, so they're listed with everyone else. Returns None
        if the name is taken (ignoring case)."""
        async with self.conn.execute("SELECT 1 FROM users WHERE lower(name) = lower(?)", (name,)) as cursor:
            if await cursor.fetchone() is not None:
                return None
        user = User(id=uuid.uuid4().hex, name=name)
        await self.ensure_user(user)
        return user

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

    async def people(self, exclude: str, limit: int) -> list[dict[str, Any]]:
        """Everyone who has ever joined, most recently seen first, and whether
        they're a login-less member (see add_member)."""
        async with self.conn.execute(
            "SELECT id, name, last_seen_at, token_hash LIKE '!%' AS member FROM users"
            " WHERE id != ? ORDER BY last_seen_at DESC, id LIMIT ?",
            (exclude, limit),
        ) as cursor:
            rows = await cursor.fetchall()
        return [
            {"id": row["id"], "name": row["name"], "lastSeenAt": row["last_seen_at"], "member": bool(row["member"])}
            for row in rows
        ]

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

    async def user_by_name(self, name: str) -> User | None:
        """Someone by name, ignoring case (names are unique that way)."""
        async with self.conn.execute(
            "SELECT id, name FROM users WHERE lower(name) = lower(?)", (name,)
        ) as cursor:
            row = await cursor.fetchone()
        return User(id=row["id"], name=row["name"]) if row is not None else None

    async def texts_by(self, user_id: str, limit: int) -> list[str]:
        """The newest `limit` messages this user wrote, newest first."""
        async with self.conn.execute(
            "SELECT text FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT ?", (user_id, limit)
        ) as cursor:
            rows = await cursor.fetchall()
        return [row["text"] for row in rows]

    async def achievements(self, user_id: str) -> list[str]:
        """Keys of the achievements this user has earned, oldest first."""
        async with self.conn.execute(
            "SELECT key FROM achievements WHERE user_id = ? ORDER BY earned_at, key", (user_id,)
        ) as cursor:
            rows = await cursor.fetchall()
        return [row["key"] for row in rows]

    async def award(self, user_id: str, key: str) -> bool:
        """Gives a user an achievement. Returns whether it's new to them."""
        cursor = await self.conn.execute(
            "INSERT OR IGNORE INTO achievements (user_id, key, earned_at) VALUES (?, ?, ?)",
            (user_id, key, _now()),
        )
        await self.conn.commit()
        return cursor.rowcount > 0

    async def add_message(
        self,
        user: User,
        text: str,
        context_id: int | None = None,
        tool: dict[str, Any] | None = None,
        reply_to: list[str] | None = None,
    ) -> dict[str, Any]:
        cursor = await self.conn.execute(
            "INSERT INTO messages (user_id, text, created_at, context_id, tool, reply_to) VALUES (?, ?, ?, ?, ?, ?)",
            (user.id, text, _now(), context_id, json.dumps(tool) if tool else None,
             json.dumps(reply_to) if reply_to is not None else None),
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

    async def messages_before(self, before: int | None, limit: int, for_user: str | None = None) -> dict[str, Any]:
        """Newest `limit` messages older than `before` (or the newest overall),
        returned oldest-first, plus whether anything older remains. With
        `for_user`, only their own messages and the agent's replies to them."""
        async with self.conn.execute(
            f"SELECT {MESSAGE_COLUMNS}"
            " FROM messages m JOIN users u ON u.id = m.user_id"
            " WHERE (:before IS NULL OR m.id < :before)"
            " AND (:user IS NULL OR m.user_id = :user"
            "      OR EXISTS (SELECT 1 FROM json_each(m.reply_to) WHERE value = :user))"
            " ORDER BY m.id DESC LIMIT :limit",
            {"before": before, "user": for_user, "limit": limit + 1},
        ) as cursor:
            rows = await cursor.fetchall()
        has_more = len(rows) > limit
        messages = [_message(row) for row in rows[:limit]]
        messages.reverse()
        return {"messages": messages, "hasMore": has_more}

    async def messages_after(self, after: int, limit: int) -> list[dict[str, Any]]:
        """The oldest `limit` messages newer than `after`, oldest first."""
        async with self.conn.execute(
            f"SELECT {MESSAGE_COLUMNS}"
            " FROM messages m JOIN users u ON u.id = m.user_id"
            " WHERE m.id > ? ORDER BY m.id LIMIT ?",
            (after, limit),
        ) as cursor:
            rows = await cursor.fetchall()
        return [_message(row) for row in rows]

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
