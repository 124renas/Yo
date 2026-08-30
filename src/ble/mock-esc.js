// A fake motor controller, used by MockTransport.
//
// It speaks real framing over a real register file, so the app can be driven
// end to end — connect, poll, read, write, snapshot, diff, apply a profile —
// with no scooter present. Handy for development, and for checking a tuning
// profile does what you expect before pointing it at hardware.

import { FrameParser, encode, Cmd, Addr, Protocol } from '../proto/frame.js';

const parsers = new Map();

function parserFor(protocol) {
  if (!parsers.has(protocol)) parsers.set(protocol, new FrameParser(protocol));
  return parsers.get(protocol);
}

export function decodeRequest(protocol, bytes) {
  const frames = parserFor(protocol).push(bytes);
  const frame = frames.find((f) => f.checksumOk);
  return frame ?? null;
}

export function buildReply(protocol, req, memory) {
  if (req.cmd === Cmd.READ) {
    const length = req.payload[0] ?? 2;
    const value = memory.get(req.arg);
    const payload = new Uint8Array(length);

    if (value === undefined) {
      // Unmapped address: answer with 0xFF filler, the way a real ESC often
      // does. Discovery relies on being able to tell this apart from real data.
      payload.fill(0xff);
    } else if (typeof value === 'string') {
      payload.set(new TextEncoder().encode(value).slice(0, length));
    } else {
      payload[0] = value & 0xff;
      if (length > 1) payload[1] = (value >> 8) & 0xff;
    }

    return encode({
      protocol,
      src: req.dst,
      dst: protocol === Protocol.NB ? req.src : Addr.APP,
      cmd: Cmd.READ,
      arg: req.arg,
      payload,
    });
  }

  if (req.cmd === Cmd.WRITE || req.cmd === Cmd.WRITE_ACK) {
    memory.set(req.arg, req.payload[0] | (req.payload[1] << 8));
    if (req.cmd === Cmd.WRITE_ACK) {
      return encode({
        protocol,
        src: req.dst,
        dst: protocol === Protocol.NB ? req.src : Addr.APP,
        cmd: Cmd.WRITE_ACK,
        arg: req.arg,
        payload: new Uint8Array([0x01]),
      });
    }
  }
  return null;
}
