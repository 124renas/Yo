"""The brain: turns natural language into actions and replies.

Primary path uses Claude (tool use) so Jarvis understands free-form requests
and can answer general questions. If no ANTHROPIC_API_KEY is set, it falls back
to a deterministic rule-based parser that still drives every system skill.
"""

from __future__ import annotations

import re

import config
from skills import info, system_control, tasks, web

try:
    import anthropic
except ImportError:  # pragma: no cover
    anthropic = None


SYSTEM_PROMPT = f"""You are {config.ASSISTANT_NAME}, a personal AI assistant for \
Windows and macOS, inspired by the character from the Marvel films.

Persona and communication:
- Calm, articulate, professional, and concise. A touch of dry wit is welcome.
- Keep spoken replies short — one or two sentences. The user hears your words,
  so avoid lists, markdown, code blocks, or long explanations unless asked.

Capabilities: you can open applications and websites, run web searches, take
screenshots, control media playback and volume, lock or power down the machine,
manage to-do items and reminders, and report the time, date, and system status.
Use the provided tools to take real actions. For general questions, answer from
your own knowledge directly without a tool.

Operational rules:
- Prioritise accuracy; if you are unsure, say so.
- If a request is ambiguous, ask a brief clarifying question instead of guessing.
- Only take safe actions within your tools. Confirm before anything disruptive
  (shutdown, restart) unless the user already made the intent explicit.
- Adapt commands for the user's operating system automatically.
"""


# --- Tool schema (mirrors the skills package) --------------------------------
TOOLS = [
    {
        "name": "open_application",
        "description": "Launch a desktop application by its common name "
                       "(e.g. notepad, calculator, chrome, spotify).",
        "input_schema": {
            "type": "object",
            "properties": {"name": {"type": "string", "description": "App name"}},
            "required": ["name"],
        },
    },
    {
        "name": "open_website",
        "description": "Open a website in the default browser by name or URL.",
        "input_schema": {
            "type": "object",
            "properties": {"site": {"type": "string"}},
            "required": ["site"],
        },
    },
    {
        "name": "web_search",
        "description": "Search the web for a query and open the results.",
        "input_schema": {
            "type": "object",
            "properties": {"query": {"type": "string"}},
            "required": ["query"],
        },
    },
    {
        "name": "take_screenshot",
        "description": "Capture the current screen to the Pictures folder.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "media_control",
        "description": "Control media playback or system volume.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["play_pause", "next", "previous",
                             "volume_up", "volume_down", "mute"],
                }
            },
            "required": ["action"],
        },
    },
    {
        "name": "power",
        "description": "Lock, shut down, restart, or cancel a pending shutdown.",
        "input_schema": {
            "type": "object",
            "properties": {
                "action": {"type": "string",
                           "enum": ["lock", "shutdown", "restart", "cancel"]}
            },
            "required": ["action"],
        },
    },
    {
        "name": "add_task",
        "description": "Add an item to the user's to-do list.",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "list_tasks",
        "description": "Read back the user's outstanding to-do items.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "complete_task",
        "description": "Mark a to-do item complete by matching its text.",
        "input_schema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
    {
        "name": "add_reminder",
        "description": "Add a reminder, optionally with a due time formatted "
                       "as 'YYYY-MM-DD HH:MM'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "text": {"type": "string"},
                "when": {"type": "string", "description": "Due time, optional"},
            },
            "required": ["text"],
        },
    },
    {
        "name": "get_info",
        "description": "Report the current time, date, or system status.",
        "input_schema": {
            "type": "object",
            "properties": {
                "what": {"type": "string", "enum": ["time", "date", "system"]}
            },
            "required": ["what"],
        },
    },
]


def _dispatch(name: str, args: dict) -> str:
    """Execute a tool call and return a spoken-friendly result string."""
    if name == "open_application":
        return system_control.open_application(args.get("name", ""))
    if name == "open_website":
        return web.open_website(args.get("site", ""))
    if name == "web_search":
        return web.web_search(args.get("query", ""))
    if name == "take_screenshot":
        return system_control.take_screenshot()
    if name == "media_control":
        action = args.get("action", "")
        return {
            "play_pause": system_control.media_play_pause,
            "next": system_control.media_next,
            "previous": system_control.media_previous,
            "volume_up": system_control.volume_up,
            "volume_down": system_control.volume_down,
            "mute": system_control.volume_mute,
        }.get(action, lambda: "I didn't catch the media action.")()
    if name == "power":
        action = args.get("action", "")
        if action == "lock":
            return system_control.lock_screen()
        if action == "shutdown":
            return system_control.shutdown(restart=False)
        if action == "restart":
            return system_control.shutdown(restart=True)
        if action == "cancel":
            return system_control.cancel_shutdown()
        return "I didn't catch the power action."
    if name == "add_task":
        return tasks.add_task(args.get("text", ""))
    if name == "list_tasks":
        return tasks.list_tasks()
    if name == "complete_task":
        return tasks.complete_task(args.get("text", ""))
    if name == "add_reminder":
        return tasks.add_reminder(args.get("text", ""), args.get("when"))
    if name == "get_info":
        what = args.get("what", "time")
        if what == "date":
            return info.current_date()
        if what == "system":
            return info.system_info()
        return info.current_time()
    return f"I don't know how to {name}."


