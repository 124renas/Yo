# SCHEDULE ZERO

A **Schedule 1–style management / tycoon game**, inspired by the TVGS title.
The original is a first-person 3D empire-builder; this is a focused, fully
playable browser take on its core loop — **produce, sell, manage heat, expand** —
that runs with zero dependencies. Just open the file.

> ⚠️ This is a fictional satirical business sim. "Product" is abstract; the game
> is about the economy/management loop, not instructions for anything real.

## Play it

Open `index.html` in any modern browser. That's it — no build, no server.

```
git clone <repo>
cd Yo
# double-click index.html, or:
python3 -m http.server   # then visit http://localhost:8000
```

Your progress autosaves to the browser's `localStorage`.

## How it works

The game runs **day by day**. Each turn you act, then hit **End Day** (or press
`Space`) to advance time, let your crew work, trigger events, and face the
police-bust check.

| System | What it does |
| --- | --- |
| **🌱 Lab** | Buy supplies, plant batches in grow stations, wait for them to mature, then harvest packaged units into your stash. |
| **🤝 Market** | Sell directly to walk-up customers. Bigger buyers unlock as reputation grows, but each sale adds **heat**. |
| **👥 Crew** | Hire **dealers** to auto-sell inventory for a cut, and **lawyers/cleaners** to shed heat. Miss payroll and they walk. |
| **🛒 Upgrades** | Permanent boosts: more stations, faster grows, better yield/quality, more storage, bust resistance, faster heat decay. |
| **📊 Stats** | Career earnings, units sold, days survived, times raided. |

### The tension
- **Heat** rises with every sale and large operation. Keep it low.
- High heat → rising chance of a **police raid** that seizes cash and product.
- Heat decays daily; lawyers, cleaners, and the Laundromat upgrade speed that up.
- Three raids with nothing left to your name = **game over**.

### Progression
Reputation unlocks stronger strains (higher value), bigger customers, and better
crew. Reinvest profits into upgrades to scale from a single backyard station to a
full warehouse operation.

## Files
- `index.html` — layout & screens
- `style.css` — styling/theme
- `game.js` — all game logic (state, production, market, crew, upgrades, day loop, save/load)

## Controls
- **Space / Enter** — End Day
- **Save** — manual save (also autosaves each day)
- **Menu** — back to title screen
