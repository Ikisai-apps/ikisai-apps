/**
 * Servidor de pruebas de extremo a extremo de Tasks: sirve `apps/tasks/dist` y atiende `/api/v1/*` con la
 * `tasks-api` real sobre PGlite (arnés de `packages/test-kit`). La interfaz, el adaptador, `sync-client`, los hooks
 * de la Edge y el hook SQL son los de producción; solo Supabase (Auth, PostgREST, Storage) está simulado.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { createTestApp, TEST_PASSWORD, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp } from '../../supabase/functions/tasks-api/app.ts';
import type { Operation } from '../../packages/domain-tasks/src/index.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const DIST = path.resolve(here, '../../apps/tasks/dist');
export const VITE_CONFIG = path.resolve(here, '../../apps/tasks/vite.config.ts');
export const OWNER = { email: 'owner@example.invalid', password: TEST_PASSWORD };
export const EDITOR = { email: 'editor@example.invalid', password: TEST_PASSWORD };
export const READER = { email: 'reader@example.invalid', password: TEST_PASSWORD };

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.json': 'application/json', '.png': 'image/png',
};

export interface E2EServer {
  url: string;
  app: TestApp;
  /** Lote confirmado directamente en el servidor, como si viniera de otro dispositivo. */
  commit(operations: Operation[], token?: string): Promise<{ status: number; data: any }>;
  /** Filas de una tabla (incluida la papelera) tal y como están en el servidor. */
  rows(table: string): Promise<any[]>;
  /** Peticiones recibidas por la API (método y ruta). */
  requests: Array<{ method: string; path: string }>;
  close(): Promise<void>;
}

async function body(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

export async function startE2EServer(): Promise<E2EServer> {
  let app: TestApp | null = null;
  const requests: Array<{ method: string; path: string }> = [];
  const server: Server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (url.pathname.startsWith('/api/')) {
        requests.push({ method: request.method ?? 'GET', path: url.pathname });
        const payload = ['GET', 'HEAD'].includes(request.method ?? 'GET') ? undefined : await body(request);
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers)) if (typeof value === 'string') headers.set(key, value);
        const result = await app!.handler(new Request(`http://localhost${url.pathname}${url.search}`, { method: request.method, headers, body: payload }));
        response.writeHead(result.status, Object.fromEntries(result.headers));
        response.end(Buffer.from(await result.arrayBuffer()));
        return;
      }
      const file = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const target = path.join(DIST, file);
      if (!target.startsWith(DIST)) { response.writeHead(403).end(); return; }
      const content = await readFile(target).catch(() => null);
      if (!content) { response.writeHead(404).end('not found'); return; }
      response.writeHead(200, { 'Content-Type': MIME[path.extname(target)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
      response.end(content);
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: { code: 'TEST_SERVER', message: String(error), details: null } }));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // El Auth simulado del test-kit no crea cuentas: aquí se añade lo que usa `members/invite` (alta por la API de
  // administración y entrada con la contraseña temporal) para poder probar invitados de extremo a extremo.
  const invited = new Map<string, { id: string; password: string }>();
  const withInvitedUsers = (inner: typeof fetch): typeof fetch => async (input, init = {}) => {
    const route = new URL(typeof input === 'string' ? input : (input as Request).url);
    const method = (init.method ?? 'GET').toUpperCase();
    const payload = typeof init.body === 'string' && init.body ? JSON.parse(init.body) : {};
    if (route.pathname === '/auth/v1/admin/users') {
      if (method !== 'POST') return Response.json({ users: [...invited].map(([email, user]) => ({ id: user.id, email })) });
      if (invited.has(payload.email) || /^(owner|editor|reader)@example\.invalid$/.test(payload.email)) return Response.json({ code: 'email_exists', message: 'exists' }, { status: 422 });
      const id = await app!.t.createUser();
      invited.set(payload.email, { id, password: payload.password });
      return Response.json({ id, email: payload.email });
    }
    if (route.pathname === '/auth/v1/token' && route.searchParams.get('grant_type') === 'password' && invited.has(payload.email)) {
      const user = invited.get(payload.email)!;
      if (payload.password !== user.password) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      await app!.t.createUser(user.id);
      return Response.json({ access_token: app!.supabase.tokenFor(user.id), refresh_token: `refresh-invited-${user.id}`, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    // Subida de objetos desde la Edge (paquetes de importación y adjuntos de una copia portable).
    if (route.pathname.startsWith('/storage/v1/object/') && !route.pathname.includes('/sign/') && method === 'POST') {
      const objectPath = decodeURIComponent(route.pathname.slice('/storage/v1/object/'.length)).split('/').slice(1).join('/');
      const content = init.body instanceof Uint8Array ? init.body : new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer());
      app!.supabase.storage.set(objectPath, content);
      return Response.json({ Key: objectPath });
    }
    return inner(input, init);
  };
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin: url, createHandler: (config) => createTasksApp({ ...config, fetch: withInvitedUsers(config.fetch), origins: [url] }) });
  const ready = app;
  let sequence = 0;
  return {
    url, app: ready, requests,
    commit: (operations, token) => ready.call('/api/v1/commands', { body: { requestId: `server-${++sequence}`, operations }, ...(token ? { token } : {}) }),
    async rows(table) {
      // Directo a la base: no depende de que la sesión de ningún usuario siga abierta.
      const result = (await ready.t.rpc('core_snapshot_table', { p_app: 'tasks', p_role: 'owner', p_table: table, p_include_deleted: true, p_limit: 2000, p_offset: 0 })) as { rows: any[] };
      return result.rows;
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await ready.close();
    },
  };
}
