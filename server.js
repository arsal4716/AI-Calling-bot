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
const twilioRoutes = require("./routes/twilioRoutes");
const dashBoard = require("./routes/dashboardRoutes");
const customVoiceRoutes = require('./routes/customVoiceRoutes');
const dialerRoutes = require('./routes/dialerRoutes');
const callLogRoutes = require('./routes/callLogRoutes');
const { initDialerQueueService } = require("./services/dialerQueueSingleton");

const { errorHandler } = require("./utils/errorHandler");
const MediaStreamHandler = require("./websockets/mediaStreamHandler");

const TwilioService = require("./services/TwilioService");
const { setTwilioService } = require("./services/twilioSingleton");
const CallLog = require("./models/callLogModel");

const MAX_CONCURRENT_CALLS = 20;

const app = express();
const httpServer = createServer(app);
const wss = new WebSocket.Server({ noServer: true });

httpServer.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
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
app.use("/api/twilio", twilioRoutes);
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

const twilioService = new TwilioService({
  getActiveSessionCount: () => mediaHandler.sessions.size,
});
setTwilioService(twilioService);
initDialerQueueService();

setInterval(async () => {
  try {
    const active = mediaHandler.sessions.size;
    if (active >= MAX_CONCURRENT_CALLS) return;

    const slots = MAX_CONCURRENT_CALLS - active;
    const queued = await CallLog.find({ status: "queued" })
      .sort({ createdAt: 1 })
      .limit(slots);

    for (const call of queued) {
      try {
        call.status = "connecting";
        await call.save();

        await twilioService.redirectCallToStream(call.callSid, call._id);

        console.log("Dequeued call:", call.callSid);
      } catch (e) {
        console.error("Dequeue failed:", call.callSid, e.message);
        try {
          call.status = "queue_failed";
          await call.save();
        } catch { }
      }
    }
  } catch (e) {
    console.error("Queue worker error:", e.message);
  }
}, 2000);

app.use(errorHandler);

const PORT = process.env.PORT || 5000;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});