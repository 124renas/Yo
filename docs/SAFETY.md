# Safety and legality

Short version: the scooter is yours and modifying it is your call. These are the
things worth knowing before you do, and the reasoning behind the limits the app
enforces on itself.

## What actually changes at higher speeds

The 4 Lite's brakes (drum rear plus regenerative e-ABS front), 8.5in tyres and
suspension geometry are specified around its 25 km/h stock limit.

- **Braking distance scales with the square of speed.** 32 km/h is ~1.6× the
  stock speed, so roughly 2.6× the kinetic energy and roughly double the stopping
  distance — on a braking system that was not sized for it.
- **Motor and controller heat scale sharply with speed.** Sustained full throttle
  above stock will run the controller hotter and, on a long ride, may trigger
  thermal cutback — which arrives as an abrupt loss of power.
- **Range drops faster than you would expect**, since drag rises with the cube of
  speed. Expect meaningfully less than the rated range.
- **Tyre failure gets worse, not just more likely.** A front tyre deflating at
  30 km/h on 8.5in wheels is not a recoverable event.

Wear a helmet. Gloves too — hands go down first.

## Legality

In most of Europe and the UK, private e-scooters are capped by law at 20–25 km/h
for any use on public roads, paths or cycle lanes, and exceeding that cap takes
the vehicle out of its legal class entirely — which typically also voids
insurance. **Raised limits are for private land.** Check your own jurisdiction;
the rules vary and change.

Modifying the firmware voids the manufacturer's warranty.

## What the app does to keep you out of trouble

- **Nothing is written to an unconfirmed address.** Addresses carried over from
  the older M365 generation are marked `candidate` and blocked. Only addresses
  you have confirmed on your own scooter via snapshot-diff are `derived` and
  freely writable. Expert mode overrides this deliberately and loudly.
- **A hard ceiling of 32 km/h**, from the device profile. This is the app's
  refusal point, not a hardware limit.
- **Every write is read back** and flagged if it does not match. Applying a
  profile stops at the first write that fails to verify rather than continuing.
- **Every write is logged with its previous value**, and *Revert everything*
  restores them in reverse order.
- **Nothing leaves your device.** No network calls, no telemetry. Confirmed
  register addresses are kept in your browser's local storage.

## If something goes wrong

- **Scooter behaves oddly after a write** → *Revert everything* on the Speed tab.
- **App closed before reverting** → the change log is per-session, so this is the
  case to avoid; export the log before closing if you have written anything you
  are unsure about. Re-applying the **Stock (EU)** profile restores factory
  limits.
- **Scooter will not connect at all afterwards** → power-cycle it, and try
  connecting with the official Xiaomi Home app. This app only writes to
  configuration registers; it does not touch firmware, so a full brick from
  normal use is not an expected failure mode.
- **A write did not verify** → do not retry it at a different value. Treat the
  address as wrong and go back to Discovery.
