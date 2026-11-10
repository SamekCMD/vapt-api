export const realtimeTopics = ["orders", "kitchen", "table_sessions", "payments"] as const;
export type RealtimeTopic = (typeof realtimeTopics)[number];

export const realtimeReasons = [
  "created", "updated", "cancelled", "payment_changed", "check_requested", "closed", "transferred",
] as const;

export type CommittedChange = {
  restaurantId: string;
  topics: readonly RealtimeTopic[];
  orderIds: readonly string[];
  entityId: string;
  reason: (typeof realtimeReasons)[number];
};
export type CommittedChangePublisher = (change: CommittedChange) => Promise<void>;

export type RealtimeEnvelope = {
  version: 1;
  eventId: string;
  sequence: number;
  topic: RealtimeTopic;
  entityId: string;
  reason: CommittedChange["reason"];
};

export type RealtimeReady = { version: 1; type: "ready"; leaseExpiresAt: number };
export type RealtimeAck = { version: 1; type: "ack"; sequence: number };

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const envelopeKeys = new Set(["version", "eventId", "sequence", "topic", "entityId", "reason"]);

export function isRealtimeEnabled(value: string | undefined): boolean {
  return value === "true";
}

export function parseRealtimeEnvelope(value: unknown): RealtimeEnvelope | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Object.keys(value);
    if (keys.length !== envelopeKeys.size || keys.some((key) => !envelopeKeys.has(key))) return null;
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 4096) return null;
    const { version, eventId, sequence, topic, entityId, reason } = value as Record<string, unknown>;
    if (version !== 1 || typeof eventId !== "string" || !uuidPattern.test(eventId) ||
      typeof entityId !== "string" || !uuidPattern.test(entityId) ||
      typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0 ||
      !realtimeTopics.includes(topic as RealtimeTopic) ||
      !realtimeReasons.includes(reason as CommittedChange["reason"])) return null;
    return {
      version, eventId, sequence, topic: topic as RealtimeTopic, entityId,
      reason: reason as CommittedChange["reason"],
    };
  } catch {
    return null;
  }
}
