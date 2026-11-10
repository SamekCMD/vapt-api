import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { compareVersion, type CommandReceipt } from "../src/modules/catalog-publication/contracts.js";

const projectId = "dawn-morning-27332079";
const targets = {
  preview: { branchId: "br-rough-dew-b6ydeygb", api: "https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev", origin: "https://infra-foundation-vapt-web.autoistloko.workers.dev" },
  production: { branchId: "br-odd-term-b6j2n9ms", api: "https://api.vapt.app.br", origin: "https://vapt.app.br" },
} as const;
const uuid = z.string().uuid().transform(value => value.toLowerCase());
const receiptSchema = z.object({ operationId: uuid, restaurantId: uuid, phase: z.enum(["accepted", "committed", "projected", "ready", "blocked"]),
  version: z.string().nullable(), committed: z.boolean(), retryable: z.boolean() }).strict().refine(value => {
    if (value.version !== null) { try { compareVersion(value.version, "1"); } catch { return false; } }
    if (value.phase === "accepted") return !value.committed && value.version === null;
    if (value.phase === "ready") return value.committed && value.version !== null;
    if (value.phase === "committed" || value.phase === "projected") return value.committed && value.version !== null;
    return value.committed ? value.version !== null : value.version === null;
  });
type Ports = { request?: typeof fetch; readSession?: () => Promise<string> };
type Report = { ok: false; code: string; operationId?: string }
  | { ok: true; environment: "preview" | "production"; targets: 1; writes: 0; mode: "dry-run" }
  | { ok: true; environment: "preview" | "production"; targets: 1; postRequests: 1; mode: "apply"; receipt: CommandReceipt };
const failure = (code: string, operationId?: string): Report => ({ ok: false, code, ...(operationId ? { operationId } : {}) });

function parseArguments(args: string[]) {
  const booleans = new Set(["--apply", "--confirm-writer-coverage", "--confirm-readiness"]);
  const values = new Set(["--environment", "--restaurant-id", "--operation-id", "--confirm-project-id", "--confirm-branch-id"]);
  const parsed = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const key = args[index]!;
    if (parsed.has(key)) throw new Error();
    if (booleans.has(key)) parsed.set(key, true);
    else if (values.has(key) && typeof args[index + 1] === "string" && !args[index + 1]!.startsWith("--")) parsed.set(key, args[++index]!);
    else throw new Error();
  }
  const environment = parsed.get("--environment");
  if (environment !== "preview" && environment !== "production") throw new Error();
  const restaurantId = uuid.parse(parsed.get("--restaurant-id"));
  const operation = parsed.get("--operation-id"); const operationId = operation === undefined ? undefined : uuid.parse(operation);
  const apply = parsed.get("--apply") === true;
  if (apply && (!operationId || parsed.get("--confirm-project-id") !== projectId || parsed.get("--confirm-branch-id") !== targets[environment].branchId
    || parsed.get("--confirm-writer-coverage") !== true || parsed.get("--confirm-readiness") !== true)) throw new Error();
  return { environment, restaurantId, operationId, apply, target: targets[environment] } as const;
}

async function readProtectedSession(): Promise<string> {
  if (process.stdin.isTTY) throw new Error(); // No interactive echo, browser login or credentials in arguments.
  let bytes = 0; const chunks: Buffer[] = [];
  for await (const value of process.stdin) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); bytes += chunk.length;
    if (bytes > 8192) throw new Error(); chunks.push(chunk);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).join(",") !== "cookie" || typeof (value as { cookie: unknown }).cookie !== "string") throw new Error();
  return (value as { cookie: string }).cookie;
}

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error();
  const reader = response.body.getReader(); let bytes = 0; const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength; if (bytes > 65_536) { await reader.cancel(); throw new Error(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

// Confirmation switches are operator acknowledgements, NOT evidence that the
// live SQL/CPU/privacy/writer/readback gates passed. Follow the approved runbook
// before --apply. This CLI never provisions resources or enables reader flags.
export async function bootstrapPublicCatalog(args: string[], ports: Ports = {}): Promise<Report> {
  let options: ReturnType<typeof parseArguments>;
  try { options = parseArguments(args); } catch { return failure("bootstrap_invalid_arguments"); }
  const { environment, restaurantId, operationId, target } = options;
  if (!options.apply) return { ok: true, environment, targets: 1, writes: 0, mode: "dry-run" };
  let cookie: string;
  try {
    cookie = await (ports.readSession ?? readProtectedSession)();
    if (typeof cookie !== "string" || !cookie.trim() || Buffer.byteLength(cookie) > 4096 || !/^[\x20-\x7e]+$/.test(cookie)) throw new Error();
  } catch { return failure("bootstrap_session_required"); }
  const request = ports.request ?? fetch;
  const base = { redirect: "error" as const, credentials: "omit" as const, cache: "no-store" as const };
  try {
    const response = await request(`${target.api}/restaurants/${restaurantId}`, { ...base, method: "GET", headers: { Cookie: cookie, Origin: target.origin }, signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200) return failure("bootstrap_preflight_failed");
    const owned = await boundedJson(response);
    if (!owned || typeof owned !== "object" || Array.isArray(owned) || (owned as { id?: unknown }).id !== restaurantId) return failure("bootstrap_target_mismatch");
  } catch { return failure("bootstrap_preflight_failed"); }
  try {
    const response = await request(`${target.api}/restaurants/${restaurantId}/catalog/rebuild`, { ...base, method: "POST", headers: {
      Cookie: cookie, Origin: target.origin, "Content-Type": "application/json", "X-Vapt-Catalog-Protocol": "1", "Idempotency-Key": operationId!,
    }, body: "{}", signal: AbortSignal.timeout(15_000) });
    if (response.status !== 200 && response.status !== 202) return failure(response.status >= 500 ? "bootstrap_confirmation_pending" : "bootstrap_rejected", operationId);
    const outcome = await boundedJson(response);
    if (!outcome || typeof outcome !== "object" || Array.isArray(outcome) || Object.keys(outcome).some(key => key !== "receipt" && key !== "result")) throw new Error();
    const parsed = receiptSchema.safeParse((outcome as { receipt?: unknown }).receipt);
    if (!parsed.success || parsed.data.operationId !== operationId || parsed.data.restaurantId !== restaurantId) throw new Error();
    return { ok: true, environment, targets: 1, postRequests: 1, mode: "apply", receipt: parsed.data };
  } catch { return failure("bootstrap_confirmation_pending", operationId); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await bootstrapPublicCatalog(process.argv.slice(2));
  console.log(JSON.stringify(result)); if (!result.ok) process.exitCode = 1;
}
