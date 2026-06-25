"""System control skills for Windows (with macOS fallbacks where sensible).

These wrap OS-level actions: launching apps, screenshots, media keys, volume,
and power. Everything returns a short human-readable status string.
"""

from __future__ import annotations

import datetime
import os
import platform
import subprocess

IS_WINDOWS = platform.system() == "Windows"
IS_MAC = platform.system() == "Darwin"

# Friendly name -> Windows launch target. os.startfile resolves these against
# the App Paths registry and PATH, so "notepad", "calc", etc. just work.
WINDOWS_APPS = {
    "notepad": "notepad.exe",
    "calculator": "calc.exe",
    "calc": "calc.exe",
    "paint": "mspaint.exe",
    "explorer": "explorer.exe",
    "file explorer": "explorer.exe",
    "files": "explorer.exe",
    "command prompt": "cmd.exe",
    "cmd": "cmd.exe",
    "powershell": "powershell.exe",
    "task manager": "taskmgr.exe",
    "settings": "ms-settings:",
    "control panel": "control.exe",
    "browser": "https://www.google.com",
    "chrome": "chrome.exe",
    "edge": "msedge.exe",
    "word": "winword.exe",
    "excel": "excel.exe",
    "spotify": "spotify.exe",
}

MAC_APPS = {
    "calculator": "Calculator",
    "calc": "Calculator",
    "finder": "Finder",
    "files": "Finder",
    "safari": "Safari",
    "browser": "Safari",
    "terminal": "Terminal",
    "notes": "Notes",
    "system settings": "System Settings",
}


def _pyautogui():
    try:
        import pyautogui

        return pyautogui
    except Exception:
        return None


def open_application(name: str) -> str:
    """Launch an application by friendly name."""
    name = (name or "").strip().lower()
    if not name:
        return "Which application would you like me to open?"

    if IS_WINDOWS:
        target = WINDOWS_APPS.get(name, f"{name}.exe")
        try:
            if target.startswith(("http", "ms-settings")):
                os.startfile(target)  # type: ignore[attr-defined]
            else:
                os.startfile(target)  # type: ignore[attr-defined]
            return f"Opening {name}."
        except Exception:
            # Last resort: hand it to the shell to resolve.
            try:
                subprocess.Popen(["cmd", "/c", "start", "", target], shell=False)
                return f"Opening {name}."
            except Exception as exc:
                return f"I couldn't open {name}: {exc}"

    if IS_MAC:
        app = MAC_APPS.get(name, name)
        try:
            subprocess.Popen(["open", "-a", app])
            return f"Opening {app}."
        except Exception as exc:
            return f"I couldn't open {app}: {exc}"

    return f"Opening applications isn't supported on {platform.system()} yet."


def take_screenshot() -> str:
    """Capture the screen to the Pictures folder."""
    pyautogui = _pyautogui()
    if pyautogui is None:
        return "I need the pyautogui package to take screenshots."
    pictures = os.path.join(os.path.expanduser("~"), "Pictures")
    os.makedirs(pictures, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    path = os.path.join(pictures, f"jarvis_screenshot_{stamp}.png")
    try:
        pyautogui.screenshot(path)
        return f"Screenshot saved to {path}."
    except Exception as exc:
        return f"I couldn't take the screenshot: {exc}"


def _press_media_key(key: str, friendly: str) -> str:
    pyautogui = _pyautogui()
    if pyautogui is None:
        return "I need the pyautogui package for media control."
    try:
        pyautogui.press(key)
        return friendly
    except Exception as exc:
        return f"Media control failed: {exc}"


def media_play_pause() -> str:
    return _press_media_key("playpause", "Toggling playback.")


def media_next() -> str:
    return _press_media_key("nexttrack", "Skipping to the next track.")


def media_previous() -> str:
    return _press_media_key("prevtrack", "Going to the previous track.")


def volume_up() -> str:
    return _press_media_key("volumeup", "Turning the volume up.")


def volume_down() -> str:
    return _press_media_key("volumedown", "Turning the volume down.")


def volume_mute() -> str:
    return _press_media_key("volumemute", "Muting.")


def lock_screen() -> str:
    """Lock the workstation."""
    if IS_WINDOWS:
        try:
            import ctypes

            ctypes.windll.user32.LockWorkStation()
            return "Locking the screen."
        except Exception as exc:
            return f"I couldn't lock the screen: {exc}"
    if IS_MAC:
        subprocess.Popen(["pmset", "displaysleepnow"])
        return "Locking the screen."
    return "Locking isn't supported on this platform."


def shutdown(restart: bool = False) -> str:
    """Shut down or restart the machine (after a short delay)."""
    action = "restart" if restart else "shut down"
    if IS_WINDOWS:
        flag = "/r" if restart else "/s"
        subprocess.Popen(["shutdown", flag, "/t", "20"])
        return f"The system will {action} in 20 seconds. Say 'cancel shutdown' to abort."
    if IS_MAC:
        verb = "restart" if restart else "shut down"
        subprocess.Popen(["osascript", "-e", f'tell app "System Events" to {verb}'])
        return f"Requesting {action}."
    return f"{action.title()} isn't supported on this platform."


def cancel_shutdown() -> str:
    if IS_WINDOWS:
        subprocess.Popen(["shutdown", "/a"])
        return "Shutdown cancelled."
    return "Nothing to cancel."
