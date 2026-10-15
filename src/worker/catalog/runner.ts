import type { CatalogCommand, CatalogActor, CatalogState, CommandIdentity, CommandOutcome, CommandReceipt } from "../../modules/catalog-publication/contracts.js";
import type { CommittedCommand } from "../../modules/catalog-publication/transaction.js";
import type { SqliteCommandStore } from "./command-store.js";
import type { StoredOperation } from "./command-store.js";
import { AppError } from "../../lib/errors.js";
import { fingerprintCommand, validateCatalogCommand } from "../../modules/catalog-publication/policy.js";

export type OperationAccess = { operationId: string; restaurantId: string; actor: CatalogActor };
export type CatalogCoordinatorPorts = {
  store: SqliteCommandStore; now(): number;
  storage: { transaction<T>(work: () => Promise<T>): Promise<T>; setAlarm(at: number): Promise<void>; deleteAlarm(): Promise<void>; sync(): Promise<void> };
  apply(command: CatalogCommand): Promise<CommittedCommand>;
  findCommitted(identity: CommandIdentity): Promise<CommittedCommand | null>;
  project(committed: CommittedCommand): Promise<CatalogState>;
  signal(state: CatalogState): Promise<void>;
  prune(restaurantId: string, cursor?: string): Promise<{ cursor?: string }>;
};
export type CatalogCoordinator = {
  submit(command: CatalogCommand): Promise<CommandOutcome<unknown>>;
  status(access: OperationAccess): Promise<CommandReceipt>;
  retry(access: OperationAccess): Promise<CommandReceipt>;
  alarm(): Promise<void>;
};
function receipt(operation: StoredOperation): CommandReceipt {
  const { operationId, restaurantId, phase, committed, version, retryable } = operation;
  return { operationId, restaurantId, phase, committed, version, retryable };
}

