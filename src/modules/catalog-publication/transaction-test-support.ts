// Test utility only. Never fall back to the application's DATABASE_URL.
export function requireLocalCatalogTestUrl(value: string | undefined): string {
  const unavailable = () => new Error("CATALOG_TEST_DATABASE_URL must explicitly target an isolated loopback vapt_catalog_test_* database");
  if (!value) throw unavailable();
  let url: URL;
  try { url = new URL(value); } catch { throw unavailable(); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)
    || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    || !/^\/vapt_catalog_test_[a-z0-9_]+$/.test(url.pathname)
    || url.hash || url.search) throw unavailable();
  return value;
}
