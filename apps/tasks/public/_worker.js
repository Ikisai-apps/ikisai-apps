/* Cloudflare Pages (advanced mode): proxy de mismo origen hacia la Edge Function de Tasks.
   El bundle no lleva ninguna credencial privada; solo reenvía /api/v1/* y rechaza orígenes cruzados. */
const BACKEND = 'https://ctytaorylbninfyupfsn.supabase.co/functions/v1/tasks-api';
const FORWARDED_HEADERS = ['authorization', 'content-type', 'content-length', 'accept'];
/* Recursos de la cáscara con nombre fijo (sin huella): `no-cache`, para que el navegador los revalide siempre (ETag y 304)
   en vez de servir durante horas una copia vieja de su caché HTTP. Sin esto, la primera carga sin service worker (tras
   borrar los datos del sitio, o en una instalación nueva) seguía pintando la cáscara anterior. Fuentes e imágenes, con su
   caché de siempre. */
const FRESH = /(?:^\/$|\.(?:js|css|html|webmanifest|json)$)/;
async function asset(request, env, url) {
  const response = await env.ASSETS.fetch(request);
  if (!FRESH.test(url.pathname)) return response;
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/v1/')) return asset(request, env, url);
    // Las rutas de worker son de servidor a servidor: van directas a la Edge, con su clave. Este proxy no reenvía la clave
    // (ni debe): se rechazan con un mensaje claro en vez de un 401 confuso (petición de Core, 8-10-2026).
    if (url.pathname === '/api/v1/worker' || url.pathname.startsWith('/api/v1/worker/')) {
      return Response.json(
        { error: { code: 'WORKER_ROUTE_NOT_PROXIED', message: 'Las rutas de worker no pasan por tasks.ikisai.com: usa la Edge directa (…/functions/v1/tasks-api/api/v1/worker/…).', details: null } },
        { status: 400, headers: { 'Cache-Control': 'no-store' } },
      );
    }

    const origin = request.headers.get('origin');
    if (origin && origin !== url.origin) {
      return Response.json(
        { error: { code: 'ORIGIN_REJECTED', message: 'Origen no autorizado.', details: null } },
        { status: 403, headers: { 'Cache-Control': 'no-store' } },
      );
    }
    const headers = new Headers();
    for (const key of FORWARDED_HEADERS) if (request.headers.has(key)) headers.set(key, request.headers.get(key));
    headers.set('Origin', url.origin);
    // Sesión única (contrato §3.4): solo en las rutas de sesión, el pase de la cookie común viaja a la Edge como cabecera.
    if (url.pathname.startsWith('/api/v1/auth/')) {
      const pass = (request.headers.get('cookie') || '').match(/(?:^|;\s*)ikisai_sso=([A-Za-z0-9_-]{43})/);
      if (pass) headers.set('X-Ikisai-Sso', pass[1]);
    }
    const response = await fetch(BACKEND + url.pathname + url.search, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
      redirect: 'manual',
    });
    const outgoing = new Headers(response.headers);
    outgoing.set('Cache-Control', 'no-store');
    outgoing.set('X-Content-Type-Options', 'nosniff');
    return new Response(response.body, { status: response.status, headers: outgoing });
  },
};
