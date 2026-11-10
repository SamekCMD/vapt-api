import assert from "node:assert/strict";
import test from "node:test";
import type { Database } from "../../lib/database.js";
import { AppError } from "../../lib/errors.js";
import { applyCatalogCommand, findCommittedCommand } from "./transaction.js";
import { allocateOnboardingRestaurantId, fingerprintCommand } from "./policy.js";
import type { CatalogCommand } from "./contracts.js";

const owner = "11111111-1111-4111-8111-111111111111";
const restaurant = "22222222-2222-4222-8222-222222222222";
const operation = "33333333-3333-4333-8333-333333333333";
const session = "44444444-4444-4444-8444-444444444444";
const organization = '55555555-5555-4555-8555-555555555555';
const command: CatalogCommand = { operationId: operation, restaurantId: restaurant,
  actor: { userId: owner, sessionId: session, sessionExpiresAt: 4_000_000_000_000 },
  mutation: { type: "restaurant.patch", input: { name: "Novo bistrô", cnpj: "synthetic-private" } } };

// Models the query boundary, not PostgreSQL isolation. Real isolation is a separate integration gate.
function databaseFixture(options: { empty?: boolean; restaurantId?: string } = {}) {
  const fixtureRestaurant = options.restaurantId ?? restaurant;
  const calls: { sql: string; values: unknown[] }[] = [];
  let journal: Record<string, unknown> | null = null;
  let original: Record<string, unknown> | null = null;
  let validSession = true;
  let failJournal = false;
  let oversized = false;
  let nextRevision = 9007199254740992n;
  let mutations = 0;
  let committedMutations = 0;
  let commits = 0;
  let name = "Bistrô";
  let savedName = name;
  let exists = !options.empty;
  let slug = "bistro";
  let item: Record<string, unknown> | null = null;
  let savedDomain: { exists: boolean; slug: string; item: Record<string, unknown> | null };
  const itemRow = () => ({ id: session, restaurant_id: fixtureRestaurant, name: "Prato", price: "12.00",
    description: null, category: "Pratos", available: true, image_url: null, available_from: null,
    available_until: null, badge: null, is_chef_suggestion: false, prep_time_minutes: null,
    created_at: "2026-10-15T00:00:00Z", updated_at: "2026-10-15T00:00:00Z", variations: [] });
  const row = () => ({ id: fixtureRestaurant, organization_id:organization, owner_id: owner, name, slug, cnpj: "synthetic-private",
    whatsapp: null, address: null, phone: null, hours: null, description: oversized ? "é".repeat(4_194_304) : null,
    primary_color: "#123456", secondary_color: "#654321", font_family: "modern", logo_url: null,
    plan_type: "starter", plan_status: "active", trial_ends_at: null, total_tables: 1, max_tables: 1,
    payment_mode: "open_tab", max_pending_orders: 3, local_enabled: true, delivery_enabled: true,
    onboarding_completed: true, updated_at: "2026-10-15T00:00:00.000Z" });
  const client = {
    async query(sql: string, values: unknown[] = []) {
      calls.push({ sql, values });
      if (sql === "BEGIN") { original = structuredClone(journal); savedName = name;
        savedDomain = structuredClone({ exists, slug, item }); return { rows: [] }; }
      if (sql === "ROLLBACK") { journal = original; name = savedName; mutations = 0;
        ({ exists, slug, item } = savedDomain); return { rows: [] }; }
      if (sql === "COMMIT") { commits++; committedMutations += mutations; mutations = 0; return { rows: [] }; }
      if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
      if (sql.includes("delete from public.catalog_publication_operations")) return { rows: [] };
      if (sql.includes("from public.catalog_publication_operations")) return { rows: journal ? [journal] : [] };
      if (sql.includes('from better_auth."session"')) return { rows: validSession ? [{ id: session }] : [] };
      if (sql.includes("nextval(")) return { rows: [{ version: String(++nextRevision) }] };
      if (sql.includes("insert into public.catalog_publication_revisions")) return { rows: [] };
      if (sql.includes("insert into public.catalog_publication_operations")) {
        if (failJournal) throw new Error("fixture journal unavailable");
        journal = { operation_id: values[0], actor_id: values[1], restaurant_id: values[2], fingerprint: values[3],
          version: values[4], snapshot: JSON.parse(values[5] as string), result: JSON.parse(values[6] as string),
          previous_slug: values[7], expires_at: new Date("2100-01-01") };
        return { rows: [] };
      }
      if(sql.startsWith('select r.organization_id,m.role from public.restaurants r')) {
        assert.deepEqual(values,[fixtureRestaurant,owner]);
        return { rows:exists?[{ organization_id:organization,role:'owner' }]:[] };
      }
      if (/update public\.restaurants/i.test(sql)) { mutations++; name = values[0] as string; return { rows: [row()] }; }
      if (sql.includes("insert into public.restaurants")) {
        assert.equal(values[3], fixtureRestaurant, "onboarding inserts its preallocated UUID");
        exists = true; mutations++; name = values[1] as string; slug = values[2] as string; return { rows: [row()] };
      }
      if (sql.includes("insert into public.menu_items")) { mutations++; item = itemRow(); return { rows: [{ id: session }] }; }
      if (sql.includes("delete from public.menu_items")) { const deleted = item; item = null; mutations++;
        return { rows: deleted ? [{ id: session }] : [] }; }
      if (sql.includes("from public.menu_items")) return { rows: item ? [item] : [] };
      if (sql.includes("from public.restaurants")) return { rows: exists ? [row()] : [] };
      throw new Error(`Unexpected query in test fixture: ${sql.slice(0, 80)}`);
    },
    release() { calls.push({ sql: "RELEASE", values: [] }); },
  };
  const database = { query: async () => { throw new Error("Pool query outside transaction"); },
    connect: async () => client } as unknown as Database;
  return { database, calls, journal: () => journal, name: () => name, commits: () => commits,
    seedItem: () => { item = itemRow(); },
    committedMutations: () => committedMutations, revoke: () => { validSession = false; },
    failJournal: () => { failJournal = true; }, oversized: () => { oversized = true; } };
}

