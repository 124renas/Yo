# What I need from your scooter

The app is complete except for two model-specific pieces that cannot be guessed
safely. Both come off your own scooter. Work through them in order — step 1 is
five minutes, step 2 is the fiddly one and is only needed for the encrypted
models.

---

## 1. The register map (needed on every model)

**What it is:** which register address holds the Sport/Drive/Eco speed limit on
*your* firmware. The built-in addresses (`0x71`–`0x76`) are inherited from the
older M365 generation. They may well be right on a 4 Lite, but nobody has
confirmed it, and writing a speed value to the wrong address does not fail
loudly — it writes into whatever else lives there.

**How to get it:** this is what the Discovery tab is for.

1. Connect (real scooter, not the simulator).
2. **Sweep** `0x00`–`0xFF` on the ESC. Takes a couple of minutes.
3. Hit **Snapshot A**.
4. Leave the app connected if you can; otherwise disconnect, and in the
   **official Xiaomi Home app** change the drive mode (Sport → Drive), or change
   the speed limit if your firmware exposes one. Then come back.
5. Hit **Snapshot B**, then **Diff**.
6. The diff lists every address that moved. Find the row whose numbers match
   what you changed — if you went from Sport 25 to Drive 20, look for a `25 → 20`.
   That is your register. Press **This is it** and the app remembers it.

Once an address is confirmed this way it is marked `derived`, the write block
lifts, and you no longer need Expert mode.

**What to send me:** the file from **Export → Download discovery JSON**. It
contains the sweep, both snapshots and the diff. With that I can fold a verified
address map for the 4 Lite 2nd gen into `src/proto/registers.js` so nobody else
has to repeat the exercise.

---

## 2. The BLE handshake (needed on 2024+ models only)

**What it is:** the 4-series negotiates an AES session key when it connects, and
ignores any frame that is not encrypted with it. The app has the full AES
implementation and a handshake interpreter — what is missing is the constants:
which bytes get exchanged, and how the key is derived from them.

**How to tell you need this:** connecting shows *"Encrypted session not
configured"*. The Bluetooth link is fine; the scooter just will not answer.

**How to capture it** (Android, no root needed):

1. Settings → About phone → tap **Build number** 7 times to enable Developer
   options.
2. Developer options → enable **Enable Bluetooth HCI snoop log**.
3. Toggle Bluetooth off and on.
4. Open the official Xiaomi Home app, connect to the scooter, let it sit for
   ~20 seconds, change a setting, disconnect.
5. Developer options → **Bug report** → *Interactive*. It produces a zip.
   The log is inside at `FS/data/misc/bluetooth/logs/btsnoop_hci.log`
   (path varies a little by vendor — on some phones it lands directly in
   `/sdcard/btsnoop_hci.log`).

**What to send me:** that `btsnoop_hci.log`, plus:

- ESC / BLE / BMS firmware versions (Xiaomi Home → scooter → About)
- The scooter's serial number, **or** just its first 4 and last 4 characters —
  the serial is part of the key derivation on some firmwares, so I need to know
  its *shape*, not necessarily the whole thing
- The BLE name it advertises (e.g. `MISc-1234`)

⚠️ A snoop log contains everything your phone's Bluetooth did while recording —
including other paired devices. Record a short session with as little else
connected as possible, and treat the file as personal data.

**What I do with it:** identify the handshake frames and key derivation, then
fill in the two arrays in `profiles/mi4lite-gen2.json`:

```json
"handshake": [
  { "op": "send",   "parts": ["hex:5AA5...", "random:16"], "store": "appRandom" },
  { "op": "await",  "match": "5AA5", "store": "devRandom", "offset": 7, "length": 16 },
  { "op": "derive", "into": "sessionKey", "parts": ["$appRandom", "$devRandom"],
    "with": "appRandom", "transform": "aes-encrypt" }
],
"keyRecipe": ["$sessionKey"]
```

No code changes needed — the interpreter in `src/proto/session.js` runs whatever
the profile describes.

---

## Faster alternative for step 2

If capturing an HCI log is more hassle than it's worth: the ScooterHacking
project has already reverse-engineered this handshake for several Ninebot/Xiaomi
models. If you can find the constants for the 4 Lite 2nd gen from a published
source, drop them straight into the profile in the format above and the app will
work without any capture at all.
