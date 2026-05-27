/* global NodeJS */
import prisma from "../lib/prisma.js";
import {
  activeIdempotencyKeys,
  evictedIdempotencyKeys,
} from "../middleware/metrics.js";

export interface IdempotencyRecord {
  key: string;
  response: string;
  expiresAt: Date;
}

/**
 * Get idempotency record for a key.
 * If the key exists but is expired, it deletes the key and returns null.
 */
export async function getIdempotencyRecord(
  key: string,
): Promise<IdempotencyRecord | null> {
  const record = await prisma.idempotencyKey.findUnique({
    where: { key },
  });

  if (!record) {
    return null;
  }

  if (record.expiresAt < new Date()) {
    // Expired - delete from database and treat as brand new ingestion
    await prisma.idempotencyKey.delete({ where: { key } }).catch(() => {});
    evictedIdempotencyKeys.inc();
    updateActiveKeysMetric();
    return null;
  }

  return record;
}

/**
 * Save idempotency record.
 */
export async function saveIdempotencyRecord(
  key: string,
  response: string,
  ttlSeconds: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  await prisma.idempotencyKey.upsert({
    where: { key },
    create: { key, response, expiresAt },
    update: { response, expiresAt },
  });

  updateActiveKeysMetric();
}

/**
 * Evict expired keys from the database.
 */
export async function evictExpiredKeys(): Promise<number> {
  const result = await prisma.idempotencyKey.deleteMany({
    where: {
      expiresAt: { lt: new Date() },
    },
  });

  if (result.count > 0) {
    evictedIdempotencyKeys.inc(result.count);
    updateActiveKeysMetric();
    console.info(`[Idempotency] Evicted ${result.count} expired keys`);
  }

  return result.count;
}

/**
 * Helper to update the active keys Gauge metric
 */
export function updateActiveKeysMetric(): void {
  prisma.idempotencyKey
    .count({
      where: {
        expiresAt: { gte: new Date() },
      },
    })
    .then((count: number) => {
      activeIdempotencyKeys.set(count);
    })
    .catch((err: unknown) => {
      console.warn("[Idempotency] Failed to update active keys metric:", err);
    });
}

// Background eviction setup
let evictionTimer: NodeJS.Timeout | null = null;

export function startIdempotencyEvictionWorker(
  intervalMs: number = 3600000,
): void {
  if (evictionTimer) return;

  // Update metric on start
  updateActiveKeysMetric();

  evictionTimer = setInterval(async () => {
    try {
      await evictExpiredKeys();
    } catch (error) {
      console.error("[Idempotency] Automated eviction error:", error);
    }
  }, intervalMs);
}

export function stopIdempotencyEvictionWorker(): void {
  if (evictionTimer) {
    clearInterval(evictionTimer);
    evictionTimer = null;
  }
}
