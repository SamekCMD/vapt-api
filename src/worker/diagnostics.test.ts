import assert from "node:assert/strict";
import test from "node:test";
import { createApiDiagnostics, type ApiDiagnosticCode, type DiagnosticDataPoint } from "./diagnostics.js";
import worker from "./index.js";
import {readFileSync} from "node:fs";
import type {WorkerBindings} from "./environment.js";
import type {ExecutionContext} from "hono";

test("API diagnostics writes only fixed component/code/count and deduplicates within an invocation", () => {
  const points: DiagnosticDataPoint[] = [];
  const emit = createApiDiagnostics({ writeDataPoint: point => { points.push(point); } });
  emit("http_5xx"); emit("http_5xx"); emit("config_invalid");
  assert.deepEqual(points, [
    { indexes: ["api:http_5xx"], blobs: ["api", "http_5xx"], doubles: [1] },
    { indexes: ["api:config_invalid"], blobs: ["api", "config_invalid"], doubles: [1] },
  ]);
});

test("diagnostics never coerces arbitrary input or serializes an error or request", () => {
  let calls = 0;
  const emit = createApiDiagnostics({ writeDataPoint() { calls++; } });
  const unsafe = { toString() { throw Error("private-email@example.invalid"); }, toJSON() { throw Error("private-cookie"); } };
  for (const value of ["private-token", unsafe, Error("private-password"), null, undefined, new Request("https://example.invalid/private-email")]) emit(value as ApiDiagnosticCode);
  assert.equal(calls, 0);
});

test("missing and throwing diagnostics cannot break the business invocation or retry repeatedly", () => {
  createApiDiagnostics()("fetch_failed");
  let attempts = 0;
  const emit = createApiDiagnostics({ writeDataPoint() { attempts++; throw Error("private-provider-response"); } });
  assert.doesNotThrow(() => { for (let i = 0; i < 30; i++) emit("fetch_failed"); });
  assert.equal(attempts, 1);
});

test("invocations have independent deduplication and a finite four-code write budget", () => {
  const points: DiagnosticDataPoint[] = []; const binding = { writeDataPoint: (point: DiagnosticDataPoint) => { points.push(point); } };
  for (let i = 0; i < 2; i++) { const emit = createApiDiagnostics(binding); for (const code of ["config_invalid", "http_5xx", "fetch_failed", "scheduled_failed"] as const) { emit(code); emit(code); } }
  assert.equal(points.length, 8);
});

const context: ExecutionContext = { waitUntil() {}, passThroughOnException() {}, props: {} };
const fixture = () => JSON.parse(readFileSync(new URL("../../wrangler.worker-test-production-entry.jsonc", import.meta.url), "utf8")).vars as WorkerBindings;
test("production entry reports invalid configuration without changing its 503 response", async () => {
  const points: DiagnosticDataPoint[] = [];
  const env = {...fixture(), ENVIRONMENT:"production" as const, HYPERDRIVE:undefined, DIAGNOSTICS:{writeDataPoint(point:DiagnosticDataPoint){points.push(point);}}};
  const response=await worker.fetch(new Request("https://api.vapt.test/health"),env,context);
  assert.equal(response.status,503);assert.equal(points.length,1);assert.equal(points[0]?.blobs[1],"config_invalid");
});
test("production entry records handled 5xx but not a healthy response", async () => {
  const points: DiagnosticDataPoint[]=[];
  const env={...fixture(),ENVIRONMENT:"production" as const,DIAGNOSTICS:{writeDataPoint(point:DiagnosticDataPoint){points.push(point);}}};
  assert.equal((await worker.fetch(new Request("https://api.vapt.test/health"),env,context)).status,200);assert.equal(points.length,0);
  const response=await worker.fetch(new Request("https://api.vapt.test/auth/me",{headers:{"cf-connecting-ip":"203.0.113.89"}}),env,context);
  assert.equal(response.status,503);assert.equal(points.length,1);assert.equal(points[0]?.blobs[1],"http_5xx");
});
test("preview cannot emit into an accidentally supplied production diagnostic binding", async () => {
  let writes=0;const env={...fixture(),HYPERDRIVE:undefined,DIAGNOSTICS:{writeDataPoint(){writes++;}}};
  assert.equal((await worker.fetch(new Request("https://api.vapt.test/health"),env,context)).status,503);assert.equal(writes,0);
});
test("broken diagnostics preserves the production response", async () => {
  const env={...fixture(),ENVIRONMENT:"production" as const,HYPERDRIVE:undefined,DIAGNOSTICS:{writeDataPoint(){throw Error("private-provider-message");}}};
  const response=await worker.fetch(new Request("https://api.vapt.test/private-cookie-marker"),env,context);
  assert.equal(response.status,503);assert.doesNotMatch(await response.text(),/private-provider-message|private-cookie-marker/);
});
