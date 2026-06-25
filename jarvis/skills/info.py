"""Lightweight informational skills that don't need the network."""

from __future__ import annotations

import datetime
import platform


def current_time() -> str:
    now = datetime.datetime.now()
    return f"It's {now.strftime('%I:%M %p').lstrip('0')}."


def current_date() -> str:
    now = datetime.datetime.now()
    return f"Today is {now.strftime('%A, %B %d, %Y')}."


def system_info() -> str:
    uname = platform.uname()
    parts = [f"{uname.system} {uname.release}", f"machine {uname.node}"]
    try:
        import psutil

        mem = psutil.virtual_memory()
        cpu = psutil.cpu_percent(interval=0.3)
        parts.append(f"CPU at {cpu:.0f} percent")
        parts.append(f"memory at {mem.percent:.0f} percent")
    except Exception:
        pass
    return "System status: " + ", ".join(parts) + "."
