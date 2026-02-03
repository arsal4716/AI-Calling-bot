// utils/logger.js
const fs = require("fs");
const path = require("path");
const { format } = require("date-fns");

const logDir = path.join(__dirname, "../logs");
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

const DEBUG_ENABLED =
  process.env.LOG_LEVEL === "debug" ||
  process.env.DEBUG === "true" ||
  process.env.NODE_ENV !== "production";

function writeLog(type, message) {
  const timestamp = format(new Date(), "yyyy-MM-dd HH:mm:ss");
  const logLine = `[${timestamp}] [${type}] ${message}\n`;

  if (type === "ERROR") console.error(logLine.trim());
  else console.log(logLine.trim());

  const logFile = path.join(logDir, `${format(new Date(), "yyyy-MM-dd")}.log`);
  fs.appendFile(logFile, logLine, (err) => {
    if (err) console.error("Logger write failed:", err.message);
  });
}

module.exports = {
  debug: (msg) => {
    if (!DEBUG_ENABLED) return;
    writeLog("DEBUG", msg);
  },
  info: (msg) => writeLog("INFO", msg),
  warn: (msg) => writeLog("WARN", msg),
  error: (msg) => writeLog("ERROR", msg),
};
