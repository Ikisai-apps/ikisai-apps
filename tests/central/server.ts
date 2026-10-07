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
  close(): Promise<void>;
}

export async function startCentralServer(): Promise<CentralTestServer> {
  const origin = CENTRAL_ORIGINS[0]!;
  const app = await createTestApp({
    app: 'central', slug: 'central-api', origin,
    createHandler: (config) => createCentralApp({ ...config, origins: [origin] }),
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
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await app.close();
    },
  };
}
