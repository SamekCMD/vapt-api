import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {expectedCatalogConfig} from './verify-catalog-config.mjs';

// Current production profile after the catalog rollout and Stripe account
// migration. Historical preparation profiles remain separate. This offline
// check does not authorize a deploy or certify a real provider payment.
export function expectedStripeLiveProductionConfig(){
 const config=expectedCatalogConfig('production');
 Object.assign(config.vars,{
  STRIPE_ENVIRONMENT:'live',
  STRIPE_PORTAL_CONFIGURATION_ID:'bpc_1Uf8AEH4hY0s7wXrsYf89Gma',
  STRIPE_PRICE_STARTER:'price_1Uf88EH4hY0s7wXrnPGXecAB',
  STRIPE_PRICE_PRO:'price_1Uf88DH4hY0s7wXrkun2uQvf',
  STRIPE_PRICE_BUSINESS:'price_1Uf88DH4hY0s7wXrY2m0aa7U',
  PUBLIC_CATALOG_READER_ENABLED:'true',PUBLIC_CATALOG_WRITER_ENABLED:'true',
 });
 config.analytics_engine_datasets=[{binding:'DIAGNOSTICS',dataset:'vapt_operational_diagnostics_production'}];
 return config;
}
export function checkStripeLiveProductionConfig(config){
 try{if(isDeepStrictEqual(config,expectedStripeLiveProductionConfig()))return{ok:true,deployed:false,livePaymentVerified:false};}catch{}
 return{ok:false,failures:['Invalid Stripe Live production configuration']};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 let result;try{if(process.argv.length!==3)throw Error();result=checkStripeLiveProductionConfig(JSON.parse(readFileSync(process.argv[2],'utf8')));}catch{result=checkStripeLiveProductionConfig(null);}
 console.log(JSON.stringify(result));if(!result.ok)process.exitCode=1;
}