class Brain:
    def __init__(self) -> None:
        self._client = None
        self._history: list[dict] = []
        if anthropic is not None and config.ANTHROPIC_API_KEY:
            try:
                self._client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)
            except Exception as exc:  # pragma: no cover
                print(f"[brain] Claude unavailable ({exc}); using rule-based mode.")

    @property
    def uses_llm(self) -> bool:
        return self._client is not None

    def handle(self, text: str) -> str:
        """Process a command and return Jarvis's spoken reply."""
        if self._client is None:
            return _rule_based(text)
        try:
            return self._handle_with_claude(text)
        except Exception as exc:  # pragma: no cover
            print(f"[brain] Claude error ({exc}); using rule-based fallback.")
            return _rule_based(text)

    def _handle_with_claude(self, text: str) -> str:
        self._history.append({"role": "user", "content": text})
        # Keep recent turns only, for context retention without unbounded growth.
        self._history = self._history[-config.CONVERSATION_MEMORY_TURNS * 2:]

        reply_text = ""
        while True:
            response = self._client.messages.create(
                model=config.MODEL,
                max_tokens=config.MAX_TOKENS,
                system=SYSTEM_PROMPT,
                tools=TOOLS,
                messages=self._history,
            )
            self._history.append({"role": "assistant", "content": response.content})

            tool_results = []
            for block in response.content:
                if block.type == "text":
                    reply_text += block.text
                elif block.type == "tool_use":
                    result = _dispatch(block.name, block.input or {})
                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": result,
                    })

            if tool_results:
                self._history.append({"role": "user", "content": tool_results})
                continue  # let Claude summarise the tool outcome
            return reply_text.strip() or "Done."


# --- Rule-based fallback -----------------------------------------------------
def _rule_based(text: str) -> str:
    """Deterministic command parser used when no LLM is configured."""
    t = (text or "").strip().lower()
    if not t:
        return "I didn't catch that."

    if t.startswith("open "):
        target = t[5:].strip()
        if target in web.KNOWN_SITES or "." in target or target.endswith(".com"):
            return web.open_website(target)
        return system_control.open_application(target)

    m = re.match(r"(?:search|google|look up)(?: for)? (.+)", t)
    if m:
        return web.web_search(m.group(1))

    if "screenshot" in t or "screen shot" in t:
        return system_control.take_screenshot()

    if "pause" in t or ("play" in t and "music" in t) or t == "play" or t == "pause":
        return system_control.media_play_pause()
    if "next track" in t or "next song" in t or "skip" in t:
        return system_control.media_next()
    if "previous track" in t or "previous song" in t:
        return system_control.media_previous()
    if "volume up" in t or "louder" in t:
        return system_control.volume_up()
    if "volume down" in t or "quieter" in t:
        return system_control.volume_down()
    if "mute" in t:
        return system_control.volume_mute()

    if "lock" in t:
        return system_control.lock_screen()
    if "cancel shutdown" in t or "cancel the shutdown" in t:
        return system_control.cancel_shutdown()
    if "restart" in t or "reboot" in t:
        return system_control.shutdown(restart=True)
    if "shut down" in t or "shutdown" in t or "power off" in t:
        return system_control.shutdown(restart=False)

    m = re.match(r"(?:add|remind me to) (.+?)(?: to my (?:list|tasks))?$", t)
    if t.startswith("remind me"):
        return tasks.add_reminder(re.sub(r"^remind me to ?", "", t))
    if t.startswith("add ") and ("task" in t or "list" in t or "to-do" in t or "todo" in t):
        item = re.sub(r"^add ", "", t)
        item = re.sub(r"(to my )?(to-?do ?list|tasks?|list)$", "", item).strip()
        return tasks.add_task(item)
    if "list" in t and ("task" in t or "to-do" in t or "todo" in t):
        return tasks.list_tasks()
    if t.startswith("done ") or t.startswith("complete "):
        return tasks.complete_task(re.sub(r"^(done|complete) ", "", t))

    if "time" in t:
        return info.current_time()
    if "date" in t or "what day" in t:
        return info.current_date()
    if "system" in t and ("status" in t or "info" in t or "stats" in t):
        return info.system_info()

    if t in ("hello", "hi", "hey"):
        return "Hello. How can I help?"
    if "thank" in t:
        return "You're welcome."
    if t in ("stop", "exit", "quit", "goodbye", "bye"):
        return "__EXIT__"

    return ("I can open apps and sites, search the web, take screenshots, "
            "control media and volume, manage tasks, and tell you the time. "
            "Set an Anthropic API key for full conversation.")
