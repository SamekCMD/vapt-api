// Operator-only reader workload. No provider auth, SQL, deployed fixture or CLI.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
const ensure = value => { if (!value) throw new Error('Private catalog reader probe stopped'); };
const bytes = value => Buffer.byteLength(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
async function limitedText(response) {
  const reader = response.body?.getReader(); ensure(reader);
  const decoder = new TextDecoder(); let text = '', size = 0;
  try {
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.byteLength; ensure(size <= 8_388_608);
      text += decoder.decode(part.value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
export function createCatalogReaderProbe(input) {
  ensure(Array.isArray(input) && input.length === 2);
  const states = structuredClone(input), identities = new Set();
  const entries = [], manifests = [];
  for (const [index, state] of states.entries()) {
    const restaurant = state?.catalog?.restaurant, id = restaurant?.id, slug = restaurant?.slug;
    ensure(typeof id === 'string' && uuid.test(id) && slug === `reader-${id}` && !identities.has(id)); identities.add(id);
    ensure(state.version === '11' && restaurant.description === null && Array.isArray(state.catalog.items));
    ensure(state.catalog.items.length > (index === 0 ? 10_000 : 500));
    for (const item of state.catalog.items) {
      ensure(item.restaurantId === id && Array.isArray(item.variations) && item.variations.length === (index === 0 ? 0 : 20));
      ensure(item.variations.every(value => Array.isArray(value.options) && value.options.length === 50));
    }
    const body = JSON.stringify(state); ensure(bytes(body) === 8_388_608);
    const prefix = `catalog/v1/preview/restaurants/${id}/`;
    const mapping = { restaurantId:id, version:'11', canonicalSlug:slug, tombstone:false };
    const manifest = { restaurantId:id, version:'11', canonicalSlug:slug, previousVersion:null };
    entries.push(
      { key:prefix+'snapshots/11.json', body, fence:JSON.stringify({retired:true,version:'11'}) },
      { key:prefix+'manifest.json', body:JSON.stringify(manifest), fence:JSON.stringify({retired:true,restaurantId:id,version:'11'}) },
      { key:`catalog/v1/preview/slugs/${slug}.json`, body:JSON.stringify(mapping), fence:JSON.stringify({...mapping,tombstone:true}) },
    );
    manifests.push({ shape:index===0?'items':'variations',restaurantId:id,slug,version:'11',bytes:bytes(body),snapshotSha256:hash(body),
      items:state.catalog.items.length,variations:state.catalog.items.reduce((n,item)=>n+item.variations.length,0) });
  }
  let prepareStarted = false, prepared = false, readStarted = false, retireStarted = false, uncertainPut = false;
  const attempted = new Set();
  return {
    summary() { return { fixtures:structuredClone(manifests),prepared,readStarted,attemptedObjects:attempted.size,uncertainPut }; },
    async prepare(store) {
      ensure(!prepareStarted); prepareStarted = true;
      for (const entry of entries) ensure(await store.get(entry.key) === null);
      for (const entry of entries) {
        attempted.add(entry.key); uncertainPut = true;
        await store.put(entry.key,entry.body); uncertainPut = false;
        ensure(await store.get(entry.key) === entry.body);
      }
      prepared = true;
    },
    async read(request) {
      ensure(prepared && !readStarted && !retireStarted); readStarted = true;
      const results = [];
      for (const state of states) for (const route of ['catalog-state','catalog']) {
        const path = `/public/restaurants/${state.catalog.restaurant.slug}/${route}`;
        const response = await request(path); ensure(response.status === 200 && response.headers.get('Cache-Control') === 'no-store');
        const body = await limitedText(response);
        ensure(isDeepStrictEqual(JSON.parse(body),route === 'catalog-state' ? state : state.catalog));
        if (route === 'catalog-state') ensure(bytes(body) === 8_388_608);
        results.push({restaurantId:state.catalog.restaurant.id,route,status:response.status,bytes:bytes(body),sha256:hash(body)});
      }
      return results;
    },
    async retire(store,{admissionClosed}) {
      ensure(prepareStarted && admissionClosed === true && !retireStarted && !uncertainPut); retireStarted = true;
      const owned = entries.filter(entry=>attempted.has(entry.key));
      // Verify the entire known scope before changing any object. Never delete.
      for (const entry of owned) ensure(await store.get(entry.key) === entry.body);
      for (const entry of owned) {
        await store.put(entry.key,entry.fence);
        ensure(await store.get(entry.key) === entry.fence);
      }
      for (const entry of owned) ensure(await store.get(entry.key) === entry.fence);
      return {objects:owned.length,bytes:owned.reduce((sum,entry)=>sum+bytes(entry.fence),0),
        fences:owned.map(entry=>({key:entry.key,bytes:bytes(entry.fence),sha256:hash(entry.fence)}))};
    },
  };
}
