const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const rateLimit = require("express-rate-limit");
const { createServer } = require("http");
const WebSocket = require("ws");

dotenv.config();

const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const campaignRoutes = require("./routes/campaignRoutes");
const voiceCloneRoutes = require("./routes/voiceCloneRoutes");
const userRoutes = require("./routes/userRoutes");
const twilioRoutes = require("./routes/twilioRoutes");

const { errorHandler } = require("./utils/errorHandler");
const MediaStreamHandler = require("./websockets/mediaStreamHandler");

const TwilioService = require("./services/TwilioService");
const { setTwilioService } = require("./services/twilioSingleton");
const CallLog = require("./models/callLogModel");
const dashBoard = require("./routes/dashboardRoutes")
const MAX_CONCURRENT_CALLS = 20;

const app = express();
const httpServer = createServer(app);
const wss = new WebSocket.Server({ noServer: true });

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on("close", () => console.log("🔌 WebSocket server closed"));

connectDB();

app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
  }),
);

// middleware
app.set("trust proxy", 1);
app.use(cors());
app.use(helmet());
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

// routes
app.use("/api/auth", authRoutes);
app.use("/api/campaigns", campaignRoutes);
app.use("/api/voices", voiceCloneRoutes);
app.use("/api/users", userRoutes);
app.use("/api/twilio", twilioRoutes);
app.use("/api/dashboard", dashBoard);

app.use(express.static(path.join(__dirname, 'frontend/build')));
app.get(/^\/(?!api).*$/, (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/build', 'index.html'));
});
// websocket upgrade
httpServer.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

const mediaHandler = new MediaStreamHandler(wss);

const twilioService = new TwilioService({
  getActiveSessionCount: () => mediaHandler.sessions.size,
});

setTwilioService(twilioService);

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

        console.log(" Dequeued call:", call.callSid);
      } catch (e) {
        console.error("Dequeue failed:", call.callSid, e.message);
        try {
          call.status = "queue_failed";
          await call.save();
        } catch {}
      }
    }
  } catch (e) {
    console.error("Queue worker error:", e.message);
  }
}, 2000);

app.use(errorHandler);

const PORT = process.env.PORT || 80;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
