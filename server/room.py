"""The single open chat room every connected client shares."""

import asyncio
from typing import Any

from fastapi import WebSocket

from db import User


class Room:
    def __init__(self) -> None:
        self._sockets: dict[WebSocket, User] = {}
        self._announced: list[User] = []
        self._tasks: set[asyncio.Task[None]] = set()

    def join(self, ws: WebSocket, user: User) -> None:
        self._sockets[ws] = user

    def leave(self, ws: WebSocket) -> None:
        """Removes a socket and announces presence in the background, so the
        update goes out even when the leaving handler is being cancelled."""
        if self._sockets.pop(ws, None) is None:
            return
        task = asyncio.create_task(self.sync_presence())
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def rename(self, user: User) -> None:
        """Someone's name changed: update their sockets and tell everyone."""
        for ws, existing in list(self._sockets.items()):
            if existing.id == user.id:
                self._sockets[ws] = user
        await self.broadcast({"type": "rename", "user": user_json(user)})
        await self.sync_presence()

    async def send_to(self, user_ids: list[str], payload: dict[str, Any]) -> None:
        """Sends to these people only, on every tab they have open."""
        sockets = [ws for ws, user in self._sockets.items() if user.id in user_ids]

        async def send(ws: WebSocket) -> None:
            try:
                await ws.send_json(payload)
            except Exception:
                self.leave(ws)

        await asyncio.gather(*(send(ws) for ws in sockets))

    def online(self) -> list[User]:
        """Connected users in the order they arrived, once each (a user can
        have several tabs open)."""
        return list(dict.fromkeys(self._sockets.values()))

    async def sync_presence(self) -> None:
        """Tells everyone who's online, if that changed since the last time."""
        users = self.online()
        if users == self._announced:
            return
        self._announced = users
        await self.broadcast({"type": "presence", "users": [user_json(u) for u in users]})

    async def broadcast(
        self,
        payload: dict[str, Any],
        *,
        sender: WebSocket | None = None,
        sender_extra: dict[str, Any] | None = None,
    ) -> None:
        """Sends to everyone. The sender's copy can carry extra fields
        (e.g. its clientId, so it can match its pending message)."""

        async def send(ws: WebSocket) -> None:
            data = {**payload, **sender_extra} if ws is sender and sender_extra else payload
            try:
                await ws.send_json(data)
            except Exception:
                self.leave(ws)

        await asyncio.gather(*(send(ws) for ws in list(self._sockets)))


def user_json(user: User) -> dict[str, str]:
    return {"id": user.id, "name": user.name}
