import { Request, Response, NextFunction } from "express";
import promClient from "prom-client";

// Create a Registry which registers the metrics
export const register = new promClient.Registry();

// Add default metrics (e.g., memory, CPU)
promClient.collectDefaultMetrics({
  register,
  labels: { app: 'stellarflow-backend' },
});

// Create a custom histogram for HTTP request durations
export const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: "http_request_duration_seconds",
  help: "Duration of HTTP requests in seconds",
  labelNames: ["method", "route", "status_code"],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10],
});
register.registerMetric(httpRequestDurationMicroseconds);

// Create a custom counter for HTTP requests
export const httpRequestsTotal = new promClient.Counter({
  name: "http_requests_total",
  help: "Total number of HTTP requests",
  labelNames: ["method", "route", "status_code"],
});
register.registerMetric(httpRequestsTotal);

// --- Stellar Submission Metrics ---

export const successfulSubmissions = new promClient.Counter({
  name: "stellar_successful_submissions_total",
  help: "Total number of successful Stellar submissions",
  labelNames: ["asset"],
});
register.registerMetric(successfulSubmissions);

export const failedSubmissions = new promClient.Counter({
  name: "stellar_failed_submissions_total",
  help: "Total number of failed Stellar submissions",
  labelNames: ["asset", "reason"],
});
register.registerMetric(failedSubmissions);

export const gasUsagePerAsset = new promClient.Histogram({
  name: "stellar_gas_usage_stroops",
  help: "Gas usage per asset in stroops",
  labelNames: ["asset"],
  buckets: [100, 500, 1000, 5000, 10000, 50000, 100000],
});
register.registerMetric(gasUsagePerAsset);

export const submissionDuration = new promClient.Histogram({
  name: "stellar_submission_duration_seconds",
  help: "Duration of Stellar submissions in seconds",
  labelNames: ["asset"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
});
register.registerMetric(submissionDuration);

export const metricsMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction,
) => {
  const start = process.hrtime();

  res.on("finish", () => {
    const elapsed = process.hrtime(start);
    const durationSeconds = elapsed[0] + elapsed[1] / 1e9;

    let routeStr = "(unmatched)";
    if (req.route && req.route.path) {
      routeStr = req.baseUrl + req.route.path;
    } else {
      // Fallback for custom handlers mapped directly on app
      if (
        req.path === "/health" ||
        req.path === "/" ||
        req.path === "/metrics" ||
        req.path.startsWith("/api/v1/docs")
      ) {
        routeStr = req.path;
      }
    }

    httpRequestsTotal.inc({
      method: req.method,
      route: routeStr,
      status_code: res.statusCode,
    });

    httpRequestDurationMicroseconds.observe(
      {
        method: req.method,
        route: routeStr,
        status_code: res.statusCode,
      },
      durationSeconds,
    );
  });

  next();
};

export const metricsEndpoint = async (req: Request, res: Response) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err);
  }
};
