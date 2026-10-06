/// <reference lib="webworker" />
/**
 * Service worker de Ikisai Invoices. Vite lo compila como entrada aparte a /sw.js (ver vite.config.ts).
 * - Precachea el shell: la lista `SHELL` y el sufijo de `CACHE` los inyecta el plugin `ikisai:sw-shell` en build.
 * - Nunca toca /api/ (la sincronización la gestiona @ikisai/sync-client con su propio espejo IndexedDB).
 * - Activación coordinada: solo hace skipWaiting cuando la app lo pide (APPLY_UPDATE) y todas las pestañas
 *   confirman que no tienen borradores ni cola pendiente (UPDATE_READY). Si no, avisa con UPDATE_ABORT.
 */
const sw = self as unknown as ServiceWorkerGlobalScope;

const CACHE = 'ikisai-invoices-shell-__SHELL_VERSION__';
const SHELL: string[] = '__SHELL_ASSETS__' as unknown as string[];

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => sw.clients.claim()),
  );
});

interface Activation {
  id: string;
  clients: Set<string>;
  answers: Map<string, boolean>;
  check(): void;
}
let activation: Activation | { pending: true } | null = null;

sw.addEventListener('message', (event) => {
  const data = event.data as { type?: string; requestId?: string; ready?: boolean } | undefined;
  const source = event.source as Client | null;
  if (data?.type === 'UPDATE_READY' && activation && 'id' in activation && activation.id === data.requestId && source && activation.clients.has(source.id)) {
    activation.answers.set(source.id, data.ready === true);
    activation.check();
  }
  if (data?.type === 'APPLY_UPDATE' && !activation) {
    activation = { pending: true };
    event.waitUntil(activateSafely());
  }
});

async function activateSafely(): Promise<void> {
  const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const id = crypto.randomUUID();
  const approved = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 4000);
    const state: Activation = {
      id,
      clients: new Set(windows.map((c) => c.id)),
      answers: new Map(),
      check() {
        if ([...this.answers.values()].some((ok) => !ok)) {
          clearTimeout(timer);
          resolve(false);
        } else if (this.answers.size === this.clients.size) {
          clearTimeout(timer);
          resolve(true);
        }
      },
    };
    activation = state;
    for (const client of windows) client.postMessage({ type: 'CHECK_UPDATE_READY', requestId: id });
    state.check();
  });
  const current = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const known = activation && 'clients' in activation ? activation.clients : new Set<string>();
  if (approved && current.length === windows.length && current.every((c) => known.has(c.id))) {
    await sw.skipWaiting();
  } else {
    for (const client of current) client.postMessage({ type: 'UPDATE_ABORT' });
  }
  activation = null;
}

/**
 * «Compartir» hacia Ikisai (share_target del manifiesto, ronda 29): guarda el texto recibido (y el de los archivos
 * .json/.txt, hasta 1 MB) en una caché propia y abre Facturas, que lo pasa a la importación. Lo recibido es no confiable:
 * aquí no se interpreta nada.
 */
async function receiveShare(request: Request): Promise<Response> {
  const parts: string[] = [];
  try {
    const form = await request.formData();
    for (const key of ['title', 'text', 'url']) { const v = form.get(key); if (typeof v === 'string' && v.trim()) parts.push(v); }
    for (const item of form.getAll('files')) {
      if (typeof item === 'string') continue;
      const name = item.name.toLowerCase();
      if (item.size <= 1_000_000 && (item.type.startsWith('text/') || item.type === 'application/json' || name.endsWith('.json') || name.endsWith('.txt'))) parts.push(await item.text());
    }
    const cache = await caches.open('ikisai-invoices-share');
    await cache.put('/__shared__', new Response(JSON.stringify({ text: parts.join('\n\n'), receivedAt: new Date().toISOString() }), { headers: { 'Content-Type': 'application/json' } }));
    return Response.redirect('/#/facturas?compartido=1', 303);
  } catch {
    return Response.redirect('/#/facturas?compartido=0', 303);
  }
}

sw.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin === sw.location.origin && request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(receiveShare(request));
    return;
  }
  if (url.origin !== sw.location.origin || request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return; // nunca se cachea la API

  if (request.mode === 'navigate') {
    // Navegaciones: red primero (para recoger un index.html nuevo), shell en caché como respaldo offline.
    event.respondWith(fetch(request).catch(() => caches.match('/').then((cached) => cached ?? Response.error())));
    return;
  }
  // PDF.js (fase 2): bajo demanda, y guardado al primer uso para leer PDF también sin red.
  if (/^\/assets\/pdf[.-]/i.test(url.pathname)) {
    event.respondWith(caches.open('ikisai-invoices-ondemand').then((cache) => cache.match(request).then((cached) => cached ?? fetch(request).then((response) => {
      if (response.ok) void cache.put(request, response.clone());
      return response;
    }))));
    return;
  }
  if (SHELL.includes(url.pathname)) {
    event.respondWith(caches.open(CACHE).then((cache) => cache.match(request).then((cached) => cached ?? fetch(request))));
    return;
  }
  event.respondWith(fetch(request).catch(() => caches.match(request).then((cached) => cached ?? Response.error())));
});
