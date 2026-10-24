"""The single open chat room every connected client shares."""

import asyncio
from typing import Any

from fastapi import WebSocket


class Room:
    def __init__(self) -> None:
        self._sockets: set[WebSocket] = set()

    def join(self, ws: WebSocket) -> None:
        self._sockets.add(ws)

    def leave(self, ws: WebSocket) -> None:
        self._sockets.discard(ws)

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
