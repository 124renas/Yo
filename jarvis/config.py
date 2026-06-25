"""Central configuration for Jarvis.

Anything you'd want to tweak lives here. Secrets (the Anthropic API key) are
read from the environment, never hard-coded.
"""

import os

# --- Persona -----------------------------------------------------------------
ASSISTANT_NAME = "Jarvis"
WAKE_WORDS = ("jarvis", "hey jarvis")

# Spoken when the wake word is detected, before listening for a command.
ACTIVATION_PHRASES = ("Yes?", "At your service.", "Go ahead.", "Listening.")

# --- Voice (text-to-speech) --------------------------------------------------
# pyttsx3 uses Windows SAPI5 voices. We prefer a calm British voice; these are
# substrings matched against installed voice names (case-insensitive).
PREFERRED_VOICE_HINTS = ("hazel", "george", "susan", "british", "english (great britain)")
SPEECH_RATE = 175          # words per minute
SPEECH_VOLUME = 1.0        # 0.0 - 1.0

# --- Speech recognition ------------------------------------------------------
# Seconds of silence that ends a phrase, and how long we wait for speech.
PHRASE_TIME_LIMIT = 8
LISTEN_TIMEOUT = 6
# Energy threshold auto-calibrates, but this is the starting point.
ENERGY_THRESHOLD = 300

# --- Brain (LLM) -------------------------------------------------------------
# Claude powers natural-language understanding and general Q&A. Without a key,
# Jarvis falls back to a built-in rule-based command parser (still useful for
# system control, just no free-form conversation).
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY")
MODEL = "claude-opus-4-8"
MAX_TOKENS = 1024
# How many past turns to keep for context retention.
CONVERSATION_MEMORY_TURNS = 12

# --- Storage -----------------------------------------------------------------
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
TASKS_FILE = os.path.join(DATA_DIR, "tasks.json")

# --- Behaviour ---------------------------------------------------------------
# When True, Jarvis confirms before potentially disruptive actions
# (shutdown, restart, closing apps).
CONFIRM_DESTRUCTIVE_ACTIONS = True
