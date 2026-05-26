import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import express, { Request, Response } from "express";
import request from "supertest";

// Mock metrics before importing the middleware/db layers
jest.mock("../src/middleware/metrics", () => ({
  activeIdempotencyKeys: {
    set: jest.fn(),
  },
  evictedIdempotencyKeys: {
    inc: jest.fn(),
  },
}));

// Mock Prisma client
const mockIdempotencyKeysStore = new Map<
  string,
  { key: string; response: string; expiresAt: Date }
>();

jest.mock("@prisma/client", () => {
  return {
    PrismaClient: jest.fn().mockImplementation(() => ({
      idempotencyKey: {
        findUnique: jest.fn(async ({ where }: { where: { key: string } }) => {
          return mockIdempotencyKeysStore.get(where.key) || null;
        }),
        delete: jest.fn(async ({ where }: { where: { key: string } }) => {
          mockIdempotencyKeysStore.delete(where.key);
          return { key: where.key };
        }),
        upsert: jest.fn(
          async ({
            where,
            create,
            _update,
          }: {
            where: { key: string };
            create: any;
            _update: any;
          }) => {
            const record = {
              key: where.key,
              response: create.response,
              expiresAt: create.expiresAt,
            };
            mockIdempotencyKeysStore.set(where.key, record);
            return record;
          },
        ),
        deleteMany: jest.fn(
          async ({ where }: { where: { expiresAt: { lt: Date } } }) => {
            const now = where.expiresAt.lt;
            let count = 0;
            for (const [key, record] of mockIdempotencyKeysStore.entries()) {
              if (record.expiresAt < now) {
                mockIdempotencyKeysStore.delete(key);
                count++;
              }
            }
            return { count };
          },
        ),
        count: jest.fn(async () => {
          return mockIdempotencyKeysStore.size;
        }),
      },
    })),
  };
});

// Now dynamically import the database helper and middleware AFTER the mocks are registered
const { evictExpiredKeys } = await import("../src/db/idempotency");
const { idempotencyMiddleware } =
  await import("../src/middleware/idempotencyMiddleware");

// Create a minimal Express app for testing the middleware
const app = express();
app.use(express.json());
app.use(idempotencyMiddleware);

// Define a test POST route that simulates price updates request
let handlerCallCount = 0;
app.post(
  "/api/v1/price-updates/multi-sig/request",
  (req: Request, res: Response) => {
    handlerCallCount++;
    res.status(200).json({
      success: true,
      data: {
        priceReviewId: req.body.priceReviewId,
        currency: req.body.currency,
        rate: req.body.rate,
        source: req.body.source,
        memoId: req.body.memoId,
        callCount: handlerCallCount,
      },
    });
  },
);

describe("Idempotency Key integration and eviction", () => {
  beforeEach(() => {
    mockIdempotencyKeysStore.clear();
    handlerCallCount = 0;
    jest.clearAllMocks();
  });

  describe("1. Unexpired Duplicate Request (Cache Hit)", () => {
    it("returns cached response and does not re-process the request", async () => {
      const payload = {
        priceReviewId: 101,
        currency: "NGN",
        rate: 0.0025,
        source: "CoinGecko",
        memoId: "SF-NGN-1714075200-001",
      };

      // First request (brand new)
      const res1 = await request(app)
        .post("/api/v1/price-updates/multi-sig/request")
        .set("X-Idempotency-Key", "key-12345")
        .send(payload);

      expect(res1.status).toBe(200);
      expect(res1.body.success).toBe(true);
      expect(res1.body.data.callCount).toBe(1);

      // Verify it got saved in the store
      expect(mockIdempotencyKeysStore.has("key-12345")).toBe(true);

      // Second duplicate request
      const res2 = await request(app)
        .post("/api/v1/price-updates/multi-sig/request")
        .set("X-Idempotency-Key", "key-12345")
        .send(payload);

      expect(res2.status).toBe(200);
      expect(res2.body.success).toBe(true);
      // The callCount must still be 1, meaning the route handler was NOT called again
      expect(res2.body.data.callCount).toBe(1);
      expect(handlerCallCount).toBe(1);
    });
  });

  describe("2. Expired Key (Reprocessing)", () => {
    it("treats requests with expired keys as brand-new and re-processes completely", async () => {
      const payload = {
        priceReviewId: 102,
        currency: "GHS",
        rate: 0.075,
        source: "CoinGecko",
      };

      // Manually seed an expired key into the mock store
      const expiredDate = new Date(Date.now() - 5000); // 5 seconds ago
      mockIdempotencyKeysStore.set("expired-key-abc", {
        key: "expired-key-abc",
        response: JSON.stringify({
          status: 200,
          body: { success: true, data: { ...payload, callCount: 1 } },
        }),
        expiresAt: expiredDate,
      });

      // Request with expired key
      const res = await request(app)
        .post("/api/v1/price-updates/multi-sig/request")
        .set("X-Idempotency-Key", "expired-key-abc")
        .send(payload);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      // The callCount must be 1, meaning the handler ran (handlerCallCount started at 0)
      expect(res.body.data.callCount).toBe(1);
      expect(handlerCallCount).toBe(1);

      // Verify the old key was replaced with a new expiration date in the future
      const updatedRecord = mockIdempotencyKeysStore.get("expired-key-abc");
      expect(updatedRecord).toBeDefined();
      expect(updatedRecord!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });
  });

  describe("3. Background Eviction", () => {
    it("correctly evicts only expired keys when evictExpiredKeys is called", async () => {
      // Seed one active key and one expired key
      const now = Date.now();
      mockIdempotencyKeysStore.set("active-key", {
        key: "active-key",
        response: "{}",
        expiresAt: new Date(now + 60000), // 1 minute in future
      });
      mockIdempotencyKeysStore.set("expired-key", {
        key: "expired-key",
        response: "{}",
        expiresAt: new Date(now - 10000), // 10 seconds in past
      });

      expect(mockIdempotencyKeysStore.size).toBe(2);

      // Run eviction
      const evictedCount = await evictExpiredKeys();

      expect(evictedCount).toBe(1);
      expect(mockIdempotencyKeysStore.size).toBe(1);
      expect(mockIdempotencyKeysStore.has("active-key")).toBe(true);
      expect(mockIdempotencyKeysStore.has("expired-key")).toBe(false);
    });
  });
});
