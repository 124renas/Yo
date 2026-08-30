# Protocol notes

Reference for the wire formats the app implements, so the code is checkable
against something rather than taken on faith.

## Framing

Both generations use the same shape: magic header, length, routing, command,
payload, 16-bit little-endian checksum.

### M365 family (plaintext)

```
55 AA <len> <dst> <cmd> <arg> <payload...> <ck_lo> <ck_hi>
```

- `len` = `payload.length + 2` (covers `cmd` and `arg`)
- checksum = `0xFFFF - sum(bytes from len through payload)`

### Ninebot / NB (Mi 3, Mi 4, 4 Lite)

```
5A A5 <len> <src> <dst> <cmd> <arg> <payload...> <ck_lo> <ck_hi>
```

- `len` = `payload.length`
- same checksum rule
- on 2024+ models the whole frame is then AES-encrypted by the session layer

Implemented in `src/proto/frame.js`. `FrameParser` buffers and resyncs on the
magic, because BLE notifications arrive in 20-byte chunks that do not align with
frame boundaries.

## Addresses

| Value  | Device                        |
|--------|-------------------------------|
| `0x20` | ESC — motor controller        |
| `0x21` | BLE module                    |
| `0x22` | BMS — internal battery        |
| `0x23` | External battery              |
| `0x3E` | The app (us)                  |

## Commands

| Value  | Meaning                          |
|--------|----------------------------------|
| `0x01` | Read — payload is a length byte  |
| `0x03` | Write — no acknowledgement       |
| `0x04` | Write with acknowledgement       |

Because `0x03` is silent, `Scooter.write()` always reads the register back
afterwards and records whether it matched. A write that does not read back is
the single strongest signal that an address is wrong.

## Transport

Every generation so far exposes a Nordic-UART-shaped GATT service: one
write(-without-response) characteristic down, one notify characteristic up.
Rather than hardcode UUIDs per model, `src/ble/transport.js` enumerates the
device's services and takes the first pair with that shape, preferring the
profile's `transport.preferService` hint.

Known service UUIDs are listed in `KNOWN_SERVICES` — Web Bluetooth hides any
service not declared up front, so that list has to be a superset.

## Session layer

`src/proto/session.js` sits between framing and transport.

- `PlaintextSession` — pass-through, for M365-generation hardware.
- `NbAesSession` — runs a handshake script from the device profile, derives an
  AES key, then encrypts every outbound frame and decrypts every inbound one.

The handshake is a small declarative script (`send` / `await` / `derive`) rather
than hardcoded logic, so a new model is a JSON change rather than a code change.
See `docs/NEEDED-INFO.md` for the format.

AES lives in `src/proto/aes.js` — a self-contained implementation, because
WebCrypto does not expose ECB and forces PKCS#7 padding on CBC, while this
protocol uses raw unpadded blocks. It is checked against the FIPS-197 vectors in
`tests/aes.test.js`.

## Why the register map is not simply hardcoded

Ninebot renumbered register blocks between generations, and the same address
means different things on different firmwares. The published maps that circulate
online are for the M365 generation. Writing a plausible-looking speed value to
the wrong address on a 4 Lite does not throw an error — it silently modifies
something else.

So the addresses in `src/proto/registers.js` carry a `confidence` field, and the
app refuses to write anything below `derived` unless Expert mode is explicitly
enabled. `derived` means *observed changing on this specific scooter*, via the
snapshot-diff workflow in the Discovery tab.
