import assert from 'node:assert/strict';
import test from 'node:test';
import {createRestaurantService} from './service.js';
import {createRestaurantRepository,type RestaurantRepository} from './repository.js';
import {AppError} from '../../lib/errors.js';
import type {Database} from '../../lib/database.js';
const scope={userId:'10000000-0000-4000-8000-000000000001',restaurantId:'20000000-0000-4000-8000-000000000001'};
test('slug availability validates input and exposes only a boolean',async()=>{
  const calls:unknown[]=[];
  const service=createRestaurantService({checkSlugAvailability:async(target:unknown,slug:string)=>{calls.push([target,slug]);return false;}} as unknown as RestaurantRepository);
  assert.deepEqual(await service.checkSlugAvailability(scope,'  restaurante-teste  '),{available:false});
  assert.deepEqual(calls,[[scope,'restaurante-teste']]);
  for(const slug of ['a','UPPER','dois--hifens','-invalido','../segredo','a'.repeat(61)])await assert.rejects(service.checkSlugAvailability(scope,slug),error=>error instanceof AppError&&error.statusCode===400);
  assert.equal(calls.length,1);
});
test('slug unique violations have a safe specific conflict without leaking database diagnostics',async()=>{
  const repository=createRestaurantRepository({query:async(sql:string)=>{if(sql.startsWith('select r.organization_id,m.role'))return {rows:[{organization_id:'30000000-0000-4000-8000-000000000001',role:'admin'}]};throw {code:'23505',constraint:'restaurants_slug_key',detail:'Synthetic private SQL detail'};}} as unknown as Database);
  await assert.rejects(repository.getRestaurant(scope),error=>error instanceof AppError&&error.statusCode===409&&error.code==='slug_conflict'&&!error.message.includes('SQL'));
});
