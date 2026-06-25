"""Web skills: open sites and run searches in the default browser."""

from __future__ import annotations

import urllib.parse
import webbrowser

# Common shortcuts so "open youtube" goes straight to the site.
KNOWN_SITES = {
    "google": "https://www.google.com",
    "youtube": "https://www.youtube.com",
    "gmail": "https://mail.google.com",
    "github": "https://github.com",
    "maps": "https://maps.google.com",
    "news": "https://news.google.com",
    "weather": "https://www.weather.com",
    "wikipedia": "https://www.wikipedia.org",
}


def open_website(site: str) -> str:
    """Open a website by name or URL."""
    site = (site or "").strip().lower()
    if not site:
        return "Which site would you like me to open?"

    if site in KNOWN_SITES:
        url = KNOWN_SITES[site]
    elif site.startswith(("http://", "https://")):
        url = site
    elif "." in site:
        url = f"https://{site}"
    else:
        url = f"https://{site}.com"

    webbrowser.open(url)
    return f"Opening {url}."


def web_search(query: str) -> str:
    """Run a Google search for the query."""
    query = (query or "").strip()
    if not query:
        return "What would you like me to search for?"
    url = "https://www.google.com/search?q=" + urllib.parse.quote(query)
    webbrowser.open(url)
    return f"Here are the search results for {query}."
