import type { WorkerBindings } from "../environment.js";
import { AppError } from "../../lib/errors.js";
import { compareVersion, parseCatalogSignal, type CatalogState, type CatalogSignal } from "../../modules/catalog-publication/contracts.js";
import { admitCatalogSocket, catalogClientFrameCloseCode, catalogSocketHasCapacity, parseCatalogAttachment, type CatalogSocketAttachment } from "./admission.js";
export type PublicCatalogSocket = {
  send(value: string): void; close(code: number, reason?: string): void;
  serializeAttachment(value: unknown): void; deserializeAttachment(): unknown;
};
type Ports<Client, Socket extends PublicCatalogSocket> = {
  env: WorkerBindings; belongs(id: string): boolean;
  readRegistration(id: string): Promise<{ version: string; canonicalSlug: string }>;
  sockets(): Socket[]; accept(socket: Socket): void; pair(): { client: Client; server: Socket };
};
export function createPublicCatalogSockets<Client, Socket extends PublicCatalogSocket>(ports: Ports<Client, Socket>) {
  function close(socket: Socket, code: number) {
    try { socket.serializeAttachment(null); } catch {}
    try { socket.close(code, "Invalid connection"); } catch {}
  }
  function attachment(socket: Socket): CatalogSocketAttachment | null {
    try {
      const value = parseCatalogAttachment(socket.deserializeAttachment());
      if (value && value.environment === ports.env.ENVIRONMENT && ports.belongs(value.restaurantId)) return value;
    } catch {}
    close(socket, 1008); return null;
  }
  function wire(signal: CatalogSignal): string {
    const value = JSON.stringify(signal);
    if (!parseCatalogSignal(value)) throw new AppError(503, "catalog_signal_invalid", "Public catalog unavailable");
    return value;
  }
  return {
    // The caller serializes admission with publication: no signal can fall
    // between this fresh registration read and accept/ready.
    async connect(request: Request): Promise<Client> {
      const admission = admitCatalogSocket(request, ports.env);
      if (!ports.belongs(admission.restaurantId)) throw new AppError(403, "forbidden", "Forbidden");
      const admittedVersion = request.headers.get("X-Vapt-Catalog-Version") ?? "";
      try { compareVersion(admittedVersion, "1"); }
      catch { throw new AppError(400, "invalid_request", "Invalid request"); }
      const current = await ports.readRegistration(admission.restaurantId);
      if (compareVersion(current.version, admittedVersion) < 0) throw new AppError(503, "catalog_not_ready", "Public catalog unavailable");
      const ready = wire({ protocol: "vapt.catalog.v1", type: "ready", ...current });
      // Nothing awaits between the count and acceptance, including a second
      // concurrent connect. Attachments are the only per-socket durable state.
      if (!catalogSocketHasCapacity(ports.sockets().length)) throw new AppError(503, "catalog_socket_capacity", "Public catalog unavailable");
      const { client, server } = ports.pair();
      server.serializeAttachment({ protocol: "vapt.catalog.v1", restaurantId: admission.restaurantId,
        environment: admission.environment, lastSentVersion: current.version } satisfies CatalogSocketAttachment);
      ports.accept(server);
      try { server.send(ready); } catch (error) { close(server, 1013); throw error; }
      return client;
    },
    async publish(state: CatalogState): Promise<void> {
      const sockets = ports.sockets();
      if (!sockets.length) return;
      const id = state.catalog.restaurant.id;
      if (!ports.belongs(id)) throw new AppError(403, "forbidden", "Forbidden");
      const current = await ports.readRegistration(id);
      if (compareVersion(current.version, state.version) < 0) throw new AppError(503, "catalog_not_ready", "Public catalog unavailable");
      const event = wire({ protocol: "vapt.catalog.v1", type: "catalog_changed", ...current });
      for (const socket of sockets) {
        const value = attachment(socket);
        if (!value || value.restaurantId !== id) { if (value) close(socket, 1008); continue; }
        if (compareVersion(current.version, value.lastSentVersion) <= 0) continue;
        try {
          socket.send(event);
          socket.serializeAttachment({ ...value, lastSentVersion: current.version });
        } catch { close(socket, 1013); }
      }
    },
    message(socket: Socket, message: string | ArrayBuffer): void {
      if (attachment(socket)) close(socket, catalogClientFrameCloseCode(message));
    },
    close,
  };
}
