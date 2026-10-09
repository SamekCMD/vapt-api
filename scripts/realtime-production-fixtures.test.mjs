import assert from 'node:assert/strict';
import test from 'node:test';

const tag = 'stage13-realtime-11111111-1111-4111-8111-111111111111';
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const manifest = () => [0, 1].map(index => ({ userId: id(index + 1), restaurantId: id(index + 3), itemId: id(index + 5),
  tag, slug: tag + '-' + index, email: tag + '-' + index + '@example.invalid' }));
const ownerUrl = 'postgresql://neondb_owner:synthetic-secret@ep-holy-wildflower-b6vtv1dd.c-2.sa-east-1.aws.neon.tech/vapt?sslmode=verify-full';
async function feature() {
  const module = await import('./realtime-production-fixtures.mjs').catch(() => null);
  assert.equal(typeof module?.createProductionFixtureDriver, 'function', 'production fixture guard not implemented');
  return module.createProductionFixtureDriver;
}
function database({ collision = false, mismatch = false, residue = 0, seedFailure = false } = {}) {
  const queries = []; let seeded = false, ended = false;
  const query = async (sql, params = []) => {
    queries.push({ sql, params });
    if (sql.includes('current_database')) return { rows: [{ database: 'vapt', role: 'neondb_owner' }] };
    if (sql.startsWith('SELECT id,name,email')) return { rows: seeded ? manifest().filter(v => v.userId === params[0]).map(v => ({ id: v.userId, name: mismatch ? 'another-account' : v.tag, email: v.email })) : collision ? [{ id: id(1), name: 'another-account', email: 'another@example.invalid' }] : [] };
    if (sql.startsWith('SELECT id,owner_id,name,slug')) return { rows: seeded ? manifest().filter(v => v.restaurantId === params[0]).map(v => ({ id: v.restaurantId, owner_id: v.userId, name: v.tag, slug: v.slug })) : [] };
    if (sql.startsWith('INSERT INTO better_auth.account')) {
      assert.equal(params[1], 'synthetic-password-hash');
      if (seedFailure) throw Error('synthetic-secret');
    }
    if (sql === 'COMMIT') seeded = true;
    if (sql.startsWith('SELECT id FROM public.orders')) return { rows: [{ id: id(10) }] };
    if (sql.startsWith('SELECT id FROM public.menu_items')) return { rows: manifest().map(v => ({ id: v.itemId })) };
    if (sql.includes('AS rows')) return { rows: [{ rows: residue }] };
    return { rows: [] };
  };
  const client = { query, release() {} };
  const pool = { query, async connect() { return client; }, async end() { ended = true; } };
  return { pool, queries, ended: () => ended };
}

test('fixture target and manifest reject preview or expanded cleanup authority before opening pool', async () => {
  const create = await feature(); let io = 0;
  for (const changes of [{ ownerUrl: ownerUrl.replace('ep-holy-wildflower-b6vtv1dd', 'ep-hidden-bird-b673zocn') },
    { ownerUrl: ownerUrl.replace('neondb_owner', 'vapt_api_production') }, { ownerUrl: ownerUrl.replace('verify-full', 'disable') },
    { manifest: [{ ...manifest()[0], email: 'real@example.com' }, manifest()[1]] },
    { manifest: [manifest()[0], manifest()[0]] }, { manifest: [{ ...manifest()[0], password: 'synthetic-secret' }, manifest()[1]] }]) {
    await assert.rejects(create({ ownerUrl, manifest: manifest(), createPool() { io++; }, ...changes }), error => !String(error).includes('synthetic-secret'));
  }
  assert.equal(io, 0);
});

test('production fixtures check absence, seed two accounts and delete only immutable owned manifest', async () => {
  const create = await feature(), db = database(), supplied = manifest();
  const driver = await create({ ownerUrl, manifest: supplied, createPool: () => db.pool, hash: async () => 'synthetic-password-hash' });
  supplied[0].userId = id(999); // caller mutations cannot expand the private deletion set
  const owners = await driver.seed();
  assert.equal(owners.length, 2); assert.equal(owners[0].userId, id(1));
  assert.equal(owners.every(v => typeof v.password === 'string' && v.password.length === 43), true);
  assert.equal(db.queries.filter(v => v.sql.startsWith('INSERT INTO better_auth."user"')).length, 2);
  await assert.rejects(driver.seed());
  assert.deepEqual(await driver.cleanup(), { rows: 0, tablesChecked: 12 });
  const deletes = db.queries.filter(v => v.sql.startsWith('DELETE'));
  assert.equal(deletes.length, 4);
  assert.equal(deletes.every(v => v.sql.includes('WHERE id=$1') && v.params.length >= 3), true);
  assert.doesNotMatch(JSON.stringify(deletes), /000000000999|synthetic-secret/);
  assert.equal(db.queries.at(-1).sql, 'COMMIT');
  await driver.close(); assert.equal(db.ended(), true);
});

test('seed collision or partial SQL failure rolls back and never deletes a colliding identity', async () => {
  const create = await feature();
  for (const options of [{ collision: true }, { seedFailure: true }]) {
    const db = database(options), driver = await create({ ownerUrl, manifest: manifest(), createPool: () => db.pool, hash: async () => 'synthetic-password-hash' });
    await assert.rejects(driver.seed(), error => !String(error).includes('synthetic-secret'));
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK');
    assert.equal(db.queries.some(v => v.sql.startsWith('DELETE')), false);
    await driver.close();
  }
});

test('cleanup refuses mismatched ownership and rolls back nonzero residue instead of reporting success', async () => {
  const create = await feature();
  for (const options of [{ mismatch: true }, { residue: 1 }]) {
    const db = database(options), driver = await create({ ownerUrl, manifest: manifest(), createPool: () => db.pool, hash: async () => 'synthetic-password-hash' });
    await driver.seed(); await assert.rejects(driver.cleanup());
    assert.equal(db.queries.at(-1).sql, 'ROLLBACK');
    if (options.mismatch) assert.equal(db.queries.some(v => v.sql.startsWith('DELETE')), false);
    await driver.close();
  }
});
