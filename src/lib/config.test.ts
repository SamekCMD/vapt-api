import assert from "node:assert/strict";
import test from "node:test";

import { ConfigError, createConfig } from "./config.js";

test("createConfig parses valid environment values", () => {
  const config = createConfig({
    NODE_ENV: "development",
    PORT: "3000",
    HOST: "0.0.0.0",
    CORS_ORIGINS: "http://localhost:5173,https://app.example.com",
    LOG_LEVEL: "info",
  });

  assert.equal(config.nodeEnv, "development");
  assert.equal(config.port, 3000);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.logLevel, "info");
  assert.deepEqual(config.corsOrigins, [
    "http://localhost:5173",
    "https://app.example.com",
  ]);
});

test("createConfig falls back to safe infrastructure defaults", () => {
  const config = createConfig({
    CORS_ORIGINS: "http://localhost:5173",
  });

  assert.equal(config.nodeEnv, "production");
  assert.equal(config.port, 3000);
  assert.equal(config.host, "0.0.0.0");
  assert.equal(config.logLevel, "info");
});

test("createConfig throws when a required env is missing", () => {
  assert.throws(
    () =>
      createConfig({
        NODE_ENV: "development",
        PORT: "3000",
        LOG_LEVEL: "info",
      }),
    ConfigError,
  );
});

test("createConfig throws when port is invalid", () => {
  assert.throws(
    () =>
      createConfig({
        NODE_ENV: "development",
        PORT: "abc",
        HOST: "0.0.0.0",
        CORS_ORIGINS: "http://localhost:5173",
        LOG_LEVEL: "info",
      }),
    ConfigError,
  );
});

test("createConfig throws when cors origins is empty", () => {
  assert.throws(
    () =>
      createConfig({
        NODE_ENV: "development",
        PORT: "3000",
        HOST: "0.0.0.0",
        CORS_ORIGINS: "   ",
        LOG_LEVEL: "info",
      }),
    ConfigError,
  );
});
