import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';

const preview = 'https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const publicBase = 'https://pub-c7718cfb495f4c83866dfe3ed8c52890.r2.dev';
const r2Origin = 'https://3ce69408aa5112617a282957aba71932.r2.cloudflarestorage.com';
const r2BucketOrigin = 'https://vapt-assets-preview.3ce69408aa5112617a282957aba71932.r2.cloudflarestorage.com';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jGZkAAAAASUVORK5CYII=', 'base64');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function runPreviewFlows({ baseUrl, accessHeaders, bearer, fetcher = fetch,
  tag, cleanup, verificationUrl, now = Date.now, waitForExpiry = wait }) {
  const access = new Headers(accessHeaders);
  if (baseUrl !== preview || !/^stage11-[a-z0-9-]{8,40}$/.test(tag ?? '') ||
    !/^[A-Za-z0-9_-]{20,256}$/.test(bearer ?? '') || !access.get('cf-access-token') ||
    [...access.keys()].some(key => key !== 'cf-access-token') ||
    typeof cleanup !== 'function' || typeof verificationUrl !== 'function') {
    throw new Error('Invalid Preview flow input');
  }
  const created = { userId: null, restaurantId: null, menuItemIds: [], orderIds: [], objectKeys: [] };
  const summary = { ok: false, cleaned: false, checks: { auth: false, restaurant: false, menu: false, orders: false, storage: false }, failure: null };
  let step = 'signup', cookie = '';
  function require(condition) { if (!condition) throw new Error('Preview assertion failed'); }
  function checkedId(value) { require(uuid.test(value ?? '')); return value; }
  async function api(path, { method = 'GET', body, authenticated = false, headers = {} } = {}, statuses = [200]) {
    const requestHeaders = { 'Cf-Access-Token': access.get('cf-access-token'), Authorization: 'Bearer ' + bearer,
      Origin: 'https://infra-foundation-vapt-web.autoistloko.workers.dev', ...headers };
    if (authenticated) requestHeaders.Cookie = cookie;
    if (body !== undefined) requestHeaders['Content-Type'] = 'application/json';
    const response = await fetcher(preview + path, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30_000) });
    require(statuses.includes(response.status));
    let json = null;
    if (response.headers.get('content-type')?.includes('application/json')) json = await response.json();
    return { response, json };
  }
  async function external(url, options) {
    const response = await fetcher(url, { ...options, redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(30_000) });
    return response;
  }
  try {
    const password = randomBytes(24).toString('base64url');
    const signup = await api('/api/auth/sign-up/email', { method: 'POST', body: { name: tag, email: 'delivered@resend.dev', password },
      headers: { 'X-Captcha-Response': 'XXXX.DUMMY.TOKEN.XXXX' } });
    created.userId = checkedId(signup.json?.user?.id);
    step = 'verification';
    const verify = new URL(await verificationUrl({ tag, userId: created.userId, email: 'delivered@resend.dev' }));
    require(verify.origin === preview && verify.pathname === '/api/auth/verify-email' && verify.searchParams.has('token'));
    await api(verify.pathname + verify.search);
    step = 'login';
    const login = await api('/api/auth/sign-in/email', { method: 'POST', body: { email: 'delivered@resend.dev', password },
      headers: { 'X-Captcha-Response': 'XXXX.DUMMY.TOKEN.XXXX' } });
    require(login.json?.user?.id === created.userId);
    cookie = login.response.headers.getSetCookie().map(value => value.split(';')[0]).filter(value => /^(?:__Secure-)?better-auth\./.test(value)).join('; ');
    require(cookie.includes('session_token='));
    for (let i = 0; i < 2; i++) require((await api('/auth/me', { authenticated: true })).json?.userId === created.userId);

    step = 'restaurant';
    const onboarding = await api('/onboarding', { method: 'POST', authenticated: true,
      body: { restaurantName: tag, slug: tag, dishName: 'Prato Teste', dishPrice: '12.00' } }, [201]);
    created.restaurantId = checkedId(onboarding.json?.id);
    require((await api('/restaurants/me', { authenticated: true })).json?.id === created.restaurantId);
    await api('/restaurants/me', { method: 'PATCH', authenticated: true, body: { description: tag } });
    const foreign = await api(`/auth/restaurants/${randomUUID()}/access`, { authenticated: true }, [403]);
    require(foreign.json?.error?.code === 'forbidden');
    summary.checks.restaurant = true;

    step = 'menu';
    const item = await api('/restaurants/me/menu-items', { method: 'POST', authenticated: true, body: {
      name: 'Prato Sintetico', price: '12.00', description: tag, category: 'Teste', available: true,
      imageUrl: null, availableFrom: null, availableUntil: null, badge: null, isChefSuggestion: false,
      prepTimeMinutes: 1, variations: [],
    } }, [201]);
    const itemId = checkedId(item.json?.id); created.menuItemIds.push(itemId);
    require((await api('/restaurants/me/menu-items', { authenticated: true })).json?.some(value => value.id === itemId));
    await api('/restaurants/me/menu-items/' + itemId, { method: 'PATCH', authenticated: true, body: { price: '13.00' } });

    step = 'storage';
    const imagePath = `/restaurants/${created.restaurantId}/menu-items/${itemId}/image`;
    const preparedAt = now();
    const prepared = (await api(imagePath + '/upload', { method: 'POST', authenticated: true,
      body: { contentType: 'image/png', contentLength: png.length } })).json;
    const objectKey = `${created.restaurantId}/${itemId}`;
    const signed = new URL(prepared?.uploadUrl);
    const approvedSigner = (signed.origin === r2Origin && signed.pathname === '/vapt-assets-preview/' + objectKey) ||
      (signed.origin === r2BucketOrigin && signed.pathname === '/' + objectKey);
    require(approvedSigner &&
      prepared.objectKey === objectKey && prepared.publicUrl === publicBase + '/' + objectKey &&
      prepared.method === 'PUT' && prepared.headers?.['Content-Type'] === 'image/png' &&
      Number.isInteger(prepared.expiresInSeconds) && prepared.expiresInSeconds >= 60 && prepared.expiresInSeconds <= 60);
    created.objectKeys.push(objectKey, objectKey + '-tampered');
    const putHeaders = { 'Content-Type': 'image/png', 'Content-Length': String(png.length) };
    step = 'storage_constraints';
    const tamperedKey = new URL(signed); tamperedKey.pathname += '-tampered';
    const negatives = [
      { url: tamperedKey.toString(), body: png, headers: putHeaders },
      { url: signed.toString(), body: png, headers: { ...putHeaders, 'Content-Type': 'image/jpeg' } },
      { url: signed.toString(), body: png.subarray(0, png.length - 1), headers: { ...putHeaders, 'Content-Length': String(png.length - 1) } },
    ];
    for (const invalid of negatives) require((await external(invalid.url, { method: 'PUT', headers: invalid.headers, body: invalid.body })).status === 403);
    require((await external(signed.toString(), { method: 'PUT', headers: putHeaders, body: png })).status === 200);
    const metadata = await external(prepared.publicUrl, { method: 'HEAD' });
    require(metadata.status === 200 && metadata.headers.get('content-type') === 'image/png' && Number(metadata.headers.get('content-length')) === png.length);
    const image = await external(prepared.publicUrl, { method: 'GET' });
    require(image.status === 200 && Buffer.from(await image.arrayBuffer()).equals(png));
    await api(imagePath, { method: 'DELETE', authenticated: true }, [204]);
    require((await external(prepared.publicUrl + '?check=' + tag, { method: 'HEAD' })).status === 404);

    step = 'orders';
    const orderBody = { restaurantSlug: tag, channel: 'local', tableNumber: 1, items: [{ menuItemId: itemId, quantity: 1 }] };
    const settled = await Promise.allSettled([0, 1].map(() => api('/public/orders', { method: 'POST', body: orderBody,
      headers: { 'Idempotency-Key': tag + '-order' } }, [200, 201])));
    require(settled.every(value => value.status === 'fulfilled'));
    const concurrent = settled.map(value => value.value);
    const orderId = checkedId(concurrent[0].json?.orderId); created.orderIds.push(orderId);
    require(concurrent[1].json?.orderId === orderId && concurrent[0].json?.publicToken === concurrent[1].json?.publicToken);
    require(concurrent.map(value => value.response.status).sort().join(',') === '200,201');
    const orderToken = concurrent[0].json.publicToken;
    await api('/public/orders/' + orderId, { headers: { 'X-Vapt-Order-Token': orderToken } });
    require((await api('/restaurants/me/kitchen/orders', { authenticated: true })).json?.some(value => value.id === orderId));
    require((await api(`/restaurants/me/kitchen/orders/${orderId}/status`, { method: 'PATCH', authenticated: true, body: { status: 'preparing' } })).json?.status === 'preparing');
    summary.checks.orders = true;
    step = 'menu';
    await api('/restaurants/me/menu-items/' + itemId, { method: 'DELETE', authenticated: true }, [204]);
    summary.checks.menu = true;

    step = 'storage_constraints';
    await waitForExpiry(Math.max(0, preparedAt + prepared.expiresInSeconds * 1000 + 1500 - now()));
    require((await external(signed.toString(), { method: 'PUT', headers: putHeaders, body: png })).status === 403);
    require((await external(prepared.publicUrl + '?expired=' + tag, { method: 'HEAD' })).status === 404);
    summary.checks.storage = true;
    step = 'logout';
    await api('/api/auth/sign-out', { method: 'POST', body: {}, authenticated: true });
    for (let i = 0; i < 2; i++) await api('/auth/me', { authenticated: true }, [401]);
    summary.checks.auth = true;
    summary.ok = true;
  } catch {
    summary.failure = step;
  } finally {
    try {
      const residue = await cleanup(tag, created);
      summary.cleaned = residue?.rows === 0 && residue?.objects === 0 && residue?.outbox === 0;
    } catch { summary.cleaned = false; }
    if (!summary.cleaned) { summary.ok = false; summary.failure = 'cleanup'; }
    cookie = '';
  }
  return summary;
}
