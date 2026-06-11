"use strict";
// Asterisk AudioSocket server (TCP).
//
// AudioSocket is Asterisk's simplest bidirectional media transport: a plain TCP
// connection carrying 8 kHz, 16-bit, mono, signed-linear ("slin") audio. We use
// it to replace Twilio Media Streams as the audio pipe for the AI bot.
//
// Wire format — each message is a TLV frame:
//   [ type : 1 byte ][ length : 2 bytes big-endian ][ payload : length bytes ]
//
//   0x00  Terminate / hangup            (no payload)
//   0x01  UUID                          (16-byte channel UUID, sent first)
//   0x03  Error                         (1-byte code)
//   0x10  Audio                         (slin: 16-bit LE samples, ~320 B/20 ms)
//
// On connect, Asterisk sends the 0x01 UUID frame identifying which call this is
// (the UUID we assigned when creating the externalMedia/AudioSocket channel via
// ARI). We then emit a "call" event so the orchestrator can bind this media
// pipe to the right session.
//
// This module is transport only — it knows nothing about Deepgram/ElevenLabs.
// The orchestrator wires conn.onAudio()/conn.writeSlin() into the pipeline.

const net = require("net");
const { EventEmitter } = require("events");
const { ulawBufToSlin, slinBufToUlaw } = require("../utils/g711");
const logger = require("../utils/logger");

const FRAME_TYPE = { HANGUP: 0x00, UUID: 0x01, ERROR: 0x03, AUDIO: 0x10 };
const MAX_PAYLOAD = 65535;

function uuidBytesToString(buf) {
  const h = buf.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

class AudioSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.id = null;          // channel UUID (string) once received
    this.closed = false;
    this._buf = Buffer.alloc(0);

    socket.on("data", (chunk) => this._onData(chunk));
    socket.on("close", () => this._onClose());
    socket.on("error", (e) => { logger.warn(`[AudioSocket] socket error: ${e.message}`); this._onClose(); });
  }

  _onData(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    // Drain as many complete frames as are buffered.
    while (this._buf.length >= 3) {
      const type = this._buf[0];
      const len = this._buf.readUInt16BE(1);
      if (this._buf.length < 3 + len) break;          // wait for the rest
      const payload = this._buf.subarray(3, 3 + len);
      this._buf = this._buf.subarray(3 + len);
      this._handleFrame(type, payload);
    }
  }

  _handleFrame(type, payload) {
    switch (type) {
      case FRAME_TYPE.UUID:
        this.id = uuidBytesToString(payload);
        this.emit("id", this.id);
        break;
      case FRAME_TYPE.AUDIO:
        // slin 16-bit LE — hand it up as-is; orchestrator converts to µ-law.
        this.emit("audio", payload);
        break;
      case FRAME_TYPE.HANGUP:
        this.emit("hangup");
        this._onClose();
        break;
      case FRAME_TYPE.ERROR:
        logger.warn(`[AudioSocket ${this.id}] error frame code=${payload[0]}`);
        break;
      default:
        // Unknown frame type — ignore.
        break;
    }
  }

  /** Write one slin frame (16-bit LE) back to Asterisk -> the caller hears it. */
  writeSlin(slinBuf) {
    if (this.closed || !slinBuf?.length) return;
    for (let off = 0; off < slinBuf.length; off += MAX_PAYLOAD) {
      const part = slinBuf.subarray(off, Math.min(off + MAX_PAYLOAD, slinBuf.length));
      const header = Buffer.allocUnsafe(3);
      header[0] = FRAME_TYPE.AUDIO;
      header.writeUInt16BE(part.length, 1);
      try { this.socket.write(Buffer.concat([header, part])); } catch { }
    }
    this._txFrames = (this._txFrames || 0) + 1;
    if (this._txFrames === 1) logger.info(`[AudioSocket ${this.id}] TX first frame (${slinBuf.length}B slin)`);
    else if (this._txFrames % 250 === 0) logger.info(`[AudioSocket ${this.id}] TX ${this._txFrames} frames`);
  }

  /** Convenience: write a µ-law frame (what ElevenLabs already produces). */
  writeUlaw(ulawBuf) {
    if (!ulawBuf?.length) return;
    this.writeSlin(ulawBufToSlin(ulawBuf));
  }

  /** Tell Asterisk to hang up this channel. */
  hangup() {
    if (this.closed) return;
    try {
      const header = Buffer.from([FRAME_TYPE.HANGUP, 0x00, 0x00]);
      this.socket.write(header);
      this.socket.end();
    } catch { }
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

class AudioSocketServer extends EventEmitter {
  constructor() {
    super();
    this.server = null;
  }

  listen(port = 9092, host = "127.0.0.1") {
    this.server = net.createServer((socket) => {
      socket.setNoDelay(true);
      const conn = new AudioSocketConnection(socket);
      // Surface the connection once we know which call it is.
      conn.once("id", (id) => {
        logger.info(`[AudioSocket] call connected id=${id}`);
        this.emit("call", conn);
      });
    });
    this.server.listen(port, host, () => {
      logger.info(`[AudioSocket] listening on ${host}:${port}`);
    });
    return this;
  }

  close() { try { this.server?.close(); } catch { } }
}

module.exports = { AudioSocketServer, AudioSocketConnection };
