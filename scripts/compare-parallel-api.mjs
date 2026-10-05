const coolifyHost = 'https://api.vapt.app.br';
const previewHost = 'https://stage11-inert-vapt-api-parallel.autoistloko.workers.dev';
const origin = 'https://infra-foundation-vapt-web.autoistloko.workers.dev';
const paths = [
  '/health', '/auth/me', '/restaurants/me',
  '/public/restaurants/__stage11_missing__/catalog', '/__stage11_missing__/%not-hex',
];
const matrix = Object.freeze(paths.map(path => Object.freeze({ method: 'GET', path })));
const safeCodes = new Set([
  'unauthorized', 'forbidden', 'not_found', 'invalid_request', 'internal_error',
  'service_unavailable', 'rate_limit_exceeded', 'validation_error', 'conflict',
]);

export function validateReadOnlyMatrix(entries) {
  if (!Array.isArray(entries) || entries.length === 0 || entries.some(entry =>
    !entry || entry.method !== 'GET' || !paths.includes(entry.path) || Object.hasOwn(entry, 'body'))) {
    throw new Error('Invalid read-only matrix');
  }
}

async function safeErrorContract(response) {
  const reader = response.body?.getReader();
  if (!reader) return { errorKeys: [], errorCode: null };
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 65_536) { await reader.cancel(); return { errorKeys: [], errorCode: null }; }
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const body = JSON.parse(new TextDecoder().decode(bytes));
    const error = body?.error;
    return {
      errorKeys: ['code', 'message'].filter(key => error && Object.hasOwn(error, key)),
      errorCode: safeCodes.has(error?.code) ? error.code : null,
    };
  } catch {
    return { errorKeys: [], errorCode: null };
  } finally { reader.releaseLock(); }
}

async function inspect(fetcher, base, entry, headers) {
  try {
    const response = await fetcher(base + entry.path, {
      method: entry.method, headers, redirect: 'manual', credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
    });
    const media = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    const contentType = !media ? null : ['application/json', 'application/problem+json', 'text/html', 'text/plain'].includes(media) ? media : 'other';
    let accessDenied = false;
    try { accessDenied = new URL(response.headers.get('location')).hostname === 'shy-mouse-d86f.cloudflareaccess.com'; } catch {}
    // Never return response text, arbitrary error codes, headers, IDs, cookies or redirects.
    return {
      status: response.status, contentType, ...await safeErrorContract(response),
      allowedOrigin: response.headers.get('access-control-allow-origin') === origin,
      allowCredentials: response.headers.get('access-control-allow-credentials') === 'true',
      setsCookie: response.headers.has('set-cookie'), accessDenied,
    };
  } catch {
    return { status: null, contentType: null, errorKeys: [], errorCode: null,
      allowedOrigin: false, allowCredentials: false, setsCookie: false, accessDenied: false };
  }
}

export async function compareParallelApi({ coolifyBaseUrl, previewBaseUrl, previewHeaders, fetcher = fetch }) {
  const headers = new Headers(previewHeaders);
  if (coolifyBaseUrl !== coolifyHost || previewBaseUrl !== previewHost ||
    !headers.get('cf-access-token') || !/^Bearer [A-Za-z0-9_-]{20,256}$/.test(headers.get('authorization') ?? '') ||
    [...headers.keys()].some(key => !['authorization', 'cf-access-token'].includes(key))) {
    throw new Error('Invalid comparison input');
  }
  validateReadOnlyMatrix(matrix);
  headers.set('Origin', origin);
  const publicHeaders = new Headers({ Origin: origin });
  const results = [];
  for (const entry of matrix) {
    const coolify = await inspect(fetcher, coolifyBaseUrl, entry, publicHeaders);
    const preview = await inspect(fetcher, previewBaseUrl, entry, headers);
    const differences = Object.keys(coolify).filter(key => JSON.stringify(coolify[key]) !== JSON.stringify(preview[key]));
    const outcome = preview.accessDenied ? 'access_denied'
      : coolify.status === null || preview.status === null ? 'unavailable'
      : differences.length ? 'different' : 'match';
    results.push({ ...entry, coolify, preview, differences, outcome });
  }
  return results;
}
