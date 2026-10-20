import { AppError } from "../../lib/errors.js";
import type { RestaurantScope,RestaurantWriteScope,TenantActor } from '../tenancy/contracts.js';
import type { PublicOrderRecord } from "../orders/repository.js";
import type { TableSessionRepository } from "./repository.js";

export function createTableSessionService(repository: TableSessionRepository) {
  return {
    listActiveSessions(scope:RestaurantScope){ return repository.listActiveSessions(scope); },
    async getSession(scope:RestaurantScope,sessionId:string){
      const value=await repository.getSession(scope,sessionId);
      if(!value) throw new AppError(404,'table_session_not_found','Table session not found'); return value;
    },
    async closeSession(scope:RestaurantWriteScope,sessionId:string){
      const value=await repository.closeSession(scope,sessionId);
      if(!value) throw new AppError(404,'table_session_not_found','Table session not found'); return value;
    },
    async transferSession(scope:RestaurantWriteScope,sessionId:string,tableNumber:string){
      const value=await repository.transferSession(scope,sessionId,tableNumber);
      if(!value) throw new AppError(404,'table_session_not_found','Table session not found');
      if(value==='closed') throw new AppError(409,'table_session_closed','Closed table sessions cannot be transferred'); return value;
    },
    listActiveOwnedSessions(userId: string) {
      return repository.listActiveOwnedSessions(userId);
    },

    async getOwnedSession(userId: string, sessionId: string) {
      const detail = await repository.getOwnedSession(userId, sessionId);
      if (!detail) throw new AppError(404, "table_session_not_found", "Table session not found");
      return detail;
    },

    async closeOwnedSession(userId: string, sessionId: string,actor?:TenantActor) {
      const closed = await repository.closeOwnedSession(userId, sessionId,actor);
      if (!closed) throw new AppError(404, "table_session_not_found", "Table session not found");
      return closed;
    },

    async transferOwnedSession(userId: string, sessionId: string, tableNumber: string,actor?:TenantActor) {
      const transferred = await repository.transferOwnedSession(userId, sessionId, tableNumber,actor);
      if (!transferred) {
        throw new AppError(404, "table_session_not_found", "Table session not found");
      }
      if (transferred === "closed") {
        throw new AppError(409, "table_session_closed", "Closed table sessions cannot be transferred");
      }
      return transferred;
    },

    async requestPublicCheck(
      sessionId: string,
      order: Pick<PublicOrderRecord, "orderId" | "tableSessionId">,
    ) {
      if (order.tableSessionId !== sessionId) {
        throw new AppError(404, "table_session_not_found", "Table session not found");
      }
      const requested = await repository.requestPublicCheck(sessionId, order.orderId);
      if (!requested) {
        throw new AppError(404, "table_session_not_found", "Table session not found");
      }
      if (requested === "closed") {
        throw new AppError(409, "table_session_closed", "Closed table sessions cannot request a check");
      }
      return requested;
    },
  };
}
