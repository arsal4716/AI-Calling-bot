const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { createServer } = require("http");
const WebSocket = require("ws");
const path = require("path");
dotenv.config();

const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const campaignRoutes = require("./routes/campaignRoutes");
const voiceCloneRoutes = require("./routes/voiceCloneRoutes");
const userRoutes = require("./routes/userRoutes");
const dashBoard = require("./routes/dashboardRoutes");
const customVoiceRoutes = require('./routes/customVoiceRoutes');
const dialerRoutes = require('./routes/dialerRoutes');
const callLogRoutes = require('./routes/callLogRoutes');
const { initDialerQueueService } = require("./services/dialerQueueSingleton");

const { errorHandler } = require("./utils/errorHandler");
const MediaStreamHandler = require("./websockets/mediaStreamHandler");

// ── Asterisk-native call transport (Twilio fully removed) ──────────────────
const { AudioSocketServer } = require("./websockets/AudioSocketServer");
const TwilioCompatAdapter = require("./websockets/TwilioCompatAdapter");
const AriService = require("./services/AriService");
const Campaign = require("./models/Campaign");
const CallLog = require("./models/callLogModel");

const app = express();
const httpServer = createServer(app);
const wss = new WebSocket.Server({ noServer: true });

// Kept for completeness; no external media WS is used now that Twilio is gone.
httpServer.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

const { init: initSocketIO } = require('./socketManager');
const io = initSocketIO(httpServer);

connectDB();

app.set("trust proxy", 1);

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
  }),
);
app.use(
  cors({
    origin: true,
    credentials: true,
  }),
);
app.use(
  helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "base-uri": ["'self'"],
        "object-src": ["'none'"],
        "style-src": ["'self'", "'unsafe-inline'"],
        "img-src": ["'self'", "data:", "blob:"],
        "font-src": ["'self'", "data:"],
        "connect-src": ["'self'", "https:", "wss:"],
        "media-src": ["'self'", "blob:"],
      },
    },
    crossOriginResourcePolicy: { policy: "same-site" },
  }),
);

app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.use("/api/auth", authRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/voices", voiceCloneRoutes);
app.use("/api/users", userRoutes);
app.use("/api/dashboard", dashBoard);
app.use('/api/custom-voices', customVoiceRoutes);
app.use('/api/call-logs', callLogRoutes);
app.use('/api/dialer', dialerRoutes);

app.use(express.static(path.join(__dirname, "frontend/build")));
app.get(/^\/(?!api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, "frontend/build", "index.html"));
});

wss.on("close", () => console.log("WebSocket server closed"));

const mediaHandler = new MediaStreamHandler(wss);
initDialerQueueService();

// ── Asterisk-native call transport (replaces Twilio Media Streams) ─────────
// VICIdial → Asterisk exten 77777 → Stasis(ai-bot) → AriService.
// AriService answers the caller, reads the REAL customer number, bridges in an
// AudioSocket leg, and TwilioCompatAdapter feeds it to MediaStreamHandler so
// the entire conversation engine runs unchanged. Transfer is native via ARI.
const audioServer = new AudioSocketServer().listen(
  Number(process.env.AUDIOSOCKET_PORT || 9092),
  process.env.AUDIOSOCKET_BIND || "127.0.0.1"
);
const ari = new AriService();
mediaHandler.ariService = ari;

// audiosocket uuid -> { callLogId, channelId } (set on StasisStart, consumed
// when the matching AudioSocket connection arrives).
const pendingCalls = new Map();

ari.onCall = async (channelId, meta) => {
  try {
    // The VICIdial-driven flow runs a single active campaign.
    const campaign = await Campaign.findOne({ isActive: true }).sort({ createdAt: 1 });
    if (!campaign) {
      console.error("[ARI] No active campaign — hanging up");
      await ari.hangup(channelId);
      return;
    }
    const callLog = await CallLog.create({
      campaign: campaign._id,
      callSid: channelId, // unique per ARI call; avoids the callSid:null unique-index clash
      leadId: meta.leadId || null,
      fromNumber: meta.customerCid || "unknown", // fromNumber is required
      toNumber: campaign.twilioDid || "asterisk",
      status: "in_progress",
      direction: "inbound",
      startTime: new Date(),
    });
    pendingCalls.set(meta.audioUuid, { callLogId: String(callLog._id), channelId });
  } catch (e) {
    console.error("[ARI] onCall failed:", e.message);
    try { await ari.hangup(channelId); } catch { }
  }
};

audioServer.on("call", (conn) => {
  const pending = pendingCalls.get(conn.id);
  if (!pending) {
    console.warn(`[AudioSocket] no pending call for uuid=${conn.id} — dropping`);
    conn.hangup();
    return;
  }
  pendingCalls.delete(conn.id);

  const adapter = new TwilioCompatAdapter(conn, { streamSid: conn.id });
  adapter._ariChannelId = pending.channelId; // ARI transfer/hangup target
  // Reuse MediaStreamHandler exactly as if Twilio had connected.
  mediaHandler.wss.emit("connection", adapter, { url: `/media-stream/${pending.callLogId}` });

  // CRITICAL: initializeSession() runs async (campaign + Deepgram load). If we
  // fire the Twilio-style "start" before the session is registered, the handler
  // drops it and never sets isTwilioReady — which gates ALL outbound audio, so
  // the customer hears nothing. Wait until the session exists, then begin().
  const sid = String(pending.callLogId);
  const t0 = Date.now();
  const waitReady = setInterval(() => {
    const ready = mediaHandler.sessions.has(sid);
    if (ready || conn.closed || Date.now() - t0 > 8000) {
      clearInterval(waitReady);
      if (ready) adapter.begin({ customParameters: { "X-Asterisk-UniqueID": pending.channelId } });
      else console.warn(`[AudioSocket] session ${sid} not ready in time (closed=${conn.closed})`);
    }
  }, 15);
});

ari.start();

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});