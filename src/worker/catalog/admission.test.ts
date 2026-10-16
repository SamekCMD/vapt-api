import assert from "node:assert/strict";
import test from "node:test";
import { AppError } from "../../lib/errors.js";
import type { WorkerBindings } from "../environment.js";
import { admitCatalogSocket, isCatalogReaderEnabled, parseCatalogAttachment, catalogSocketHasCapacity, catalogClientFrameCloseCode } from "./admission.js";
const restaurantId = "11111111-1111-4111-8111-111111111111";
const origin = "https://app.vapt.test";
const env = { ENVIRONMENT: "preview", PUBLIC_CATALOG_READER_ENABLED: "true", PUBLIC_CATALOG_WRITER_ENABLED: "true", CORS_ORIGINS: origin } as WorkerBindings;
const path = `/v1/catalog/restaurants/${restaurantId}/socket`;
test("admission accepts only exact published-channel paths, configured Origin and real Upgrade requests", () => {
  const request = (suffix = path, headers = { Origin: origin, Upgrade: "websocket" }) => new Request(`https://api.test${suffix}`, { headers });
  assert.deepEqual(admitCatalogSocket(request(), env), { restaurantId, environment: "preview", origin });
  for (const input of [request(`${path}?operation=submit`), request(path.replace(restaurantId, "invalid")),
    request(path, { Origin: "https://foreign.test", Upgrade: "websocket" }), request(path, { Origin: origin, Upgrade: "h2c" }),
    request(path, { Origin: "null", Upgrade: "websocket" })]) {
    assert.throws(() => admitCatalogSocket(input, env), error => error instanceof AppError && [400, 403].includes(error.statusCode));
  }
});
test("reader is off by default and cannot silently serve legacy SQL when configured inconsistently", () => {
  assert.equal(isCatalogReaderEnabled({ ENVIRONMENT: "preview" }), false);
  assert.equal(isCatalogReaderEnabled(env), true);
  assert.throws(() => isCatalogReaderEnabled({ ...env, PUBLIC_CATALOG_WRITER_ENABLED: "false" }));
  assert.throws(() => isCatalogReaderEnabled({ ...env, PUBLIC_CATALOG_READER_ENABLED: "yes" }));
});
test("public attachments contain only bounded public identity/version, never a private lease or grant", () => {
  const attachment = { protocol: "vapt.catalog.v1", restaurantId, environment: "preview", lastSentVersion: "9007199254740993" };
  assert.deepEqual(parseCatalogAttachment(attachment), attachment);
  assert.equal(parseCatalogAttachment({ ...attachment, expiresAt: 123, sessionId: restaurantId }), null);
  assert.equal(parseCatalogAttachment({ ...attachment, lastSentVersion: "1e3" }), null);
  assert.equal(catalogSocketHasCapacity(199), true); assert.equal(catalogSocketHasCapacity(200), false);
  assert.equal(catalogSocketHasCapacity(-1), false);
});
test("public visitors cannot write or smuggle binary/oversized frames; byte limits include UTF8", () => {
  assert.equal(catalogClientFrameCloseCode('{"type":"submit"}'), 1008);
  assert.equal(catalogClientFrameCloseCode("a".repeat(513)), 1009);
  assert.equal(catalogClientFrameCloseCode("é".repeat(257)), 1009);
  assert.equal(catalogClientFrameCloseCode(new ArrayBuffer(1)), 1003);
});
