/**
 * Central · servidor HTTP para las pruebas de interfaz: la `central-api` real (núcleo + admin) sobre PGlite con el
 * Supabase simulado del test-kit. Sin API falsa: lo que ve la pantalla es lo que responde la Edge.
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
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && key !== 'host' && key !== 'content-length') headers.set(key, value);
      // El proxy de `vite preview` conserva el Origin del navegador: la Edge solo admite el de producción.
      headers.set('Origin', origin);
      const request = new Request(`${app.supabase.url}/functions/v1/central-api${req.url ?? '/'}`, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      });
      const response = await app.handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
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
