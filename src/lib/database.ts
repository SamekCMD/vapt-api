import type { Pool, PoolClient } from "pg";

export type Queryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;
export type Database = Pick<Pool, "query" | "connect">;

export async function withTransaction<T>(
  database: Database,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
