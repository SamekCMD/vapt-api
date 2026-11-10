// Pure control-plane response guard. No authentication or mutations on import.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const require = value => { if (!value) throw Error('Production runtime readback failed'); };
export function validateProductionRuntimeExpected(expected) {
  require(expected && Object.keys(expected).sort().join(',') === 'apiVersion,realtime,webVersion' &&
    uuid.test(expected.apiVersion) && uuid.test(expected.webVersion) && ['disabled','enabled'].includes(expected.realtime));
}
export function checkProductionRuntimeReadback(state, expected) {
  validateProductionRuntimeExpected(expected);
  require(state?.ingress?.enabled === false && state.ingress.previews_enabled === false && state.settings?.limits?.cpu_ms === 1000);
  const bindings = state.settings.bindings ?? [];
  const names = ['BETTER_AUTH_SECRET','PUBLIC_ORDER_TOKEN_SECRET','RESEND_API_KEY','TURNSTILE_SECRET_KEY',
    'R2_ACCESS_KEY_ID','R2_SECRET_ACCESS_KEY','STRIPE_SECRET_KEY','STRIPE_WEBHOOK_SECRET'];
  require(names.every(name => bindings.some(b => b.name === name && b.type === 'secret_text')) &&
    bindings.filter(b => b.type === 'secret_text').length === names.length);
  require(bindings.find(b => b.name === 'HYPERDRIVE')?.id === '2885c609a66641b3b716190c2d467902' &&
    bindings.find(b => b.name === 'R2_BUCKET')?.bucket_name === 'vapt-assets-production' &&
    bindings.find(b => b.name === 'RESTAURANT_REALTIME')?.namespace_id === 'd3ad7a4008c64124b765f934986956da' &&
    bindings.find(b => b.name === 'REALTIME_ENABLED')?.text === String(expected.realtime === 'enabled') &&
    bindings.find(b => b.name === 'STRIPE_ENVIRONMENT')?.text === 'test');
  const rates = [['AUTH_RATE_LIMIT','13011',20],['BILLING_RATE_LIMIT','13012',60],['ORDERS_RATE_LIMIT','13013',30],
    ['STORAGE_RATE_LIMIT','13014',30],['WEBHOOKS_RATE_LIMIT','13015',300],['PUBLIC_RATE_LIMIT','13016',120]];
  require(bindings.filter(b=>b.type==='ratelimit').length===6 && rates.every(([name,namespace,limit])=> {
    const binding=bindings.find(b=>b.name===name); return binding?.type==='ratelimit' && binding.namespace_id===namespace &&
      binding.simple?.limit===limit && binding.simple.period===60;
  }));
  require(state.schedules?.schedules?.length === 0 && state.r2?.enabled === false && Array.isArray(state.domains));
  const apiDomains = state.domains.filter(d => d.service === 'vapt-api-production');
  const webDomains = state.domains.filter(d => d.service === 'vapt-web');
  require(apiDomains.length === 1 && apiDomains[0].hostname === 'api.vapt.app.br' && apiDomains[0].id === 'f7344b662aa02bcfa576e9cb5b0108d6d59b667f');
  require(webDomains.length === 1 && webDomains[0].hostname === 'vapt.app.br' && webDomains[0].id === '42d2afe630dc5122d027cf55cb13607c7e0d6bd3');
  const versions = deployment => deployment?.deployments?.[0]?.versions;
  for (const [deployment, version] of [[state.apiDeployment, expected.apiVersion], [state.webDeployment, expected.webVersion]]) {
    const deployed = versions(deployment); require(deployed?.length === 1 && deployed[0].version_id === version && deployed[0].percentage === 100);
  }
  return { verified: true, apiVersion: expected.apiVersion, webVersion: expected.webVersion, realtime: expected.realtime === 'enabled',
    cpuMs: 1000, workersDev: false, previews: false, r2Public: false, schedules: 0, stripe: 'test', secretNames: names, noMutations: true };
}
