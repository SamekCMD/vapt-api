export type ApiDiagnosticCode = "config_invalid" | "http_5xx" | "fetch_failed" | "scheduled_failed";
export type DiagnosticDataPoint = { indexes: string[]; blobs: string[]; doubles: number[] };
export type DiagnosticDataset = { writeDataPoint(point: DiagnosticDataPoint): void };
const codes = new Set<unknown>(["config_invalid", "http_5xx", "fetch_failed", "scheduled_failed"]);

// No Request, Error, identifiers or arbitrary labels cross this boundary.
// Construct once per invocation; native writes are synchronous/backgrounded.
export function createApiDiagnostics(binding?: DiagnosticDataset): (code: ApiDiagnosticCode) => void {
  const seen = new Set<ApiDiagnosticCode>();
  return code => {
    if (!binding || !codes.has(code) || seen.has(code)) return;
    seen.add(code);
    try { binding.writeDataPoint({ indexes: [`api:${code}`], blobs: ["api", code], doubles: [1] }); }
    catch { /* Diagnostics must not change business outcomes or log raw failures. */ }
  };
}
