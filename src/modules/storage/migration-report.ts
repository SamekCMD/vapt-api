import { open } from "node:fs/promises";

export type MigrationReportReservation = {
  finalize(contents: string): Promise<void>;
};

export async function reserveMigrationReport(path: string): Promise<MigrationReportReservation> {
  const handle = await open(path, "wx");
  let finalized = false;

  return {
    async finalize(contents) {
      if (finalized) throw new Error("Migration report was already finalized");
      finalized = true;
      try {
        await handle.writeFile(contents, { encoding: "utf8" });
      } finally {
        await handle.close();
      }
    },
  };
}
