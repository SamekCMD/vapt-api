// Local workerd fixture only; never exported from a deployable entry.
import type { DurableObjectNamespace, DurableObjectState, R2Bucket, Request as PlatformRequest, WebSocket as PlatformSocket } from "@cloudflare/workers-types";
import type { ExecutionContext } from "hono";
import { createWorkerApp } from "./app.js";
import { PublicCatalogCoordinator } from "./catalog/coordinator.js";
import { createCatalogProjection } from "./catalog/projection.js";
import type { WorkerBindings } from "./environment.js";
import type { CatalogState } from "../modules/catalog-publication/contracts.js";
import { CatalogExecutionProbe } from "./catalog-executor-test-fixture.js";
import { SqliteImageBudget } from "./catalog/image-budget.js";
import { AppError } from "../lib/errors.js";
export { CatalogExecutionProbe };

type Env = Omit<WorkerBindings, "PUBLIC_CATALOG_COORDINATOR" | "R2_BUCKET"> & { PUBLIC_CATALOG_COORDINATOR: DurableObjectNamespace<CatalogRuntimeProbe>; CATALOG_EXECUTION_PROBE: DurableObjectNamespace<CatalogExecutionProbe>; R2_BUCKET: R2Bucket };
let serviceCalls = 0;
const app = createWorkerApp(async () => { serviceCalls++; throw new Error("Public reader must not construct SQL/auth services"); });
export class CatalogRuntimeProbe extends PublicCatalogCoordinator {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, { ...env, PUBLIC_CATALOG_COORDINATOR: env.PUBLIC_CATALOG_COORDINATOR as unknown as DurableObjectNamespace<PublicCatalogCoordinator> });
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS catalog_test_metrics (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    this.increment("constructors");
  }
  private increment(key: string) {
    this.ctx.storage.sql.exec("INSERT INTO catalog_test_metrics VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1", key);
  }
  async testSignal(state: CatalogState) { await this.sendPublishedSignal(state); }
  async testReserveImage(bytes: number) {
    try {
      const budget = new SqliteImageBudget(this.ctx.storage.sql);
      await this.ctx.storage.transaction(async () => budget.reserve({ bytes, now: Date.now(), ttlMs: 60_000,
        restaurantId: "11111111-1111-4111-8111-111111111111", itemId: "22222222-2222-4222-8222-222222222222",
        leaseId: "33333333-3333-4333-8333-333333333333", contentType: "image/webp" }, []));
      await this.ctx.storage.sync(); return { status: 200 };
    } catch (error) { return { status: error instanceof AppError ? error.statusCode : 503 }; }
  }
  async testInfo() {
    return { constructors: Number(this.ctx.storage.sql.exec("SELECT value FROM catalog_test_metrics WHERE key = 'constructors'").toArray()[0]?.value ?? 0),
      messages: Number(this.ctx.storage.sql.exec("SELECT value FROM catalog_test_metrics WHERE key = 'messages'").toArray()[0]?.value ?? 0),
      sockets: this.ctx.getWebSockets().length, attachments: this.ctx.getWebSockets().map(socket => socket.deserializeAttachment()), alarm: await this.ctx.storage.getAlarm() };
  }
  webSocketMessage(socket: PlatformSocket, message: string | ArrayBuffer) {
    this.increment("messages");
    super.webSocketMessage(socket, message);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/_test/execution/")) {
      const room = env.CATALOG_EXECUTION_PROBE.get(env.CATALOG_EXECUTION_PROBE.idFromName("execution"));
      const action = url.pathname.split("/").at(-1);
      if (action === "begin") return Response.json(await room.begin(await request.json() as Parameters<CatalogExecutionProbe["begin"]>[0]));
      if (action === "retry") return Response.json(await room.retryAfterReaderRollback());
      if (action === "idle") return Response.json(await room.idle());
      return new Response(null, { status: 404 });
    }
    if (url.pathname === "/_test/services") return Response.json({ calls: serviceCalls, hyperdrivePresent: !!env.HYPERDRIVE });
    if (url.pathname === "/_test/image-budget") {
      const room = env.PUBLIC_CATALOG_COORDINATOR.get(env.PUBLIC_CATALOG_COORDINATOR.idFromName("image-boundary"));
      const result = await room.testReserveImage((await request.json() as { bytes: number }).bytes);
      return Response.json({ ok: result.status === 200 }, { status: result.status });
    }
    if (url.pathname === "/_test/publish") {
      const state = await request.json() as CatalogState;
      try {
        await createCatalogProjection(env.R2_BUCKET, env.ENVIRONMENT).publish({ state, result: null, previousSlug: null,
          receipt: { operationId: state.catalog.restaurant.id, restaurantId: state.catalog.restaurant.id, phase: "committed", version: state.version, committed: true, retryable: true } });
        const room = env.PUBLIC_CATALOG_COORDINATOR.get(env.PUBLIC_CATALOG_COORDINATOR.idFromName(`${env.ENVIRONMENT}:${state.catalog.restaurant.id}`));
        await room.testSignal(state); return Response.json({ published: state.version });
      } catch { return Response.json({ ok: false }, { status: 503 }); }
    }
    if (url.pathname.startsWith("/_test/info/")) {
      const room = env.PUBLIC_CATALOG_COORDINATOR.get(env.PUBLIC_CATALOG_COORDINATOR.idFromName(`${env.ENVIRONMENT}:${url.pathname.split("/").at(-1)}`));
      return Response.json(await room.testInfo());
    }
    if (url.pathname.startsWith("/_test/anonymous-command/")) {
      const room = env.PUBLIC_CATALOG_COORDINATOR.get(env.PUBLIC_CATALOG_COORDINATOR.idFromName(`${env.ENVIRONMENT}:${url.pathname.split("/").at(-1)}`));
      return await room.fetch(new Request("https://catalog.internal/submit", { method: "POST", body: "{}" }) as unknown as PlatformRequest) as unknown as Response;
    }
    const headers = new Headers(request.headers); headers.set("CF-Connecting-IP", "203.0.113.1");
    return app.fetch(new Request(request, { headers }), { ...env, PUBLIC_RATE_LIMIT: { async limit() { return { success: true }; } } }, ctx);
  },
};
