/* Cloudflare Pages (advanced mode): proxy de mismo origen hacia la Edge Function de Flow.
   El bundle no lleva ninguna credencial privada; solo reenvía /api/v1/* y rechaza orígenes cruzados. */
const BACKEND = 'https://ctytaorylbninfyupfsn.supabase.co/functions/v1/flow-api';
// `x-flow-customer`: el token del cliente de la carta pública (Mi pedido, pedir); `x-visitor`: el visitante del kit
// (número por QR, traspaso a ven.ikisai.com). Sin ellas, la carta en producción no reconoce al móvil.
const FORWARDED_HEADERS = ['authorization', 'content-type', 'content-length', 'accept', 'x-flow-customer', 'x-visitor'];

/* Entradas (decisión de VG, 27-10): la raíz es la entrada del equipo; la carta pública vive en /recorridos/carta y se llega
   desde ven.ikisai.com. Redirecciones permanentes desde las URL antiguas, por si algún enlace vive:
   /equipo… → / (el navegador conserva el #), /carta → ven.ikisai.com, /?invitacion=… (enlace de Guests) → la carta. */
const CARTA_PATH = '/recorridos/carta';
function redirectFor(url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  if (path === '/equipo' || path.startsWith('/equipo/')) return `${url.origin}/${url.search}`;
  if (path === '/carta') return 'https://ven.ikisai.com/';
  if (path === '/' && url.searchParams.has('invitacion')) return `${url.origin}${CARTA_PATH}${url.search}`;
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const moved = redirectFor(url);
    if (moved) return Response.redirect(moved, 301);
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
    // IP del cliente para el freno de la carta pública (FL5); la del navegador no se reenvía, se pone aquí.
    const ip = request.headers.get('cf-connecting-ip');
    if (ip) headers.set('X-Ikisai-Client-Ip', ip);
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
