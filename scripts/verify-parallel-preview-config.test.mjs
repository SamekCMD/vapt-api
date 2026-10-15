import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertParallelPreviewConfig } from "./verify-parallel-preview-config.mjs";

const groups = [
  ["AUTH_RATE_LIMIT", 20],
  ["BILLING_RATE_LIMIT", 60],
  ["ORDERS_RATE_LIMIT", 30],
  ["STORAGE_RATE_LIMIT", 30],
  ["WEBHOOKS_RATE_LIMIT", 300],
  ["PUBLIC_RATE_LIMIT", 120],
];

function validConfig() {
  return {
    name: "vapt-api-parallel",
    main: "src/worker/parallel-preview.ts",
    compatibility_date: "2026-09-28",
    compatibility_flags: ["nodejs_compat"],
    workers_dev: false,
    preview_urls: false,
    previews: {
      vars: { ENVIRONMENT: "preview", STRIPE_ENVIRONMENT: "test" },
      hyperdrive: [{ binding: "HYPERDRIVE", id: "0c05fec2924b4f3b9225f3d689ba7ea9" }],
      r2_buckets: [{ binding: "R2_BUCKET", bucket_name: "vapt-assets-preview" }],
      ratelimits: groups.map(([name, limit], index) => ({
        name, namespace_id: String(11011 + index), simple: { limit, period: 60 },
      })),
    },
  };
}

function rejects(mutator) {
  const config = validConfig();
  mutator(config);
  assert.throws(() => assertParallelPreviewConfig(config), /Invalid parallel Preview configuration/);
}

test("accepts the isolated preview contract and the committed config", () => {
  assert.doesNotThrow(() => assertParallelPreviewConfig(validConfig()));
  const committed = JSON.parse(readFileSync(new URL("../wrangler.worker-parallel-preview.jsonc", import.meta.url), "utf8"));
  assert.doesNotThrow(() => assertParallelPreviewConfig(committed));
});

test("rejects missing or wrong preview data bindings", () => {
  rejects((config) => { delete config.previews; });
  rejects((config) => { config.previews.hyperdrive = []; });
  rejects((config) => { config.previews.hyperdrive[0].id = "wrong-hyperdrive"; });
  rejects((config) => { config.previews.r2_buckets[0].bucket_name = "vapt-assets-production"; });
  rejects((config) => { config.previews.r2_buckets.push({ binding: "SECOND_BUCKET", bucket_name: "vapt-assets-production" }); });
});

test("rejects missing, shared or weakened rate-limit bindings", () => {
  rejects((config) => { config.previews.ratelimits.pop(); });
  rejects((config) => { config.previews.ratelimits[1].namespace_id = config.previews.ratelimits[0].namespace_id; });
  rejects((config) => { config.previews.ratelimits[0].simple.limit = 2000; });
  rejects((config) => { config.previews.ratelimits[0].simple.period = 10; });
});

test("rejects top-level reachability, production bindings and triggers", () => {
  rejects((config) => { config.workers_dev = true; });
  rejects((config) => { config.preview_urls = true; });
  rejects((config) => { config.route = "api.vapt.app.br/*"; });
  rejects((config) => { config.routes = ["api.vapt.app.br/*"]; });
  rejects((config) => { config.triggers = { crons: ["* * * * *"] }; });
  rejects((config) => { config.queues = { consumers: [{ queue: "billing" }] }; });
  rejects((config) => { config.hyperdrive = validConfig().previews.hyperdrive; });
  rejects((config) => { config.r2_buckets = validConfig().previews.r2_buckets; });
});

test("rejects production or secret material in Preview variables", () => {
  rejects((config) => { config.previews.vars.ENVIRONMENT = "production"; });
  rejects((config) => { config.previews.vars.STRIPE_ENVIRONMENT = "live"; });
  rejects((config) => { config.previews.vars.DATABASE_URL = "postgresql://user:password@db.example/vapt"; });
  rejects((config) => { config.previews.vars.PARALLEL_PREVIEW_TOKEN = "synthetic-token"; });
  rejects((config) => { config.previews.vars.STRIPE_SECRET_KEY = "sk_test_synthetic"; });
  rejects((config) => { config.previews.vars.API_PUBLIC_URL = "https://api.vapt.app.br"; });
});

test("legacy wrapper cannot acquire realtime bindings or migrations", () => {
  rejects(c => { c.previews.vars.REALTIME_ENABLED = "true"; });
  rejects(c => { c.previews.durable_objects = { bindings: [] }; });
  rejects(c => { c.migrations = [{ tag: "unexpected", new_classes: ["RestaurantRealtime"] }]; });
});
