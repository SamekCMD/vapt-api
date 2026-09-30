import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import type { Pool } from "pg";

import {
  handleHyperdriveProbe,
  type ProbeBindings,
  type ProbeDependencies,
} from "./hyperdrive-probe.js";

const secret = randomBytes(32).toString("hex");
const preview: ProbeBindings = {
  ENVIRONMENT: "preview",
  PROBE_TOKEN: secret,
  HYPERDRIVE: { connectionString: "postgresql://synthetic:synthetic@db.vapt.test/vapt" },
};

function testDependencies() {
  const counts = { databases: 0, operations: 0 };
  const dependencies: ProbeDependencies = {
    createDatabase() {
      counts.databases += 1;
      return {} as Pool;
    },
    async runOperation() {
      counts.operations += 1;
      return Response.json({ ok: true });
    },
  };
  return { counts, dependencies };
}

function request(path: string, token: string | null = secret, method = "POST") {
  return new Request(`https://probe.vapt.test${path}`, {
    method,
    headers: token === null ? undefined : { authorization: `Bearer ${token}` },
  });
}

test("denies before database creation", async () => {
  const { counts, dependencies } = testDependencies();
  for (const token of [null, "wrong-token"]) {
    const response = await handleHyperdriveProbe(request("/identity", token), preview, dependencies);
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(await response.text(), new RegExp(secret));
  }
  assert.deepEqual(counts, { databases: 0, operations: 0 });
});

test("rejects unsupported operation before database creation", async () => {
  const { counts, dependencies } = testDependencies();
  const response = await handleHyperdriveProbe(request("/auth/me"), preview, dependencies);
  assert.equal(response.status, 404);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(counts, { databases: 0, operations: 0 });
});

test("requires preview environment", async () => {
  const { counts, dependencies } = testDependencies();
  const response = await handleHyperdriveProbe(request("/identity"), {
    ...preview, ENVIRONMENT: "production",
  }, dependencies);
  assert.equal(response.status, 503);
  assert.deepEqual(counts, { databases: 0, operations: 0 });
});

test("requires POST on fixed operations", async () => {
  const { counts, dependencies } = testDependencies();
  const response = await handleHyperdriveProbe(request("/identity", secret, "GET"), preview, dependencies);
  assert.equal(response.status, 405);
  assert.deepEqual(counts, { databases: 0, operations: 0 });
});

test("authenticated fixed operation gets one request-scoped database", async () => {
  const { counts, dependencies } = testDependencies();
  const response = await handleHyperdriveProbe(request("/identity"), preview, dependencies);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(counts, { databases: 1, operations: 1 });
});

test("default probe runner executes the fixed query through its database", async () => {
  const database = {
    async query(sql: string, values: unknown[]) {
      assert.match(sql, /\$1/);
      assert.deepEqual(values, ["vapt-stage10"]);
      return { rows: [{ marker: "vapt-stage10" }] };
    },
  } as unknown as Pool;

  const response = await handleHyperdriveProbe(request("/query"), preview, {
    createDatabase: () => database,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, parameterized: true });
});