test("atomicJournalAndDomain commits one connection, consistent snapshot and no private projection fields", async () => {
  const fixture = databaseFixture();
  const outcome = await applyCatalogCommand(fixture.database, command);
  assert.equal(outcome.receipt.phase, "committed");
  assert.equal(outcome.receipt.version, "9007199254740993");
  assert.equal(outcome.state.catalog.restaurant.name, "Novo bistrô");
  assert.equal("cnpj" in outcome.state.catalog.restaurant, false);
  assert.equal("ownerId" in outcome.state.catalog.restaurant, false);
  assert.equal(fixture.committedMutations(), 1);
  assert.equal(fixture.commits(), 1);
  assert.equal(fixture.calls.filter(call => call.sql === "BEGIN").length, 1);
  assert.equal(fixture.calls.at(-1)?.sql, "RELEASE");
  assert.ok(fixture.journal());
});

test("image attachment is checked after owner/session locks and before any domain effect", async () => {
  const fixture = databaseFixture();
  const imageCommand: CatalogCommand = { ...command, mutation: { type: "restaurant.patch", input: {
    logoUrl: `https://assets.test/${restaurant}/${session}/${operation}`,
  } } };
  let checked = false;
  await assert.rejects(applyCatalogCommand(fixture.database, imageCommand, { validateImages: async () => {
    checked = true;
    assert.ok(fixture.calls.some(call => call.values.includes(`tenant:restaurant:${restaurant}`)));
    assert.ok(fixture.calls.some(call => call.sql.includes('from better_auth."session"') && /for share/i.test(call.sql)));
    assert.equal(fixture.calls.some(call => /update public\.restaurants/i.test(call.sql)), false);
    throw new AppError(410, "menu_image_upload_expired", "Image was retired");
  } } as never), error => error instanceof AppError && error.statusCode === 410);
  assert.equal(checked, true);
  assert.equal(fixture.committedMutations(), 0);
  assert.equal(fixture.commits(), 0);
});

test("a new image reference cannot bypass validation through an alternate applier caller", async () => {
  const fixture = databaseFixture();
  await assert.rejects(applyCatalogCommand(fixture.database, { ...command, mutation: {
    type: "restaurant.patch", input: { logoUrl: "https://assets.test/unchecked" },
  } }), error => error instanceof AppError && error.code === "catalog_image_validation_required");
  assert.equal(fixture.committedMutations(), 0);
});

test("journal failure rolls domain back instead of publishing an unjournaled mutation", async () => {
  const fixture = databaseFixture(); fixture.failJournal();
  await assert.rejects(applyCatalogCommand(fixture.database, command));
  assert.equal(fixture.name(), "Bistrô");
  assert.equal(fixture.journal(), null);
  assert.equal(fixture.commits(), 0);
});

