/**
 * Central · servidor HTTP para las pruebas de interfaz: la `central-api` real (núcleo + admin) sobre PGlite con el
 * Supabase simulado del test-kit. Sin API falsa: lo que ve la pantalla es lo que responde la Edge.
 * La subida directa al bucket (PUT a la URL firmada) se reenvía aquí: `uploadUrl` pasa a `/api/__upload?path=…`.
 */
import { createServer, type Server } from 'node:http';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../../packages/test-kit/src/http.ts';
import { CENTRAL_ORIGINS, createCentralApp } from '../../supabase/functions/central-api/app.ts';

export interface CentralTestServer {
  url: string;
  app: TestApp;
  password: string;
  /** Peticiones que la Edge ha hecho al Tasks simulado. */
  tasksCalls: Array<{ path: string; body: any }>;
  close(): Promise<void>;
}

/**
 * Tasks simulado: crea peticiones «por clasificar» (sin regla de enrutado) y devuelve su estado. Nunca se llama al real.
 */
function fakeTasks(calls: Array<{ path: string; body: any }>): typeof fetch {
  const ids = new Map<string, string>();
  return async (input, init) => {
    const path = new URL(String(input)).pathname.replace('/api/v1/', '');
    const body = JSON.parse(String(init?.body ?? '{}'));
    calls.push({ path, body });
    if (path === 'requests/task') {
      if (!ids.has(body.external_ref)) ids.set(body.external_ref, crypto.randomUUID());
      return Response.json({ created: true, routed: 'pending', task: { kind: 'task', id: ids.get(body.external_ref), visible: false, pending: true } });
    }
    return Response.json({ items: (body.ids ?? []).map((id: string) => ({ kind: 'task', id, visible: false, request: 'pending' })), missing: [] });
  };
}

export async function startCentralServer(): Promise<CentralTestServer> {
  const origin = CENTRAL_ORIGINS[0]!;
  const tasksCalls: Array<{ path: string; body: any }> = [];
  const app = await createTestApp({
    app: 'central', slug: 'central-api', origin,
    createHandler: (config) => createCentralApp({ ...config, origins: [origin] }, { tasksApiBase: 'https://tasks.example.invalid', tasksFetch: fakeTasks(tasksCalls) }),
  });
  const server: Server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const local = new URL(req.url ?? '/', 'http://local');
      if (local.pathname === '/api/__upload' && req.method === 'PUT') {
        app.supabase.storage.set(local.searchParams.get('path') ?? '', new Uint8Array(Buffer.concat(chunks)));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
        return;
      }
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && key !== 'host' && key !== 'content-length') headers.set(key, value);
      // El proxy de `vite preview` conserva el Origin del navegador: la Edge solo admite el de producción.
      headers.set('Origin', origin);
      const request = new Request(`${app.supabase.url}/functions/v1/central-api${req.url ?? '/'}`, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      });
      const response = await app.handler(request);
      let payload = Buffer.from(await response.arrayBuffer());
      const headersOut = Object.fromEntries(response.headers);
      if (local.pathname === '/api/v1/uploads' && response.ok) {
        const ticket = JSON.parse(payload.toString('utf8'));
        if (typeof ticket.path === 'string') ticket.uploadUrl = `/api/__upload?path=${encodeURIComponent(ticket.path)}`;
        payload = Buffer.from(JSON.stringify(ticket));
        delete headersOut['content-length'];
      }
      res.writeHead(response.status, headersOut);
      res.end(payload);
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'TEST_SERVER', message: String(error), details: null } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    app,
    password: TEST_PASSWORD,
    tasksCalls,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    },
  };
}
