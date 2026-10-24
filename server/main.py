import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from config import settings
from db import Database
from room import Room

HELLO_TIMEOUT_SECONDS = 10

db = Database(settings.database_file)
room = Room()


@asynccontextmanager
async def lifespan(_: FastAPI):
    await db.connect()
    yield
    await db.close()


app = FastAPI(title="One House API", lifespan=lifespan)

if settings.cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_methods=["GET"],
        allow_headers=["*"],
    )


@app.get("/")
def read_root() -> dict[str, str]:
    return {"name": "One House", "status": "ok"}


@app.get("/messages")
async def list_messages(
    before: int | None = Query(None, ge=1, description="Return messages with an id lower than this"),
    limit: int | None = Query(None, ge=1, le=100),
) -> dict[str, Any]:
    """Chat history, newest first by page; each page is ordered oldest-first."""
    return await db.messages_before(before, limit or settings.history_page_size)


def _origin_allowed(origin: str | None) -> bool:
    return not settings.cors_origins or origin is None or origin in settings.cors_origins


async def _receive(ws: WebSocket) -> dict[str, Any] | None:
    """Next JSON object from the client, or None if the frame isn't one."""
    try:
        data = json.loads(await ws.receive_text())
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


@app.websocket("/ws")
async def chat_socket(ws: WebSocket) -> None:
    """Protocol (JSON frames):

    client → {"type": "hello", "token": "<saved token or null>"}   (first frame)
    server → {"type": "welcome", "user": {...}, "token": "...", "history": {...}}
    client → {"type": "send", "text": "...", "clientId": "..."}
    server → {"type": "message", "message": {...}, "clientId"?: "..."}   (to everyone)
    server → {"type": "error", "message": "..."}
    """
    if not _origin_allowed(ws.headers.get("origin")):
        await ws.close(code=1008)
        return
    await ws.accept()

    try:
        hello = await asyncio.wait_for(_receive(ws), timeout=HELLO_TIMEOUT_SECONDS)
    except WebSocketDisconnect:
        return
    except asyncio.TimeoutError:
        await ws.close(code=1008)
        return
    if not hello or hello.get("type") != "hello":
        await ws.close(code=1008)
        return

    token = hello.get("token")
    user = await db.user_by_token(token) if isinstance(token, str) and token else None
    if user is None:
        user, token = await db.create_user()

    # Join before reading history so nothing sent in between is missed;
    # the client merges by message id.
    room.join(ws)
    try:
        history = await db.messages_before(None, settings.history_page_size)
        await ws.send_json(
            {
                "type": "welcome",
                "user": {"id": user.id, "name": user.name},
                "token": token,
                "history": history,
            }
        )

        while True:
            data = await _receive(ws)
            if not data or data.get("type") != "send":
                continue
            text = str(data.get("text", "")).strip()
            if not text:
                continue
            if len(text) > settings.max_message_length:
                await ws.send_json(
                    {"type": "error", "message": f"Message is longer than {settings.max_message_length} characters"}
                )
                continue
            client_id = data.get("clientId")
            extra = {"clientId": client_id} if isinstance(client_id, str) and len(client_id) <= 64 else None

            message = await db.add_message(user, text)
            await room.broadcast({"type": "message", "message": message}, sender=ws, sender_extra=extra)
    except WebSocketDisconnect:
        pass
    finally:
        room.leave(ws)
