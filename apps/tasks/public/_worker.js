/* Cloudflare Pages (advanced mode): proxy de mismo origen hacia la Edge Function de Tasks.
   El bundle no lleva ninguna credencial privada; solo reenvía /api/v1/* y rechaza orígenes cruzados. */
const BACKEND = 'https://ctytaorylbninfyupfsn.supabase.co/functions/v1/tasks-api';
const FORWARDED_HEADERS = ['authorization', 'content-type', 'content-length', 'accept'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/v1/')) return env.ASSETS.fetch(request);

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
