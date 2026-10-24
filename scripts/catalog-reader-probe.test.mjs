import assert from 'node:assert/strict';
import test from 'node:test';
import { structuredCatalogState } from '../src/worker/catalog-structured-test-support.ts';
const feature = () => import('./catalog-reader-probe.mjs').catch(() => ({}));
function fixture() {
  const states = ['items','variations'].map((shape, index) => structuredCatalogState(shape,'11', {
    restaurantId: index ? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    slug: index ? 'reader-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' : 'reader-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }));
  const objects = new Map(), puts = [], reads = [];
  const store = { async get(key) { return objects.get(key) ?? null; }, async put(key, body) { puts.push(key); objects.set(key, body); } };
  const request = async path => {
    reads.push(path);
    const state = states.find(value => path.includes(value.catalog.restaurant.slug)); assert.ok(state);
    return Response.json(path.endsWith('/catalog-state') ? state : state.catalog, { headers: { 'Cache-Control':'no-store' } });
  };
  return { states, objects, puts, reads, store, request };
}
test('probe seeds only six isolated keys, makes exactly four reads, and retires to verified fences', async () => {
  const { createCatalogReaderProbe } = await feature(); assert.equal(typeof createCatalogReaderProbe,'function');
  const f=fixture(), probe=createCatalogReaderProbe(f.states);
  await probe.prepare(f.store); assert.equal(f.puts.length,6);
  assert.ok(f.puts.every(key=>key.startsWith('catalog/v1/preview/')));
  const result=await probe.read(f.request); assert.equal(result.length,4); assert.equal(f.reads.length,4);
  assert.ok(result.every(value=>value.status===200));
  const retired=await probe.retire(f.store,{admissionClosed:true}); assert.equal(retired.objects,6);
  assert.ok(retired.bytes<1024); assert.ok([...f.objects.values()].every(body=>Buffer.byteLength(body)<512));
  assert.doesNotMatch(JSON.stringify(probe.summary()), /primaryColor|description|options/);
  await assert.rejects(()=>probe.prepare(f.store)); await assert.rejects(()=>probe.read(f.request));
  await assert.rejects(()=>probe.retire(f.store,{admissionClosed:true}));
  assert.equal(f.puts.length,12); assert.equal(f.reads.length,4);
});
test('foreign existing key stops before any PUT',async()=>{
  const { createCatalogReaderProbe }=await feature(); assert.equal(typeof createCatalogReaderProbe,'function');
  const f=fixture(),probe=createCatalogReaderProbe(f.states);
  f.store.get=async()=>'{"foreign":true}'; await assert.rejects(()=>probe.prepare(f.store)); assert.equal(f.puts.length,0);
});
test('uncertain PUT is never retried or speculatively retired',async()=>{
  const { createCatalogReaderProbe }=await feature(); assert.equal(typeof createCatalogReaderProbe,'function');
  const f=fixture(),probe=createCatalogReaderProbe(f.states); const put=f.store.put;
  f.store.put=async(...args)=>{await put(...args);throw Error('lost response');};
  await assert.rejects(()=>probe.prepare(f.store)); assert.equal(f.puts.length,1);
  await assert.rejects(()=>probe.prepare(f.store)); await assert.rejects(()=>probe.retire(f.store,{admissionClosed:true}));
  assert.equal(f.puts.length,1);
});
test('reader rejects incomplete preparation and changed nested content without replay',async()=>{
  const { createCatalogReaderProbe }=await feature(); assert.equal(typeof createCatalogReaderProbe,'function');
  const f=fixture(),probe=createCatalogReaderProbe(f.states);
  await assert.rejects(()=>probe.read(f.request)); assert.equal(f.reads.length,0);
  await probe.prepare(f.store);
  await assert.rejects(()=>probe.read(async()=>Response.json({version:'wrong'})));
  await assert.rejects(()=>probe.read(f.request)); assert.equal(f.reads.length,0);
});
test('cleanup requires closed admission and validates all owned contents before any retirement',async()=>{
  const { createCatalogReaderProbe }=await feature(); assert.equal(typeof createCatalogReaderProbe,'function');
  const f=fixture(),probe=createCatalogReaderProbe(f.states); await probe.prepare(f.store);
  await assert.rejects(()=>probe.retire(f.store,{admissionClosed:false})); assert.equal(f.puts.length,6);
  f.objects.set(f.puts.at(-1),'{"foreign":true}');
  await assert.rejects(()=>probe.retire(f.store,{admissionClosed:true})); assert.equal(f.puts.length,6);
});
test('probe rejects cross-tenant items, non-isolated slugs and oversized snapshots',async()=>{
  const { createCatalogReaderProbe }=await feature(); assert.equal(typeof createCatalogReaderProbe,'function');
  const f=fixture();f.states[0].catalog.items[0].restaurantId=f.states[1].catalog.restaurant.id;
  assert.throws(()=>createCatalogReaderProbe(f.states));
  const g=fixture();g.states[0].catalog.restaurant.slug='bistro';assert.throws(()=>createCatalogReaderProbe(g.states));
  const h=fixture();h.states[0].catalog.restaurant.description='oversized';assert.throws(()=>createCatalogReaderProbe(h.states));
});