export function createCatalogCoordinator(ports: CatalogCoordinatorPorts): CatalogCoordinator {
  const { store, storage, now } = ports;
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const result = queue.then(work);
    queue = result.catch(() => undefined);
    return result;
  }
  async function atomic<T>(work: () => T): Promise<T> {
    const result = await storage.transaction(async () => {
      const value = work();
      const next = store.nextAlarm();
      if (next === null) await storage.deleteAlarm();
      else await storage.setAlarm(Math.max(now() + 1, next));
      return value;
    });
    await storage.sync(); // No external SQL starts before durable intent AND recovery schedule.
    return result;
  }
  function access(value: OperationAccess): StoredOperation {
    const operation = store.get(value.operationId);
    if (!operation || operation.restaurantId !== value.restaurantId || operation.userId !== value.actor.userId) {
      throw new AppError(404, "catalog_operation_not_found", "Catalog operation not found");
    }
    return operation;
  }
  async function drive(operationId: string, propagatePermanentError: boolean): Promise<unknown> {
    let result: unknown;
    for (let phase = 0; phase < 4; phase++) {
      let operation = store.get(operationId)!;
      if (!operation || operation.work === "none" || operation.nextAt === null || operation.nextAt > now()) break;
      const work = operation.work;
      if (operation.attempts >= 10) {
        await atomic(() => store.save({ ...operation, phase: work === "cleanup" ? "ready" : "blocked",
          work: "none", resumeWork: work, retryable: true, nextAt: null }));
        break;
      }
      operation = { ...operation, attempts: operation.attempts + 1, nextAt: now() + 5000 };
      operation = await atomic(() => store.save(operation)); // Consumes the attempt even if this invocation dies mid-I/O.
      try {
        if (work === "apply") {
          const command = store.intent(operationId);
          if (!command) throw new AppError(410, "catalog_intent_expired", "Catalog intent expired");
          const identity: CommandIdentity = { operationId, restaurantId: operation.restaurantId,
            actor: command.actor, fingerprint: operation.fingerprint };
          const recovered = operation.attempts > 1 ? await ports.findCommitted(identity) : null;
          const outcome = recovered ?? await ports.apply(command);
          result = outcome.result;
          await atomic(() => {
            store.saveProjection(operationId, outcome); store.eraseIntent(operationId);
            store.save({ ...operation, phase: "committed", committed: true, version: outcome.state.version,
              intentPresent: false, projectionPresent: true, work: "project", attempts: 0, nextAt: now() });
          });
        } else if (work === "project") {
          const outcome = store.projection(operationId);
          if (!outcome) throw new AppError(503, "catalog_projection_missing", "Catalog projection unavailable");
          const published = await ports.project(outcome);
          await atomic(() => {
            store.saveProjection(operationId, { ...outcome, state: published });
            store.save({ ...operation, phase: "projected", signalVersion: published.version,
              work: "signal", attempts: 0, nextAt: now() });
          });
        } else if (work === "signal") {
          const outcome = store.projection(operationId);
          if (!outcome) throw new AppError(503, "catalog_projection_missing", "Catalog projection unavailable");
          // Public data is readable before the signal. Keep its signal work
          // durable so a crash after ready but before broadcast is recoverable.
          operation = await atomic(() => store.save({ ...operation, phase: "ready" }));
          await ports.signal(outcome.state);
          await atomic(() => {
            store.eraseIntent(operationId); store.eraseProjection(operationId);
            store.save({ ...operation, phase: "ready", retryable: false, intentPresent: false,
              projectionPresent: false, work: "cleanup", attempts: 0, nextAt: now() });
          });
        } else {
          const page = await ports.prune(operation.restaurantId, operation.cleanupCursor);
          await atomic(() => store.save({ ...operation, work: page.cursor ? "cleanup" : "none", attempts: 0,
            cleanupCursor: page.cursor, nextAt: page.cursor ? now() + 5000 : null }));
          break; // At most one bounded cleanup page per invocation.
        }
      } catch (error) {
        const latest = store.get(operationId);
        if (latest && latest.checkpoint !== operation.checkpoint) {
          // The transaction may have committed even if its final sync/response
          // failed. Never overwrite that newer durable state with the old step.
          await atomic(() => undefined);
          break;
        }
        const permanent = error instanceof AppError && [400, 401, 403, 404, 409, 410, 413].includes(error.statusCode);
        const blocked = permanent || operation.attempts >= 10;
        const delay = Math.min(300_000, 5000 * 2 ** (operation.attempts - 1));
        await atomic(() => store.save({ ...operation,
          phase: blocked && work !== "cleanup" ? "blocked" : operation.phase,
          work: blocked ? "none" : work, resumeWork: blocked ? work : undefined,
          retryable: !permanent, nextAt: blocked ? null : now() + delay }));
        if (permanent && propagatePermanentError && !operation.committed) throw error;
        break;
      }
    }
    return result;
  }
  return {
    async submit(input) {
      const command = validateCatalogCommand(input);
      const fingerprint = await fingerprintCommand(command);
      return serial(async () => {
        await atomic(() => { store.expire(now()); store.accept(command, fingerprint, now()); });
        let result = await drive(command.operationId, true);
        const operation = store.get(command.operationId)!;
        if (result === undefined && operation.phase === "ready") {
          const original = await ports.findCommitted({ operationId: command.operationId, restaurantId: command.restaurantId,
            actor: command.actor, fingerprint });
          if (original) result = original.result;
        }
        return { receipt: receipt(operation), ...(result !== undefined ? { result } : {}) };
      });
    },
    status(value) { return serial(async () => {
      return atomic(() => { store.expire(now()); return receipt(access(value)); });
    }); },
    retry(value) { return serial(async () => {
      let operation = await atomic(() => { store.expire(now()); return access(value); });
      if (operation.work === "none" && operation.phase === "ready" && !operation.resumeWork) return receipt(operation);
      if (!operation.committed && !store.intent(operation.operationId)) {
        // Expired intentions may only recover an already committed result, never reapply a mutation.
        const recovered = await ports.findCommitted({ ...value, fingerprint: operation.fingerprint });
        if (!recovered) throw new AppError(410, "catalog_intent_expired", "Catalog intent expired");
        operation = { ...operation, phase: "committed", committed: true, version: recovered.state.version,
          work: "project", resumeWork: undefined, projectionPresent: true };
        await atomic(() => store.saveProjection(operation.operationId, recovered));
      }
      const work = operation.resumeWork ?? operation.work;
      const next: StoredOperation = { ...operation, work, resumeWork: undefined, attempts: 0, nextAt: now(), retryable: true,
        phase: work === "apply" ? "accepted" : work === "project" ? "committed" : work === "signal" ? "projected" : "ready" };
      await atomic(() => {
        if (!next.committed && store.intent(next.operationId)) store.refreshActor(next.operationId, value.actor);
        store.save(next);
      });
      await drive(next.operationId, true);
      return receipt(store.get(next.operationId)!);
    }); },
    alarm() { return serial(async () => {
      const due = await atomic(() => { store.expire(now()); return store.due(now()); });
      if (due) await drive(due.operationId, false);
    }); },
  };
}
