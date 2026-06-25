# Jarvis — Voice Assistant for Windows

A voice-activated personal assistant inspired by Jarvis. Say **"Jarvis"** (or
**"Hey Jarvis"**), then give a command. It understands natural language, controls
your PC, manages tasks, and answers questions — with a calm, concise British voice.

## Features

- **Wake word** — listens for "Jarvis" / "Hey Jarvis", then acts on your command.
- **Natural language understanding** — powered by Claude when an API key is set;
  otherwise a built-in command parser still drives every system action.
- **System control** — open apps, take screenshots, control media playback and
  volume, lock the screen, shut down / restart.
- **Web** — open websites, run web searches in your default browser.
- **Task management** — add/list/complete to-dos and set reminders.
- **Info** — time, date, and live system status (CPU / memory).
- **Context retention** — remembers recent turns for natural follow-ups.
- **Cross-platform** — built for Windows, with macOS fallbacks for most actions.

## Quick start (Windows)

1. Install **Python 3.10+** (tick "Add Python to PATH" during install).
2. Install dependencies:
   ```
   pip install -r requirements.txt
   ```
   If `PyAudio` fails to build:
   ```
   pip install pipwin
   pipwin install pyaudio
   ```
3. *(Optional, recommended)* Enable full conversation by setting your key:
   ```
   setx ANTHROPIC_API_KEY "your-key-here"
   ```
   (Open a new terminal afterwards so the variable takes effect.)
4. Run it:
   ```
   run_jarvis.bat
   ```
   or `python jarvis.py`.

## Usage

```
python jarvis.py            # voice mode (default)
python jarvis.py --text     # type commands — no microphone needed
python jarvis.py --once "open notepad"   # run one command and exit
```

### Example commands

- "Jarvis, what time is it?"
- "Jarvis, open Spotify."
- "Hey Jarvis, search for the weather in London."
- "Jarvis, take a screenshot."
- "Jarvis, next track." / "volume up" / "mute"
- "Jarvis, add buy milk to my to-do list."
- "Jarvis, remind me to call mum."
- "Jarvis, lock the screen."

With an API key set, you can also just talk naturally — "Jarvis, I need to jot
down that the deck is due Friday" — and it figures out the right action.

## Project layout

```
jarvis/
  jarvis.py            # entry point + wake-word loop
  brain.py             # NLU: Claude tool-use, with a rule-based fallback
  voice.py             # speech recognition (STT) + British text-to-speech
  config.py            # all tunable settings
  skills/
    system_control.py  # apps, screenshots, media, volume, power
    web.py             # websites + search
    tasks.py           # to-dos and reminders (JSON-persisted)
    info.py            # time, date, system status
  requirements.txt
  run_jarvis.bat       # Windows launcher
```

## Notes

- Speech recognition uses Google's free Web Speech API (no key, needs internet).
- Text-to-speech is fully offline via Windows SAPI5; it prefers a British voice
  (e.g. "Hazel"/"George") if one is installed.
- Without `ANTHROPIC_API_KEY`, Jarvis runs in command mode — all system controls
  work, but free-form conversation and general Q&A are disabled.
- Disruptive actions (shutdown/restart) run on a 20-second delay; say
  "cancel shutdown" to abort.
