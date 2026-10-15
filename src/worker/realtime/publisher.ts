import { isRealtimeEnabled, type CommittedChangePublisher } from "../../modules/realtime/contracts.js";
import type { WorkerBindings } from "../environment.js";

export function createWorkerRealtimePublisher(
  env: WorkerBindings, onFailure: (code: "realtime_publish_failed") => void,
): CommittedChangePublisher {
  return async change => {
    if (!isRealtimeEnabled(env.REALTIME_ENABLED)) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!env.RESTAURANT_REALTIME) throw new Error("Unavailable room");
      const task = env.RESTAURANT_REALTIME.getByName(change.restaurantId).publish(change);
      await Promise.race([task, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Publish deadline")), 2000);
      })]);
    } catch {
      // Do not log exception text, grant, headers, URL, or business payload.
      try { onFailure("realtime_publish_failed"); } catch {}
    } finally { clearTimeout(timer); }
  };
}
