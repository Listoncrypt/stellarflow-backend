import client from "prom-client";

export const registry = new client.Registry();

client.collectDefaultMetrics({ register: registry, prefix: "stellarflow_" });

export const successfulSubmissions = new client.Counter({
  name: "oracle_successful_submissions_total",
  help: "Total number of successful oracle price submissions",
  labelNames: ["asset"],
  registers: [registry],
});

export const failedSubmissions = new client.Counter({
  name: "oracle_failed_submissions_total",
  help: "Total number of failed oracle price submissions",
  labelNames: ["asset", "reason"],
  registers: [registry],
});

export const gasUsagePerAsset = new client.Histogram({
  name: "oracle_gas_usage_per_asset",
  help: "Stellar transaction fee (in stroops) used per oracle submission",
  labelNames: ["asset"],
  buckets: [100, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000],
  registers: [registry],
});

export const submissionDuration = new client.Histogram({
  name: "oracle_submission_duration_seconds",
  help: "End-to-end duration of an oracle submission in seconds",
  labelNames: ["asset"],
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30],
  registers: [registry],
});
