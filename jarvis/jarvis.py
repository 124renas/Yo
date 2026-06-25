"""Jarvis — a voice-activated assistant for Windows (and macOS).

Usage:
    python jarvis.py            # voice mode: say "Jarvis" then a command
    python jarvis.py --text     # type commands instead of speaking
    python jarvis.py --once "open notepad"   # run a single command and exit

Voice mode listens continuously for the wake word ("Jarvis" / "Hey Jarvis"),
acknowledges, then captures your command and acts on it.
"""

from __future__ import annotations

import argparse
import sys
import time

import config
from brain import Brain
from skills import tasks
from voice import Listener, Speaker


def _contains_wake_word(text: str) -> bool:
    low = text.lower()
    return any(w in low for w in config.WAKE_WORDS)


def _strip_wake_word(text: str) -> str:
    low = text.lower()
    for w in sorted(config.WAKE_WORDS, key=len, reverse=True):
        idx = low.find(w)
        if idx != -1:
            return (text[:idx] + text[idx + len(w):]).strip(" ,.")
    return text


def _announce_due_reminders(speaker: Speaker) -> None:
    for item in tasks.due_reminders():
        speaker.say(f"Reminder: {item['text']}.")


def run_text_mode(brain: Brain, speaker: Speaker) -> None:
    speaker.say(f"{config.ASSISTANT_NAME} online in text mode. Type a command, or 'quit'.")
    while True:
        try:
            command = input("You: ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not command:
            continue
        reply = brain.handle(command)
        if reply == "__EXIT__":
            speaker.say("Goodbye.")
            break
        speaker.say(reply)
        _announce_due_reminders(speaker)


def run_voice_mode(brain: Brain, speaker: Speaker, listener: Listener) -> None:
    if not listener.available:
        speaker.say("No microphone is available, so I'll switch to text mode.")
        run_text_mode(brain, speaker)
        return

    mode = "with full conversation" if brain.uses_llm else "in command mode"
    speaker.say(f"{config.ASSISTANT_NAME} online {mode}. Say my name when you need me.")

    while True:
        _announce_due_reminders(speaker)
        heard = listener.listen()
        if not heard:
            continue

        if not _contains_wake_word(heard):
            continue

        # The wake word may arrive with the command attached ("Jarvis, what time
        # is it"). If so, act on the remainder directly; otherwise prompt.
        remainder = _strip_wake_word(heard)
        if remainder:
            command = remainder
        else:
            speaker.say(speaker.activation_phrase())
            command = listener.listen()
            if not command:
                speaker.say("I didn't catch that.")
                continue

        print(f"You: {command}")
        reply = brain.handle(command)
        if reply == "__EXIT__":
            speaker.say("Goodbye.")
            break
        speaker.say(reply)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Jarvis voice assistant")
    parser.add_argument("--text", action="store_true", help="text mode (no mic)")
    parser.add_argument("--once", metavar="COMMAND",
                        help="run a single command and exit")
    args = parser.parse_args(argv)

    brain = Brain()
    speaker = Speaker()

    if args.once:
        reply = brain.handle(args.once)
        speaker.say("Goodbye." if reply == "__EXIT__" else reply)
        return 0

    if args.text:
        run_text_mode(brain, speaker)
        return 0

    listener = Listener()
    try:
        run_voice_mode(brain, speaker, listener)
    except KeyboardInterrupt:
        speaker.say("Shutting down.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
