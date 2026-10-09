import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type Socket } from "node:net";
import { setImmediate as nextTurn } from "node:timers/promises";
import type { ExecutionContext } from "hono";
import { Pool } from "pg";

import type { AppConfig } from "../lib/config.js";
import type { Database } from "../lib/database.js";
import { createWorkerDatabase } from "./database.js";
import { createWorkerServices } from "./services.js";

const context = { waitUntil() {} } as unknown as ExecutionContext;
const preview = {
  ENVIRONMENT: "preview" as const,
  HYPERDRIVE: { connectionString: "postgresql://synthetic:private-sentinel@db.vapt.test/vapt" },
};

// Real pg transport with only the external Postgres handshake emulated.
async function handshakePeer(authenticate: boolean) {
  const sockets = new Set<Socket>();
  let observed!: () => void;
  const startup = new Promise<void>(resolve => { observed = resolve; });
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.once("data", () => {
      observed();
      if (authenticate) {
        // AuthenticationOk followed by ReadyForQuery (idle).
        socket.write(Buffer.from([82, 0, 0, 0, 8, 0, 0, 0, 0, 90, 0, 0, 0, 5, 73]));
        socket.on("data", bytes => { if (bytes[0] === 88) socket.end(); });
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    env: { ENVIRONMENT: "preview" as const, HYPERDRIVE: { connectionString: `postgresql://synthetic:private-sentinel@127.0.0.1:${address.port}/vapt?sslmode=disable` } },
    startup,
    destroySockets() { for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test("default Worker composition terminates a stalled SQL handshake after five seconds", async t => {
  const peer = await handshakePeer(false);
  const services = await createWorkerServices(peer.env, context, { config: {} as AppConfig });
  const pool = services.database as Pool;
  pool.on("error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failure: unknown;
  const readFailure = (): unknown => failure;
  const checkout = pool.connect().then(client => { client.release(); }, error => { failure = error; });
  try {
    await peer.startup;
    t.mock.timers.tick(4_999);
    await nextTurn();
    assert.equal(failure, undefined);
    t.mock.timers.tick(1);
    await nextTurn();
    await nextTurn();
    const observedFailure = readFailure();
    assert.ok(observedFailure instanceof Error, "stalled checkout must terminate at five seconds");
    assert.match(observedFailure.message, /timeout/i);
    assert.doesNotMatch(observedFailure.message, /private-sentinel/);
    await checkout;
    assert.equal(pool.totalCount, 0);
  } finally {
    peer.destroySockets();
    await checkout;
    await pool.end();
    await peer.close();
    t.mock.timers.reset();
  }
});

test("default Worker pool removes an expired checkout without releasing the current owner", async t => {
  const peer = await handshakePeer(true);
  const pool = createWorkerDatabase(peer.env);
  pool.on("error", () => {});
  const owner = await pool.connect();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let failure: unknown;
  const readFailure = (): unknown => failure;
  const queued = pool.connect().then(client => { client.release(); }, error => { failure = error; });
  try {
    t.mock.timers.tick(4_999);
    await nextTurn();
    assert.equal(failure, undefined);
    assert.equal(pool.waitingCount, 1);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.ok(readFailure() instanceof Error, "queued checkout must terminate at five seconds");
    assert.equal(pool.waitingCount, 0);
    assert.equal(pool.totalCount, 1);
    assert.equal(pool.idleCount, 0);
    await queued;
    assert.equal(pool.options.query_timeout, undefined, "normal SQL must use server cancellation, not read-abandon timeout");
  } finally {
    owner.release();
    await queued;
    await pool.end();
    await peer.close();
    t.mock.timers.reset();
  }
});

test("rejects missing Hyperdrive without secret echo", () => {
  assert.throws(
    () => createWorkerDatabase({ HYPERDRIVE: undefined }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /HYPERDRIVE/);
      assert.doesNotMatch(error.message, /private-sentinel/);
      return true;
    },
  );
});

test("creates distinct max-one pools", async () => {
  const first = createWorkerDatabase(preview);
  const second = createWorkerDatabase(preview);
  try {
    assert.notStrictEqual(first, second);
    assert.equal(first.options.max, 1);
    assert.equal(second.options.max, 1);
  } finally {
    await Promise.all([first.end(), second.end()]);
  }
});

test("bounds diagnostic checkout, statement, read and lock waits", async () => {
  const pool = createWorkerDatabase(preview, { diagnostic: true });
  try {
    const statementTimeout = Number(pool.options.statement_timeout ?? 0);
    assert.ok((pool.options.connectionTimeoutMillis ?? 0) > 0);
    assert.ok(statementTimeout > 0);
    assert.ok((pool.options.query_timeout ?? 0) > statementTimeout);
    assert.ok(Number(pool.options.lock_timeout ?? 0) > 0);
    assert.ok(Number(pool.options.lock_timeout ?? 0) < statementTimeout);
  } finally {
    await pool.end();
  }
});

test("service composition uses a max-one pool", async () => {
  const services = await createWorkerServices(preview, context, { config: {} as AppConfig });
  assert.ok(services.database instanceof Pool);
  const pool = services.database as Pool;
  try {
    assert.equal(pool.options.max, 1);
  } finally {
    await pool.end();
  }
});

test("honors injected database", async () => {
  const injected = {
    async query() { return { rows: [] }; },
    async connect() { throw new Error("not used"); },
  } as unknown as Database;
  const services = await createWorkerServices({ ENVIRONMENT: "preview" }, context, {
    config: {} as AppConfig,
    database: injected,
  });
  assert.strictEqual(services.database, injected);
});
