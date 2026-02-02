const fs = require('fs');
const path = require('path');
const { format } = require('date-fns');

const logDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);

function writeLog(type, message) {
  const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
  const logLine = `[${timestamp}] [${type}] ${message}\n`;

  if (type === 'ERROR') console.error(logLine);
  else console.log(logLine);
  const logFile = path.join(logDir, `${format(new Date(), 'yyyy-MM-dd')}.log`);
  fs.appendFile(logFile, logLine, (err) => {
    if (err) console.error('Logger write failed:', err.message);
  });
}

module.exports = {
  info: (msg) => writeLog('INFO', msg),
  warn: (msg) => writeLog('WARN', msg),
  error: (msg) => writeLog('ERROR', msg),
};
