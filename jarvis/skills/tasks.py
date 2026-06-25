"""Task management: a simple persistent to-do / reminder list.

Stored as JSON so it survives restarts. Reminders carry an optional due time
that the main loop can poll.
"""

from __future__ import annotations

import datetime
import json
import os

import config

_REMINDER_FMT = "%Y-%m-%d %H:%M"


def _load() -> list[dict]:
    if not os.path.exists(config.TASKS_FILE):
        return []
    try:
        with open(config.TASKS_FILE, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except (json.JSONDecodeError, OSError):
        return []


def _save(items: list[dict]) -> None:
    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(config.TASKS_FILE, "w", encoding="utf-8") as fh:
        json.dump(items, fh, indent=2)


def add_task(text: str) -> str:
    """Add an item to the to-do list."""
    text = (text or "").strip()
    if not text:
        return "What should I add to your list?"
    items = _load()
    items.append({"text": text, "done": False, "type": "task",
                  "created": datetime.datetime.now().isoformat()})
    _save(items)
    return f"Added '{text}' to your list."


def list_tasks() -> str:
    """Read back outstanding tasks."""
    items = [i for i in _load() if not i.get("done") and i.get("type") != "reminder"]
    if not items:
        return "Your task list is empty."
    lines = [f"{n}. {i['text']}" for n, i in enumerate(items, 1)]
    return "Here's your list. " + "; ".join(lines) + "."


def complete_task(text: str) -> str:
    """Mark a task done by matching its text."""
    text = (text or "").strip().lower()
    items = _load()
    for item in items:
        if not item.get("done") and text in item["text"].lower():
            item["done"] = True
            _save(items)
            return f"Marked '{item['text']}' as done."
    return f"I couldn't find a task matching '{text}'."


def add_reminder(text: str, when: str | None = None) -> str:
    """Add a reminder, optionally with a due time (YYYY-MM-DD HH:MM)."""
    text = (text or "").strip()
    if not text:
        return "What would you like me to remind you about?"
    items = _load()
    entry = {"text": text, "done": False, "type": "reminder",
             "created": datetime.datetime.now().isoformat(), "due": when}
    items.append(entry)
    _save(items)
    if when:
        return f"I'll remind you to {text} at {when}."
    return f"Reminder noted: {text}."


def due_reminders() -> list[dict]:
    """Return reminders whose due time has passed and mark them fired."""
    now = datetime.datetime.now()
    items = _load()
    fired = []
    changed = False
    for item in items:
        if item.get("type") != "reminder" or item.get("done"):
            continue
        due = item.get("due")
        if not due:
            continue
        try:
            due_dt = datetime.datetime.strptime(due, _REMINDER_FMT)
        except ValueError:
            continue
        if due_dt <= now:
            item["done"] = True
            fired.append(item)
            changed = True
    if changed:
        _save(items)
    return fired