test("duplicate mutation recovers the original result without a second domain write", async () => {
  const fixture = databaseFixture();
  const first = await applyCatalogCommand(fixture.database, command);
  assert.deepEqual(await applyCatalogCommand(fixture.database, command), first);
  assert.equal(fixture.committedMutations(), 1);
  await assert.rejects(applyCatalogCommand(fixture.database, { ...command,
    mutation: { type: "restaurant.patch", input: { name: "Conflict" } } }),
  (error: unknown) => error instanceof AppError && error.statusCode === 409);
});

test("revocationBeforeApply denies the pending write before changing domain", async () => {
  const fixture = databaseFixture(); fixture.revoke();
  await assert.rejects(applyCatalogCommand(fixture.database, command),
    (error: unknown) => error instanceof AppError && error.statusCode === 401);
  assert.equal(fixture.name(), "Bistrô"); assert.equal(fixture.commits(), 0);
});

test("publishAfterRevocation recovers committed work but rejects a different actor", async () => {
  const fixture = databaseFixture();
  const first = await applyCatalogCommand(fixture.database, command); fixture.revoke();
  const identity = { operationId: operation, restaurantId: restaurant, actor: command.actor,
    fingerprint: await fingerprintCommand(command) };
  assert.deepEqual(await findCommittedCommand(fixture.database, identity), first);
  await assert.rejects(findCommittedCommand(fixture.database, { ...identity,
    actor: { ...command.actor, userId: restaurant } }),
  (error: unknown) => error instanceof AppError && error.statusCode === 409);
});

test("oversizeRollback measures UTF8 snapshot bytes before COMMIT", async () => {
  const fixture = databaseFixture(); fixture.oversized();
  await assert.rejects(applyCatalogCommand(fixture.database, command),
    (error: unknown) => error instanceof AppError && error.code === "catalog_snapshot_too_large");
  assert.equal(fixture.name(), "Bistrô"); assert.equal(fixture.journal(), null);
  assert.equal(fixture.commits(), 0);
});

test("slugSerialization takes slug locks and session row lock before allocating the public revision", async () => {
  const fixture = databaseFixture(); await applyCatalogCommand(fixture.database, command);
  const revision = fixture.calls.findIndex(call => call.sql.includes("nextval("));
  const slugLock = fixture.calls.findIndex(call => call.sql.includes("pg_advisory_xact_lock")
    && call.values.some(value => value === "tenant:slug:bistro"));
  const sessionLock = fixture.calls.findIndex(call => call.sql.includes('from better_auth."session"') && /for share/i.test(call.sql));
  assert.ok(slugLock >= 0 && slugLock < revision);
  assert.ok(sessionLock >= 0 && sessionLock < revision);
});

test("duplicateCreateDeleteAndOnboarding never starts a second nested transaction or repeats a domain effect", async () => {
  const createFixture = databaseFixture();
  const create: CatalogCommand = { ...command, mutation: { type: "item.create", input: { name: "Prato", price: "12.00",
    description: null, category: "Pratos", available: true, imageUrl: null, availableFrom: null,
    availableUntil: null, badge: null, isChefSuggestion: false, prepTimeMinutes: null, variations: [] } } };
  const created = await applyCatalogCommand(createFixture.database, create);
  assert.equal(created.state.catalog.items.length, 1);
  assert.equal(createFixture.calls.filter(call => call.sql === "BEGIN").length, 1);
  assert.deepEqual(await applyCatalogCommand(createFixture.database, create), created);
  assert.equal(createFixture.committedMutations(), 1);

  const deleteFixture = databaseFixture(); deleteFixture.seedItem();
  const deletion: CatalogCommand = { ...command, mutation: { type: "item.delete", itemId: session } };
  const deleted = await applyCatalogCommand(deleteFixture.database, deletion);
  assert.equal(deleted.state.catalog.items.length, 0);
  assert.deepEqual(await applyCatalogCommand(deleteFixture.database, deletion), deleted);
  assert.equal(deleteFixture.committedMutations(), 1);

  const id = await allocateOnboardingRestaurantId(owner, operation);
  const onboardingFixture = databaseFixture({ empty: true, restaurantId: id });
  const onboarding: CatalogCommand = { ...command, restaurantId: id, mutation: { type: "onboarding", input: {
    restaurantName: "Bistrô", slug: "novo-bistro", dishName: "Prato", dishPrice: "12.00" } } };
  await assert.rejects(applyCatalogCommand(onboardingFixture.database,onboarding),{statusCode:410,code:'legacy_onboarding_retired'});
  assert.equal(onboardingFixture.committedMutations(),0);
});
