# Flashing the 4 Lite (the real speed unlock)

The 4 Lite is a Brightway-built scooter. Its speed limit lives in the MCU
firmware, and the firmware is **signature-checked by the Bluetooth chip**, so a
modified image cannot be sent over Bluetooth — the radio rejects anything not
signed with Xiaomi's private key ([RoboCoffee's analysis](https://robocoffee.de/?p=897)).

The way through is the controller's **wired UART**, which talks straight to the
MCU bootloader and bypasses the BLE signature gate. That is what the Flash tab in
this app does, over Web Serial, using a faithful port of ScooterTeam's
[bw-flasher](https://github.com/scooterteam/bw-flasher) DFU protocol.

## What you need

- A **USB-to-TTL serial adapter** — CP2102, CH340 or FTDI, a few dollars. 3.3 V.
- Access to the controller's **UART pads** (TX, RX, GND). This means opening the
  deck. Pinouts are documented on the scooter-hacking forums for the 4 Lite.
- Desktop **Chrome or Edge** (Web Serial). Not Firefox, not mobile, not iOS.
- The **stock firmware `.bin`** for your exact scooter, saved somewhere safe —
  this is your undo.

## Steps

1. **Get the stock firmware.** Download the MCU/DRV `.bin` for the 4 Lite from
   mi-fw-info. Keep an untouched copy.
2. **Patch it.** Upload the stock `.bin` to [bw-patcher](https://github.com/scooterteam/bw-patcher)
   (or its hosted GUI), choose the speed-limit patch, and set the limits you want.
   For the 4 Lite the "remove sport limit" sets **36.7 km/h**, and Drive is
   settable separately. Download the patched `.bin`.
3. **Wire the adapter.** Power off. Connect adapter GND → controller GND,
   adapter TX → controller RX, adapter RX → controller TX. Double-check it is a
   3.3 V adapter.
4. **Flash.** Open the app → **Flash** tab. Load the patched `.bin` (it will
   confirm it's a valid Brightway image and find the auth tables). Power the
   scooter on. Click **Connect serial adapter**, pick the port, then **Flash
   firmware**. Watch the progress bar and log; do not disconnect until it says
   the new firmware is active.

## If it goes wrong

- **"Auth mismatch (BLE_KEY)"** — the app read a UID that doesn't match the
  firmware's auth tables. Usually a wiring/among-noise issue or the wrong `.bin`
  for this exact model. Nothing was written; recheck wiring and the firmware file.
- **Stopped mid-flash** — the controller keeps the old firmware until the final
  verify/activate, so a clean abort before then is safe. If activate did run and
  the scooter misbehaves, re-flash the **stock** `.bin` you saved.
- **No response at all** — check TX/RX aren't swapped, GND is shared, the scooter
  is powered on, and the adapter's driver is installed.

## Why not just do it over Bluetooth?

Because it cannot be done. The BLE OTA path verifies a Xiaomi signature on the
firmware before accepting it, and that key is not public. This isn't a missing
feature — it's a deliberate wall, and the wired path exists precisely to get
around it. Any tool claiming to flash custom firmware to a 4 Lite over Bluetooth
is mistaken about which chip does what.

## Credit

The DFU protocol, the challenge/response auth, and the firmware patches are the
work of [ScooterTeam](https://github.com/scooterteam) (bw-flasher, bw-patcher,
CC BY-NC-SA 4.0) and the reverse-engineering documented by
[RoboCoffee](https://robocoffee.de/). This app ports their flashing protocol to
run in the browser; it does not replace bw-patcher, which you still use to
produce the patched image.
