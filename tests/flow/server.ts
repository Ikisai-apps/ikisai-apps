/**
 * Flow · servidor HTTP para las pruebas de interfaz: la `flow-api` real (núcleo del kit) sobre PGlite con el Supabase
 * simulado del test-kit. Sin API falsa: lo que ve la pantalla es lo que responde la Edge.
 */
import { createServer, type Server } from 'node:http';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../../packages/test-kit/src/http.ts';
import { FLOW_ORIGINS, createFlowApp } from '../../supabase/functions/flow-api/app.ts';

export interface FlowTestServer {
  url: string;
  app: TestApp;
  password: string;
  close(): Promise<void>;
}

/** Las cuentas de prueba ya aceptaron el aviso de medición de uso, para que su hoja no tape las pantallas. */
export async function startFlowServer(): Promise<FlowTestServer> {
  const origin = FLOW_ORIGINS[0]!;
  const app = await createTestApp({ app: 'flow', slug: 'flow-api', origin, createHandler: (config) => createFlowApp({ ...config, origins: [origin] }) });
  for (const token of Object.values(app.tokens)) {
    const res = await app.call('/api/v1/usage/consent', { token, body: {} });
    if (res.status !== 200) throw new Error(`usage/consent ${res.status}: ${JSON.stringify(res.data)}`);
  }
  const server: Server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (typeof value === 'string' && key !== 'host' && key !== 'content-length') headers.set(key, value);
      // El proxy de `vite preview` conserva el Origin del navegador: la Edge solo admite el de producción.
      headers.set('Origin', origin);
      const response = await app.handler(new Request(`${app.supabase.url}/functions/v1/flow-api${req.url ?? '/'}`, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      }));
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
