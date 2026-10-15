import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { reserveMigrationReport } from "./migration-report.js";

test("migration report refuses an existing path before it can be overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vapt-r2-report-"));
  const reportPath = join(directory, "report.json");
  await writeFile(reportPath, "original", "utf8");

  try {
    await assert.rejects(
      reserveMigrationReport(reportPath),
      (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST",
    );
    assert.equal(await readFile(reportPath, "utf8"), "original");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration report reservation writes and closes the reserved file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "vapt-r2-report-"));
  const reportPath = join(directory, "report.json");

  try {
    const reservation = await reserveMigrationReport(reportPath);
    await reservation.finalize("partial report\n");
    assert.equal(await readFile(reportPath, "utf8"), "partial report\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
