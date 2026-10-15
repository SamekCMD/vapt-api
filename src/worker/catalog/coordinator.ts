import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState, R2Bucket, Response as PlatformResponse } from "@cloudflare/workers-types";
import type { Pool } from "pg";
import { AppError } from "../../lib/errors.js";
import type { CatalogCommand, CatalogState } from "../../modules/catalog-publication/contracts.js";
import { applyCatalogCommand, findCommittedCommand } from "../../modules/catalog-publication/transaction.js";
import { createWorkerDatabase } from "../database.js";
import { configFromWorkerBindings, type WorkerBindings } from "../environment.js";
import { SqliteCommandStore } from "./command-store.js";
import { createCatalogProjection } from "./projection.js";
import { createCatalogCoordinator, type CatalogCoordinator, type OperationAccess } from "./runner.js";
import { catalogRpcReply } from "./rpc.js";
import { SqliteImageBudget } from "./image-budget.js";
import { createCatalogImageService, type CatalogImagePrepare, type CatalogImageRetire } from "./image-service.js";
import { createWorkerMenuImageGateway } from "../../modules/storage/r2-worker.js";

// Not bound/exported by a deployed entry until the later writer/ingress gates.
export class PublicCatalogCoordinator extends DurableObject<WorkerBindings> {
  private readonly runner: CatalogCoordinator;
  readonly #commands: SqliteCommandStore;
  readonly #images: SqliteImageBudget;

  constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    const store = new SqliteCommandStore(ctx.storage.sql);
    this.#commands = store;
    this.#images = new SqliteImageBudget(ctx.storage.sql);
    this.runner = createCatalogCoordinator({
      store, now: () => Date.now(),
      storage: {
        transaction: work => ctx.storage.transaction(async () => work()),
        setAlarm: at => ctx.storage.setAlarm(at), deleteAlarm: () => ctx.storage.deleteAlarm(), sync: () => ctx.storage.sync(),
      },
      apply: command => this.#withDatabase(database => applyCatalogCommand(database, command, {
        publicBaseUrl: env.R2_PUBLIC_BASE_URL ? new URL(env.R2_PUBLIC_BASE_URL) : null,
        validateImages: value => this.#imageService(database).validateAttachment(value),
      })),
      findCommitted: identity => this.#withDatabase(database => findCommittedCommand(database, identity)),
      project: value => this.#projection().publish(value),
      signal: state => this.sendPublishedSignal(state),
      prune: (id, cursor) => this.#projection().prune(id, cursor),
    });
  }

  #projection() {
    const bucket = this.env.R2_BUCKET;
    if (!bucket?.get || !bucket.put || !bucket.list) throw new AppError(503, "catalog_storage_unavailable", "Catalog storage unavailable");
    return createCatalogProjection(bucket as Pick<R2Bucket, "get" | "put" | "list">, this.env.ENVIRONMENT);
  }

  #imageService(database: Pool) {
    const bucket = this.env.R2_BUCKET;
    const config = configFromWorkerBindings(this.env).r2;
    if (!config || !bucket?.head || !bucket.put || !bucket.list) throw new AppError(503, "menu_image_storage_unavailable", "Image storage unavailable");
    return createCatalogImageService({
      database, budget: this.#images, bucket: bucket as Pick<R2Bucket, "head" | "put" | "list" | "delete">,
      signer: createWorkerMenuImageGateway(config, bucket), publicBaseUrl: config.publicBaseUrl,
      ttlMs: config.uploadUrlTtlSeconds * 1000, now: () => Date.now(),
      exclusive: work => this.runner.exclusive(work),
      atomic: async work => {
        const result = await this.ctx.storage.transaction(async () => work());
        await this.ctx.storage.sync(); return result;
      },
      hasUnresolvedCommands: () => this.#commands.hasUnresolved(), projection: this.#projection(),
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
  prepareImage(input: CatalogImagePrepare) { return catalogRpcReply(() => this.#withDatabase(database => this.#imageService(database).prepare(input))); }
  retireImage(input: CatalogImageRetire) { return catalogRpcReply(() => this.#withDatabase(database => this.#imageService(database).retire(input))); }
  alarm() { return this.runner.alarm(); }
  async fetch(): Promise<PlatformResponse> { return new Response(null, { status: 404 }) as unknown as PlatformResponse; }
}
