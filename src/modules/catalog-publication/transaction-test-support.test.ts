import assert from "node:assert/strict";
import test from "node:test";
import { requireLocalCatalogTestUrl } from "./transaction-test-support.js";

test("integration guard refuses absent, remote, non-test and redirected database URLs", () => {
  for (const value of [undefined, "", "postgres://user:pass@db.neon.tech/vapt_catalog_test_case",
    "postgres://user:pass@127.0.0.1/vapt", "postgres://user:pass@127.0.0.1/vapt_catalog_test_case?host=remote.example",
    "postgres://user:pass@127.0.0.1/vapt_catalog_test_case#fragment", "https://127.0.0.1/vapt_catalog_test_case"]) {
    assert.throws(() => requireLocalCatalogTestUrl(value), error => error instanceof Error
      && !error.message.includes("pass") && error.message.includes("CATALOG_TEST_DATABASE_URL"));
  }
  const local = "postgres://catalog_test:synthetic@127.0.0.1:5432/vapt_catalog_test_case";
  assert.equal(requireLocalCatalogTestUrl(local), local);
});
