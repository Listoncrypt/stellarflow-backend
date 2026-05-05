import winston, { createLogger, format, transports } from "winston";
import DailyRotateFile from "winston-daily-rotate-file";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const logDir = path.resolve(__dirname, "../../logs");

export interface CustomLogger extends winston.Logger {
  fetcherError: (message: any, contextOrMeta?: any, meta?: any) => void;
  info: winston.LeveledLogMethod;
  warn: winston.LeveledLogMethod;
  error: winston.LeveledLogMethod;
  debug: winston.LeveledLogMethod;
}

const logger = createLogger({
  level: "info",
  format: format.combine(
    format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    format.errors({ stack: true }),
    format.splat(),
    format.json(),
  ),
  transports: [
    new DailyRotateFile({
      filename: path.join(logDir, "application-%DATE%.log"),
      datePattern: "YYYY-MM-DD",
      maxSize: "100m",
      maxFiles: "10",
      zippedArchive: true,
      handleExceptions: true,
      handleRejections: true,
    }),
    new transports.Console({
      format: format.combine(format.colorize(), format.simple()),
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
  exitOnError: false,
}) as CustomLogger;

// Add custom methods for fetcher-specific logging
logger.fetcherError = (message: any, contextOrMeta?: any, meta?: any) => {
  const logMessage = message instanceof Error ? message.message : String(message);
  let logMeta = {};

  if (typeof contextOrMeta === "string") {
    logMeta = { context: contextOrMeta, ...meta };
  } else {
    logMeta = { ...contextOrMeta, ...meta };
  }

  logger.error(`[FETCHER_ERROR] ${logMessage}`, logMeta);
};

export default logger;
