/* Cloudflare Pages (advanced mode): proxy de mismo origen hacia la Edge Function de Guests.
   El bundle no lleva ninguna credencial privada; solo reenvía /api/v1/* y rechaza orígenes cruzados.
   Visitantes (API.md §9.19): reenvía también la cabecera X-Visitor, y /api/booking/v1/public/* va a las rutas públicas de
   booking-api («Apuntarme» y «Déjanos un dato», que escribe Booking) y /api/flow/v1/public/* a las de flow-api («Mi pedido»);
   nada más de esas apps pasa por aquí. A todas les pone X-Ikisai-Client-Ip con la IP del móvil (traspaso de visitante, 0106). */
const BACKEND = 'https://ctytaorylbninfyupfsn.supabase.co/functions/v1/guests-api';
const BOOKING_BACKEND = 'https://ctytaorylbninfyupfsn.supabase.co/functions/v1/booking-api';
const FLOW_BACKEND = 'https://ctytaorylbninfyupfsn.supabase.co/functions/v1/flow-api';
const FORWARDED_HEADERS = ['authorization', 'content-type', 'content-length', 'accept', 'x-visitor'];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const owner = url.pathname.startsWith('/api/booking/v1/public/') ? 'booking' : url.pathname.startsWith('/api/flow/v1/public/') ? 'flow' : null;
    if (!url.pathname.startsWith('/api/v1/') && !owner) return env.ASSETS.fetch(request);

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
    // Traspaso de visitante (núcleo 0106): la IP del móvil, no la de salida de Cloudflare. La pone siempre el proxy (la del
    // cliente nunca se reenvía: `headers` solo lleva las de FORWARDED_HEADERS).
    const ip = request.headers.get('cf-connecting-ip');
    if (ip) headers.set('X-Ikisai-Client-Ip', ip);
    // Sesión única (contrato §3.4): solo en las rutas de sesión, el pase de la cookie común viaja a la Edge como cabecera.
    if (!owner && url.pathname.startsWith('/api/v1/auth/')) {
      const pass = (request.headers.get('cookie') || '').match(/(?:^|;\s*)ikisai_sso=([A-Za-z0-9_-]{43})/);
      if (pass) headers.set('X-Ikisai-Sso', pass[1]);
    }
    const target = owner === 'booking' ? BOOKING_BACKEND + url.pathname.replace('/api/booking/v1/', '/api/v1/')
      : owner === 'flow' ? FLOW_BACKEND + url.pathname.replace('/api/flow/v1/', '/api/v1/') : BACKEND + url.pathname;
    if (owner) headers.delete('authorization'); // a Booking y a Flow solo va el visitante, nunca la sesión del huésped
    const response = await fetch(target + url.search, {
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
