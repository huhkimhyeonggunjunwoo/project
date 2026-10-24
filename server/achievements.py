"""Achievements: a few first steps each person can tick off, shown in their
sidebar. They're earned by doing things in the room, never by asking:

- profile: they shared a link to a profile of theirs (LinkedIn, GitHub, ...).
- match: after that, the agent looked through everyone to find them people.
- rename: the agent changed their name for them.
"""

import re

from db import Database
from room import Room

PROFILE = "profile"
MATCH = "match"
RENAME = "rename"

# A web link, or a profile on a well-known site written without "https://".
LINK = re.compile(
    r"https?://\S+"
    r"|\b(?:www\.)?(?:linkedin\.com|github\.com|instagram\.com|x\.com|twitter\.com|threads\.net"
    r"|behance\.net|dribbble\.com|medium\.com)/\S+",
    re.IGNORECASE,
)


def shares_link(text: str) -> bool:
    """Whether a message has a link in it."""
    return LINK.search(text) is not None


async def award(db: Database, room: Room, user_id: str, key: str) -> None:
    """Gives someone an achievement and, if it's new, tells their open tabs."""
    if await db.award(user_id, key):
        await room.send_to([user_id], {"type": "achievement", "key": key})
