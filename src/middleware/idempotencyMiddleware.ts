import { Request, Response, NextFunction } from "express";
import {
  getIdempotencyRecord,
  saveIdempotencyRecord,
} from "../db/idempotency.js";

// Default TTL is 24 hours (86400 seconds)
const DEFAULT_TTL_SECONDS = 86400;

export const idempotencyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  // Only process requests that have an X-Idempotency-Key header
  const key = req.headers["x-idempotency-key"];

  if (!key || typeof key !== "string" || key.trim() === "") {
    next();
    return;
  }

  const trimmedKey = key.trim();

  try {
    // 1. Look up cached response
    const cached = await getIdempotencyRecord(trimmedKey);

    if (cached) {
      console.info(`[Idempotency] Cache hit for key: ${trimmedKey}`);
      try {
        const parsed = JSON.parse(cached.response);
        res.status(parsed.status).json(parsed.body);
        return;
      } catch (parseErr) {
        console.error(
          `[Idempotency] Failed to parse cached response for key: ${trimmedKey}`,
          parseErr,
        );
        // Fallback: if cached response is corrupt, continue to process as a new request
      }
    }

    // 2. Intercept JSON responses to cache them
    const originalJson = res.json;

    res.json = function (body: any): Response {
      // Restore original json function
      res.json = originalJson;

      // Only cache successful status codes (e.g. 2xx) to prevent caching transient errors
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const ttlSeconds = process.env.IDEMPOTENCY_TTL_SECONDS
          ? parseInt(process.env.IDEMPOTENCY_TTL_SECONDS, 10)
          : DEFAULT_TTL_SECONDS;

        saveIdempotencyRecord(
          trimmedKey,
          JSON.stringify({ status: res.statusCode, body }),
          isNaN(ttlSeconds) ? DEFAULT_TTL_SECONDS : ttlSeconds,
        ).catch((err) => {
          console.error(`[Idempotency] Failed to save key: ${trimmedKey}`, err);
        });
      }

      return originalJson.call(this, body);
    };

    next();
  } catch (error) {
    console.error(
      `[Idempotency] Error processing middleware for key: ${trimmedKey}`,
      error,
    );
    next();
  }
};
