import express, { Request, Response, NextFunction } from "express";
import { registry } from "./oracleMetrics.js";

const router = express.Router();

function requireMetricsToken(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.METRICS_SECRET;

  if (!secret) {
    console.error(
      "[metrics] METRICS_SECRET env var is not set — endpoint disabled",
    );
    res.status(403).json({ error: "Metrics endpoint is not configured" });
    return;
  }

  const authHeader = req.headers["authorization"] || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token || token !== secret) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  next();
}

router.get("/", requireMetricsToken, async (req: Request, res: Response) => {
  try {
    res.set("Content-Type", registry.contentType);
    const output = await registry.metrics();
    res.end(output);
  } catch (err) {
    console.error("[metrics] Failed to collect metrics:", err);
    res.status(500).end();
  }
});

export default router;
