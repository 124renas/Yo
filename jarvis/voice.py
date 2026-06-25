"""Voice I/O for Jarvis: text-to-speech and speech recognition.

Both layers degrade gracefully. If a microphone or the speech libraries are
missing, Jarvis can still run in text mode (see jarvis.py --text).
"""

from __future__ import annotations

import random

import config

try:
    import pyttsx3
except ImportError:  # pragma: no cover - environment dependent
    pyttsx3 = None

try:
    import speech_recognition as sr
except ImportError:  # pragma: no cover - environment dependent
    sr = None


class Speaker:
    """Wraps pyttsx3 with a preference for a calm British voice."""

    def __init__(self) -> None:
        self._engine = None
        if pyttsx3 is None:
            return
        try:
            self._engine = pyttsx3.init()
            self._engine.setProperty("rate", config.SPEECH_RATE)
            self._engine.setProperty("volume", config.SPEECH_VOLUME)
            self._select_voice()
        except Exception as exc:  # pragma: no cover
            print(f"[voice] TTS unavailable ({exc}); falling back to text output.")
            self._engine = None

    def _select_voice(self) -> None:
        voices = self._engine.getProperty("voices")
        for hint in config.PREFERRED_VOICE_HINTS:
            for voice in voices:
                name = (voice.name or "").lower()
                if hint in name:
                    self._engine.setProperty("voice", voice.id)
                    return

    def say(self, text: str) -> None:
        if not text:
            return
        print(f"{config.ASSISTANT_NAME}: {text}")
        if self._engine is None:
            return
        try:
            self._engine.say(text)
            self._engine.runAndWait()
        except Exception as exc:  # pragma: no cover
            print(f"[voice] TTS error: {exc}")

    @staticmethod
    def activation_phrase() -> str:
        return random.choice(config.ACTIVATION_PHRASES)


class Listener:
    """Wraps speech_recognition with Google Web Speech (no API key required)."""

    def __init__(self) -> None:
        self._recognizer = None
        self._mic = None
        if sr is None:
            return
        try:
            self._recognizer = sr.Recognizer()
            self._recognizer.energy_threshold = config.ENERGY_THRESHOLD
            self._recognizer.dynamic_energy_threshold = True
            self._mic = sr.Microphone()
            with self._mic as source:
                self._recognizer.adjust_for_ambient_noise(source, duration=0.6)
        except Exception as exc:  # pragma: no cover
            print(f"[voice] Microphone unavailable ({exc}); use --text mode.")
            self._recognizer = None
            self._mic = None

    @property
    def available(self) -> bool:
        return self._recognizer is not None and self._mic is not None

    def listen(self) -> str | None:
        """Capture one phrase and return the transcribed text, or None."""
        if not self.available:
            return None
        try:
            with self._mic as source:
                audio = self._recognizer.listen(
                    source,
                    timeout=config.LISTEN_TIMEOUT,
                    phrase_time_limit=config.PHRASE_TIME_LIMIT,
                )
        except sr.WaitTimeoutError:
            return None
        except Exception as exc:  # pragma: no cover
            print(f"[voice] listen error: {exc}")
            return None

        try:
            return self._recognizer.recognize_google(audio)
        except sr.UnknownValueError:
            return None
        except sr.RequestError as exc:
            print(f"[voice] speech service error: {exc}")
            return None
