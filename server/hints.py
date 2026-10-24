"""Suggested next messages: after the agent answers, the people it answered
get a few buttons under its reply, each asking it to find a kind of person.

They're written by the model for every reply, in the person's language. To
keep them varied, each set is built around angles picked at random here
(taste, work, romance, ...), rather than left to the model's habits.
"""

import json
import random
from typing import Any

HINT_COUNT = 3
MIN_HINTS = 2
MAX_HINT_LENGTH = 60

# What kind of person a hint can ask for. Each set uses a few, picked at random.
ANGLES = [
    "someone who shares their taste (music, films, books, food, ...)",
    "someone worth recommending to their company or team",
    "someone they might be romantically into",
    "a possible cofounder",
    "a mentor a step ahead of them",
    "a friend to hang out with",
    "a partner for a hobby or a sport",
    "someone whose skills complement theirs",
    "a collaborator for a side project",
    "someone to study or learn something with",
    "someone to practice a language with",
    "someone going through the same thing they are",
    "someone who sees things very differently from them",
    "a travel buddy",
    "someone to play games with",
    "an investor or advisor",
    "someone to meet at an event they're at",
    "someone in their field to swap notes with",
    "a creative collaborator (design, music, video, ...)",
    "someone who lives or works nearby",
]

PROMPT = """\
You write suggestion buttons for One House, an open chat room where {agent} \
helps people find other people. After {agent}'s last reply, {who} will see a \
few buttons; tapping one sends its text to {agent} as their next message.

Write {count} of them, one for each of these angles, in this order:
{angles}

- Each asks {agent} to find a kind of person for them, said the way {who} \
would say it: first person and casual.
- Write them in the language of {who}'s latest message, even if earlier \
messages used another one:
<latest>
{latest}
</latest>
- Fit them to what you know about {who} from the conversation and the notes, \
without making anything up. Generic is fine when there's little to go on.
- Short: a few words, under {max_length} characters each.
- Make them clearly different from each other{previous}. Build each around a \
different interest or topic: two hints about the same hobby, field or event \
don't count as different.

The latest messages ("(you)" marks {agent}):
<messages>
{messages}
</messages>
{notes}\
"""

SCHEMA = {
    "type": "object",
    "properties": {"hints": {"type": "array", "items": {"type": "string"}}},
    "required": ["hints"],
    "additionalProperties": False,
}


def prompt(
    *, agent: str, who: list[str], latest: str, messages: str, notes: str | None, previous: list[str]
) -> str:
    angles = random.sample(ANGLES, HINT_COUNT)
    return PROMPT.format(
        agent=agent,
        who=" and ".join(who),
        latest=latest,
        count=HINT_COUNT,
        angles="\n".join(f"{i}. {angle}" for i, angle in enumerate(angles, 1)),
        max_length=MAX_HINT_LENGTH,
        previous=f", and from the last set: {json.dumps(previous, ensure_ascii=False)}" if previous else "",
        messages=messages,
        notes=f"\n{agent}'s notes index:\n<notes_index>\n{notes}\n</notes_index>\n" if notes else "",
    )


def parse(text: str) -> list[str] | None:
    """The hints in the model's JSON, cleaned up; None if fewer than two
    usable ones came back."""
    try:
        raw: Any = json.loads(text).get("hints", [])
    except (json.JSONDecodeError, AttributeError):
        return None
    hints: list[str] = []
    for hint in raw if isinstance(raw, list) else []:
        hint = " ".join(str(hint).split())
        if hint and len(hint) <= MAX_HINT_LENGTH * 2 and hint not in hints:
            hints.append(hint)
    return hints[:HINT_COUNT] if len(hints) >= MIN_HINTS else None
