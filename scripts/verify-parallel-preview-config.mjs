import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const allowedTopLevel = new Set([
  "$schema", "name", "main", "compatibility_date", "compatibility_flags",
  "workers_dev", "preview_urls", "previews", "migrations",
]);
const allowedPreview = new Set(["vars", "hyperdrive", "r2_buckets", "ratelimits", "durable_objects"]);
const allowedVars = new Set([
  "ENVIRONMENT", "CORS_ORIGINS", "FRONTEND_URL", "API_PUBLIC_URL", "LOG_LEVEL",
  "STRIPE_ENVIRONMENT", "STRIPE_PORTAL_CONFIGURATION_ID", "STRIPE_PRICE_STARTER",
  "STRIPE_PRICE_PRO", "STRIPE_PRICE_BUSINESS", "STRIPE_WEBHOOK_TOLERANCE_SECONDS",
  "PAYMENT_EFFECTS_POLL_INTERVAL_MS", "PAYMENT_EFFECTS_BATCH_SIZE",
  "PAYMENT_EFFECTS_LEASE_MS", "PAYMENT_EFFECTS_MAX_ATTEMPTS",
  "PAYMENT_EFFECTS_RETRY_BASE_MS", "BETTER_AUTH_URL", "BETTER_AUTH_TRUSTED_ORIGINS",
  "RESEND_TEMPLATE_VERIFY_ACCOUNT", "RESEND_TEMPLATE_RESET_PASSWORD", "EMAIL_FROM",
  "R2_ACCOUNT_ID", "R2_BUCKET_NAME", "R2_PUBLIC_BASE_URL", "R2_UPLOAD_URL_TTL_SECONDS", "REALTIME_ENABLED",
]);
const limits = new Map([
  ["AUTH_RATE_LIMIT", 20], ["BILLING_RATE_LIMIT", 60],
  ["ORDERS_RATE_LIMIT", 30], ["STORAGE_RATE_LIMIT", 30],
  ["WEBHOOKS_RATE_LIMIT", 300], ["PUBLIC_RATE_LIMIT", 120],
]);

function invalid() {
  throw new Error("Invalid parallel Preview configuration");
}

function record(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

export function assertParallelPreviewConfig(config) {
  if (!record(config) || Object.keys(config).some((key) => !allowedTopLevel.has(key)) ||
    config.name !== "vapt-api-parallel" ||
    !["src/worker/parallel-preview.ts", "src/worker/parallel-preview-entry.ts"].includes(config.main) ||
    config.workers_dev !== false || config.preview_urls !== false ||
    !record(config.previews) || Object.keys(config.previews).some((key) => !allowedPreview.has(key))) {
    invalid();
  }

  const preview = config.previews;
  const realtime = config.main === "src/worker/parallel-preview-entry.ts";
  if (realtime) {
    if (preview.vars?.REALTIME_ENABLED !== "true" ||
      JSON.stringify(config.migrations) !== JSON.stringify([{ tag: "stage12-realtime-sqlite-v1", new_sqlite_classes: ["RestaurantRealtime"] }]) ||
      !record(preview.durable_objects) || Object.keys(preview.durable_objects).length !== 1 ||
      !Array.isArray(preview.durable_objects.bindings) || preview.durable_objects.bindings.length !== 1 ||
      Object.keys(preview.durable_objects.bindings[0] ?? {}).sort().join(",") !== "class_name,name" ||
      preview.durable_objects.bindings[0]?.name !== "RESTAURANT_REALTIME" ||
      preview.durable_objects.bindings[0]?.class_name !== "RestaurantRealtime") invalid();
  } else if (config.migrations !== undefined || preview.durable_objects !== undefined || preview.vars?.REALTIME_ENABLED !== undefined) {
    invalid();
  }
  if (!record(preview.vars) || preview.vars.ENVIRONMENT !== "preview" ||
    preview.vars.STRIPE_ENVIRONMENT !== "test" ||
    Object.entries(preview.vars).some(([key, value]) =>
      !allowedVars.has(key) || typeof value !== "string" ||
      /(?:postgres(?:ql)?:\/\/|api\.vapt\.app\.br|sk_(?:test|live)_|whsec_|production)/i.test(value))) {
    invalid();
  }

  if (!Array.isArray(preview.hyperdrive) || preview.hyperdrive.length !== 1 ||
    Object.keys(preview.hyperdrive[0] ?? {}).sort().join(",") !== "binding,id" ||
    preview.hyperdrive[0]?.binding !== "HYPERDRIVE" ||
    preview.hyperdrive[0]?.id !== "0c05fec2924b4f3b9225f3d689ba7ea9" ||
    !Array.isArray(preview.r2_buckets) || preview.r2_buckets.length !== 1 ||
    Object.keys(preview.r2_buckets[0] ?? {}).sort().join(",") !== "binding,bucket_name" ||
    preview.r2_buckets[0]?.binding !== "R2_BUCKET" ||
    preview.r2_buckets[0]?.bucket_name !== "vapt-assets-preview") {
    invalid();
  }

  if (!Array.isArray(preview.ratelimits) || preview.ratelimits.length !== limits.size) invalid();
  const names = new Set();
  const namespaces = new Set();
  for (const binding of preview.ratelimits) {
    if (!record(binding) || !limits.has(binding.name) || names.has(binding.name) ||
      !/^[1-9][0-9]*$/.test(binding.namespace_id ?? "") ||
      namespaces.has(binding.namespace_id) ||
      !record(binding.simple) || binding.simple.limit !== limits.get(binding.name) ||
      binding.simple.period !== 60) {
      invalid();
    }
    names.add(binding.name);
    namespaces.add(binding.namespace_id);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
    assertParallelPreviewConfig(config);
    process.stdout.write("Parallel Preview configuration isolated\n");
  } catch {
    process.stderr.write("Invalid parallel Preview configuration\n");
    process.exitCode = 1;
  }
}
