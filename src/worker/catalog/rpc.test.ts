import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../lib/errors.js";
import { catalogRpcReply, unwrapCatalogRpc } from "./rpc.js";

test("catalog RPC preserves business status without Error prototype identity or private diagnostic values", async () => {
  const reply = await catalogRpcReply(async () => { throw new AppError(409, "catalog_operation_conflict", "private synthetic detail", { private: "synthetic" }); });
  const wire = JSON.parse(JSON.stringify(reply));
  assert.deepEqual(wire, { ok: false, error: { status: 409, code: "catalog_operation_conflict" } } as const);
  assert.throws(() => unwrapCatalogRpc(wire), error => error instanceof AppError && error.statusCode === 409
    && !error.message.includes("private"));
});

test("unknown transport/dependency errors become fixed503 without messages, stacks or causes", async () => {
  const reply = await catalogRpcReply(async () => { throw new Error("synthetic-private-database-url"); });
  assert.deepEqual(reply, { ok: false, error: { status: 503, code: "catalog_operation_unavailable" } });
});

test("plain successful values survive catalog RPC unchanged", async () => {
  assert.deepEqual(unwrapCatalogRpc(await catalogRpcReply(async () => ({ phase: "ready", version: "11" }))), { phase: "ready", version: "11" });
});

test("malformed error codes cannot be coerced into a trusted RPC error", () => {
  for (const code of [undefined, null, 123, {}, ["catalog_conflict"]]) {
    assert.throws(() => unwrapCatalogRpc({ ok: false, error: { status: 409, code } } as never),
      error => error instanceof AppError && error.statusCode === 503 && error.code === "catalog_operation_unavailable");
  }
});
