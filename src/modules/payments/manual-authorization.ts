import type {Database} from '../../lib/database.js';
import {withRestaurantWrite} from '../tenancy/authorization.js';
import type {CommittedChange} from '../realtime/contracts.js';
import {emitCommittedChange,type CommittedChangeOptions} from '../realtime/committed-changes.js';
import {createPaymentRepository} from './repository.js';
import type {PaymentProviderRegistry} from './registry.js';
import {createPaymentService,type AuthorizedManualPayment} from './service.js';

export function createAuthorizedManualPayment(database:Database,registry:PaymentProviderRegistry,
  options:CommittedChangeOptions={}):AuthorizedManualPayment {
  return async(scope,work)=>{
    const changes:CommittedChange[]=[];
    const result=await withRestaurantWrite(database,scope,'restaurant.operate',async client=>{
      const repository=createPaymentRepository(client,{deferCommittedChange:change=>changes.push(change)});
      return work({repository,paymentService:createPaymentService(registry,repository)});
    });
    for(const change of changes) await emitCommittedChange(options,change);
    return result;
  };
}
