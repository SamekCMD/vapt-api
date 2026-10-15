import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState, R2Bucket, Response as PlatformResponse } from "@cloudflare/workers-types";
import type { Pool } from "pg";
import { AppError } from "../../lib/errors.js";
import type { CatalogCommand, CatalogState } from "../../modules/catalog-publication/contracts.js";
import { applyCatalogCommand, findCommittedCommand } from "../../modules/catalog-publication/transaction.js";
import { createWorkerDatabase } from "../database.js";
import type { WorkerBindings } from "../environment.js";
import { SqliteCommandStore } from "./command-store.js";
import { createCatalogProjection } from "./projection.js";
import { createCatalogCoordinator, type CatalogCoordinator, type OperationAccess } from "./runner.js";
import { catalogRpcReply } from "./rpc.js";

// Not bound/exported by a deployed entry until the later writer/ingress gates.
export class PublicCatalogCoordinator extends DurableObject<WorkerBindings> {
  private readonly runner: CatalogCoordinator;

  constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    const store = new SqliteCommandStore(ctx.storage.sql);
    const projection = () => {
      const bucket = env.R2_BUCKET;
      if (!bucket?.get || !bucket.put || !bucket.list) {
        throw new AppError(503, "catalog_storage_unavailable", "Catalog storage unavailable");
      }
      return createCatalogProjection(bucket as Pick<R2Bucket, "get" | "put" | "list">, env.ENVIRONMENT);
    };
    this.runner = createCatalogCoordinator({
      store, now: () => Date.now(),
      storage: {
        transaction: work => ctx.storage.transaction(async () => work()),
        setAlarm: at => ctx.storage.setAlarm(at), deleteAlarm: () => ctx.storage.deleteAlarm(), sync: () => ctx.storage.sync(),
      },
      apply: command => this.#withDatabase(database => applyCatalogCommand(database, command, {
        publicBaseUrl: env.R2_PUBLIC_BASE_URL ? new URL(env.R2_PUBLIC_BASE_URL) : null,
      })),
      findCommitted: identity => this.#withDatabase(database => findCommittedCommand(database, identity)),
      project: value => projection().publish(value),
      signal: state => this.sendPublishedSignal(state),
      prune: (id, cursor) => projection().prune(id, cursor),
    });
  }

  async #withDatabase<T>(work: (database: Pool) => Promise<T>): Promise<T> {
    const database = createWorkerDatabase(this.env);
    try { return await work(database); } finally { await database.end(); }
  }

  protected async sendPublishedSignal(_state: CatalogState): Promise<void> {
    // T6 installs the public socket adapter before ingress is enabled. A room
    // without subscribers has nothing to send; never silently skip live sockets.
    if (this.ctx.getWebSockets().length) {
      throw new AppError(503, "catalog_signal_adapter_unavailable", "Catalog signal adapter unavailable");
    }
  }

  submit(command: CatalogCommand) { return catalogRpcReply(() => this.runner.submit(command)); }
  status(access: OperationAccess) { return catalogRpcReply(() => this.runner.status(access)); }
  retry(access: OperationAccess) { return catalogRpcReply(() => this.runner.retry(access)); }
  alarm() { return this.runner.alarm(); }
  async fetch(): Promise<PlatformResponse> { return new Response(null, { status: 404 }) as unknown as PlatformResponse; }
}
