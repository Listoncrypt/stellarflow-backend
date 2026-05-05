import winstonLogger, { CustomLogger } from "./winstonLogger";

export type { CustomLogger };

// Export the Winston logger as the default logger
export const logger: CustomLogger = winstonLogger;

// For compatibility, export a createFetcherLogger that returns the same logger
export function createFetcherLogger(fetcherName: string): CustomLogger {
  // Optionally, you can add child loggers or labels here
  return winstonLogger;
}
