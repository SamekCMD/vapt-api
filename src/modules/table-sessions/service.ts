import { AppError } from "../../lib/errors.js";
import type { TableSessionRepository } from "./repository.js";

export function createTableSessionService(repository: TableSessionRepository) {
  return {
    listActiveOwnedSessions(userId: string) {
      return repository.listActiveOwnedSessions(userId);
    },

    async getOwnedSession(userId: string, sessionId: string) {
      const detail = await repository.getOwnedSession(userId, sessionId);
      if (!detail) throw new AppError(404, "table_session_not_found", "Table session not found");
      return detail;
    },

    async closeOwnedSession(userId: string, sessionId: string) {
      const closed = await repository.closeOwnedSession(userId, sessionId);
      if (!closed) throw new AppError(404, "table_session_not_found", "Table session not found");
      return closed;
    },

    async transferOwnedSession(userId: string, sessionId: string, tableNumber: string) {
      const transferred = await repository.transferOwnedSession(userId, sessionId, tableNumber);
      if (!transferred) {
        throw new AppError(404, "table_session_not_found", "Table session not found");
      }
      if (transferred === "closed") {
        throw new AppError(409, "table_session_closed", "Closed table sessions cannot be transferred");
      }
      return transferred;
    },
  };
}
