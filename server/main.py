import asyncio
import json
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Query, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

import achievements
from agent import AGENT_ID, Agent
from config import settings
from db import Database, User
from room import Room, user_json

HELLO_TIMEOUT_SECONDS = 10

db = Database(settings.database_file)
room = Room()
agent: Agent | None = None


@asynccontextmanager
async def lifespan(_: FastAPI):
    global agent
    await db.connect()
    agent = Agent(
        db,
        room,
        name=settings.agent_name,
        model=settings.agent_model,
        context_messages=settings.agent_context_messages,
        api_key=settings.anthropic_api_key,
        memory_dir=settings.memory_dir,
        ingest_every=settings.memory_ingest_every,
        lint_every=settings.memory_lint_every,
    )
    await agent.start()
    yield
    await agent.close()
    agent = None
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
    for_user: str | None = Query(
        None, alias="for", max_length=64, description="Only this user's messages and the agent's replies to them"
    ),
) -> dict[str, Any]:
    """Chat history, newest first by page; each page is ordered oldest-first."""
    return await db.messages_before(before, limit or settings.history_page_size, for_user)


async def _greet(ws: WebSocket, agent: Agent, user: User) -> None:
    """Sends the welcome notes to one client, one after another, with the
    pauses of someone typing them."""
    try:
        for i, note in enumerate(agent.greeting(user)):
            if i:
                await asyncio.sleep(agent.typing_time(note["text"]))
            await ws.send_json({"type": "private", "message": note})
    except Exception:
        pass  # They left before it was done.


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

    client → {"type": "hello", "token": "<saved token or null>", "history"?: "mine"}   (first frame;
              "mine": the history in welcome is only my messages and the agent's replies to me)
    server → {"type": "welcome", "user": {...}, "token": "...", "history": {...},
              "online": [{...}], "users": [{...}], "agent": {...} | null, "agentTyping": bool,
              "agentReplyTo": ["<user id>", ...], "hints": {...} | null, "achievements": ["<key>", ...]}
              (users: everyone who has ever joined, most recently seen first;
              achievements: the keys I've earned, see achievements.py)
    client → {"type": "send", "text": "...", "clientId": "..."}
    server → {"type": "message", "message": {...}, "clientId"?: "..."}   (to everyone)
    server → {"type": "message", "message": {...}}   (the agent's reply, to everyone;
              its "replyTo" lists the ids of the people it was answering)
    server → {"type": "private", "message": {"key": "...", ..., "hints"?: [...]}}
              (just this client, not stored; hints are suggested replies to show under it.
              The welcome notes come as several of these, a moment apart)
    server → {"type": "rename", "user": {...}}   (to everyone, when the agent renames someone)
    server → {"type": "typing", "typing": bool, "replyTo": [...]}
              (to everyone: the agent started / finished answering, and whom)
    server → {"type": "presence", "users": [{...}]}   (to everyone, when who's online changes)
    server → {"type": "hints", "messageId": n, "for": [...], "hints": ["...", ...]}
              (just the people the agent's reply #n answered: suggested next messages)
    server → {"type": "achievement", "key": "..."}   (just this person, on each of their tabs:
              they've just earned it)
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
    room.join(ws, user)
    greeting: asyncio.Task[None] | None = None
    try:
        mine = hello.get("history") == "mine"
        history = await db.messages_before(None, settings.history_page_size, user.id if mine else None)
        await ws.send_json(
            {
                "type": "welcome",
                "user": user_json(user),
                "token": token,
                "history": history,
                "online": [user_json(u) for u in room.online()],
                "users": [user_json(u) for u in await db.list_users(exclude=AGENT_ID)],
                "agent": user_json(agent.user) if agent is not None else None,
                "agentTyping": agent is not None and agent.typing,
                "agentReplyTo": agent.reply_to if agent is not None else [],
                "hints": agent.hints if agent is not None and agent.hints and user.id in agent.hints["for"] else None,
                "achievements": await db.achievements(user.id),
            }
        )
        if agent is not None:
            greeting = asyncio.create_task(_greet(ws, agent, user))
        await room.sync_presence()

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
            if achievements.shares_link(text):
                await achievements.award(db, room, user.id, achievements.PROFILE)
            if agent is not None:
                agent.notify()
    except WebSocketDisconnect:
        pass
    finally:
        if greeting is not None:
            greeting.cancel()
        room.leave(ws)
