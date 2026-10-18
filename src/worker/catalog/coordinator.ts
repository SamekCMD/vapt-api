import { DurableObject } from "cloudflare:workers";
import type { DurableObjectState, R2Bucket, Request as PlatformRequest, Response as PlatformResponse, WebSocket as PlatformSocket, WebSocketRequestResponsePair as PlatformAutoResponse } from "@cloudflare/workers-types";
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
import { createCatalogImageService, type CatalogImagePrepare, type CatalogImageRetire, type CatalogImageReconcile } from "./image-service.js";
import { createWorkerMenuImageGateway } from "../../modules/storage/r2-worker.js";
import { createPublicCatalogSockets } from "./public-sockets.js";

declare const WebSocketPair: { new(): { 0: PlatformSocket; 1: PlatformSocket } };
declare const WebSocketRequestResponsePair: { new(request: string, response: string): PlatformAutoResponse };

// Exported for the later append-only binding gate; no deployed config binds it.
export class PublicCatalogCoordinator extends DurableObject<WorkerBindings> {
  private readonly runner: CatalogCoordinator;
  readonly #commands: SqliteCommandStore;
  readonly #images: SqliteImageBudget;
  readonly #sockets: ReturnType<typeof createPublicCatalogSockets<PlatformSocket, PlatformSocket>>;

  constructor(ctx: DurableObjectState, env: WorkerBindings) {
    super(ctx, env);
    const store = new SqliteCommandStore(ctx.storage.sql);
    this.#commands = store;
    this.#images = new SqliteImageBudget(ctx.storage.sql);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("vapt.catalog.v1:ping", "vapt.catalog.v1:pong"));
    this.#sockets = createPublicCatalogSockets({
      env, belongs: id => !!env.PUBLIC_CATALOG_COORDINATOR && ctx.id.equals(env.PUBLIC_CATALOG_COORDINATOR.idFromName(`${env.ENVIRONMENT}:${id}`)),
      readRegistration: id => this.#projection().readRegistration(id),
      sockets: () => ctx.getWebSockets(), accept: socket => ctx.acceptWebSocket(socket),
      pair: () => { const pair = new WebSocketPair(); return { client: pair[0], server: pair[1] }; },
    });
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
    const bucket = this.env.PUBLIC_CATALOG_BUCKET;
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

  protected sendPublishedSignal(state: CatalogState): Promise<void> { return this.#sockets.publish(state); }

  submit(command: CatalogCommand) { return catalogRpcReply(() => this.runner.submit(command)); }
  status(access: OperationAccess) { return catalogRpcReply(() => this.runner.status(access)); }
  retry(access: OperationAccess) { return catalogRpcReply(() => this.runner.retry(access)); }
  prepareImage(input: CatalogImagePrepare) { return catalogRpcReply(() => this.#withDatabase(database => this.#imageService(database).prepare(input))); }
  retireImage(input: CatalogImageRetire) { return catalogRpcReply(() => this.#withDatabase(database => this.#imageService(database).retire(input))); }
  reconcileImages(input: CatalogImageReconcile) { return catalogRpcReply(() => this.#withDatabase(database => this.#imageService(database).reconcile(input))); }
  alarm() { return this.runner.alarm(); }
  async fetch(request: PlatformRequest): Promise<PlatformResponse> {
    // Native fetch preserves the upgrade response. There is deliberately no
    // anonymous HTTP dispatch to private submit/status/retry/image RPC methods.
    if (request.method !== "GET" || !/^\/v1\/catalog\/restaurants\/[a-fA-F0-9-]{36}\/socket$/.test(new URL(request.url).pathname)) {
      return new Response(null, { status: 404, headers: { "Cache-Control": "no-store" } }) as unknown as PlatformResponse;
    }
    try {
      return await this.runner.exclusive(async () => {
        const client = await this.#sockets.connect(request as unknown as Request);
        const headers = new Headers();
        if (request.headers.has("Sec-WebSocket-Protocol")) headers.set("Sec-WebSocket-Protocol", "vapt.catalog.v1");
        return new Response(null, { status: 101, webSocket: client, headers } as ResponseInit) as unknown as PlatformResponse;
      });
    } catch (error) {
      return new Response(null, { status: error instanceof AppError ? error.statusCode : 503,
        headers: { "Cache-Control": "no-store" } }) as unknown as PlatformResponse;
    }
  }
  webSocketMessage(socket: PlatformSocket, message: string | ArrayBuffer): void { this.#sockets.message(socket, message); }
  webSocketClose(socket: PlatformSocket): void { this.#sockets.close(socket, 1000); }
  webSocketError(socket: PlatformSocket): void { this.#sockets.close(socket, 1011); }
}
