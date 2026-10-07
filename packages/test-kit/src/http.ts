/**
 * Arnés HTTP: monta una Edge app del kit sobre PGlite simulando Supabase (PostgREST RPC, Auth y Storage).
 * Permite ejecutar la suite de conformidad y las pruebas de cada app sin red.
 */
import { createTestDatabase, RpcError, type TestDatabase } from './pglite.ts';

export interface FakeSupabase {
  fetch: typeof fetch;
  tokenFor(userId: string): string;
  /** Simula una respuesta perdida tras confirmar el siguiente commit. */
  loseNextCommitReply(): void;
  storageOffline(value: boolean): void;
  storage: Map<string, Uint8Array>;
  anonKey: string;
  serviceKey: string;
  url: string;
}

const PASSWORD = 'correct horse battery staple';

export function createFakeSupabase(t: TestDatabase, users: Map<string, string> = new Map()): FakeSupabase {
  const anonKey = 'public-anon-key';
  const serviceKey = 'private-service-key';
  const url = 'https://test.supabase.co';
  const tokens = new Map<string, string>(); // token -> userId
  const refreshTokens = new Map<string, string>(); // refresh -> userId
  const magicLinks = new Map<string, string>(); // hashed_token -> userId
  const storage = new Map<string, Uint8Array>();
  let loseReply = false;
  let storageDown = false;

  function mockToken(userId: string): string {
    const payload = Buffer.from(JSON.stringify({ sub: userId, session_id: userId, role: 'authenticated' })).toString('base64url');
    const token = `test.${payload}.sig`;
    tokens.set(token, userId);
    return token;
  }

  const transport: typeof fetch = async (input, init = {}) => {
    const route = new URL(typeof input === 'string' ? input : (input as Request).url);
    const headers = new Headers(init.headers as HeadersInit);
    const auth = headers.get('authorization')?.replace(/^Bearer /, '') ?? null;
    const apikey = headers.get('apikey');
    const method = (init.method ?? 'GET').toUpperCase();
    const bodyText = typeof init.body === 'string' ? init.body : null;
    const body = bodyText ? JSON.parse(bodyText) : {};

    if (route.pathname.startsWith('/storage/v1/')) {
      if (apikey !== serviceKey) return Response.json({ message: 'forbidden' }, { status: 403 });
      if (storageDown) return Response.json({ error: 'offline' }, { status: 503 });
      const rest = route.pathname.slice('/storage/v1/'.length);
      if (rest.startsWith('object/upload/sign/')) {
        const objectPath = rest.slice('object/upload/sign/'.length);
        return Response.json({ url: `/object/upload/sign/${objectPath}?token=upload-${Math.random().toString(36).slice(2)}` });
      }
      if (rest.startsWith('object/sign/')) {
        const objectPath = rest.slice('object/sign/'.length);
        return Response.json({ signedURL: `/object/sign/${objectPath}?token=read-token` });
      }
      if (rest.startsWith('object/')) {
        // clave del almacén simulado: ruta sin el bucket
        const objectPath = decodeURIComponent(rest.slice('object/'.length)).split('/').slice(1).join('/');
        if (method === 'GET') {
          const data = storage.get(objectPath);
          return data ? new Response(data, { headers: { 'content-length': String(data.byteLength) } }) : Response.json({ message: 'not found' }, { status: 404 });
        }
      }
      return Response.json({ message: 'unsupported' }, { status: 400 });
    }

    if (route.pathname.startsWith('/auth/v1/admin/users/') && method === 'PUT') {
      if (apikey !== serviceKey || auth !== serviceKey) return Response.json({ message: 'permission denied' }, { status: 401 });
      const id = route.pathname.split('/').at(-1)!;
      if (body.ban_duration) await t.db.query('update auth.users set banned_until = $2 where id = $1', [id, body.ban_duration === 'none' ? null : new Date(Date.now() + 1e11).toISOString()]);
      return Response.json({ id, email: users.get(id) });
    }
    if (route.pathname.startsWith('/auth/v1/admin/users/') && method === 'GET') {
      if (apikey !== serviceKey || auth !== serviceKey) return Response.json({ message: 'permission denied' }, { status: 401 });
      const id = route.pathname.split('/').at(-1)!;
      return users.has(id) ? Response.json({ id, email: users.get(id) }) : Response.json({ message: 'not found' }, { status: 404 });
    }
    if (route.pathname === '/auth/v1/admin/generate_link') {
      if (apikey !== serviceKey || auth !== serviceKey) return Response.json({ message: 'permission denied' }, { status: 401 });
      const userId = [...users.entries()].find(([, email]) => email === body.email)?.[0];
      if (!userId) return Response.json({ message: 'not found' }, { status: 404 });
      const hashed = `hash-${Math.random().toString(36).slice(2)}`; magicLinks.set(hashed, userId);
      return Response.json({ id: userId, email: body.email, hashed_token: hashed });
    }
    if (route.pathname === '/auth/v1/verify' && method === 'POST') {
      const userId = magicLinks.get(body.token_hash);
      if (!userId) return Response.json({ error: 'invalid' }, { status: 400 });
      magicLinks.delete(body.token_hash);
      await t.createUser(userId);
      const token = mockToken(userId); const refresh = `refresh-${Math.random().toString(36).slice(2)}`; refreshTokens.set(refresh, userId);
      return Response.json({ access_token: token, refresh_token: refresh, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    if (route.pathname === '/auth/v1/admin/users') {
      if (apikey !== serviceKey || auth !== serviceKey) return Response.json({ message: 'permission denied' }, { status: 401 });
      if (method === 'POST') {
        const email = String(body.email ?? '').toLowerCase();
        if ([...users.values()].includes(email)) return Response.json({ code: 'email_exists', msg: 'User already registered' }, { status: 422 });
        const id = await t.createUser();
        users.set(id, email);
        return Response.json({ id, email, role: 'authenticated' });
      }
      return Response.json({ users: [...users.entries()].map(([id, email]) => ({ id, email })) });
    }
    if (route.pathname === '/auth/v1/user') {
      if (method === 'PUT') return Response.json({ id: tokens.get(auth ?? '') });
      const id = tokens.get(auth ?? '');
      return Response.json(id ? { id, role: 'authenticated', email: users.get(id) ?? `${id}@example.invalid` } : { message: 'invalid' }, { status: id ? 200 : 401 });
    }
    if (route.pathname === '/auth/v1/token') {
      const grant = route.searchParams.get('grant_type');
      if (grant === 'password') {
        const userId = [...users.entries()].find(([, email]) => email === body.email)?.[0];
        if (!userId || body.password !== PASSWORD) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        await t.createUser(userId); // vuelve a abrir la sesión si un logout anterior la cerró (C18)
        const token = mockToken(userId); const refresh = `refresh-${Math.random().toString(36).slice(2)}`; refreshTokens.set(refresh, userId);
        return Response.json({ access_token: token, refresh_token: refresh, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600 });
      }
      if (grant === 'refresh_token') {
        const userId = refreshTokens.get(body.refresh_token);
        if (!userId) return Response.json({ error: 'invalid_grant' }, { status: 400 });
        refreshTokens.delete(body.refresh_token);
        const token = mockToken(userId); const refresh = `refresh-${Math.random().toString(36).slice(2)}`; refreshTokens.set(refresh, userId);
        return Response.json({ access_token: token, refresh_token: refresh, expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600 });
      }
      return Response.json({ error: 'unsupported' }, { status: 400 });
    }
    if (route.pathname === '/auth/v1/logout') {
      const id = tokens.get(auth ?? '');
      if (id && route.searchParams.get('scope') !== 'others') await t.revokeSessions(id);
      return new Response(null, { status: 204 });
    }

    if (route.pathname.startsWith('/rest/v1/rpc/')) {
      if (apikey !== serviceKey || auth !== serviceKey) return Response.json({ message: 'permission denied' }, { status: 401 });
      const name = route.pathname.split('/').at(-1)!;
      try {
        const result = await t.rpc(name, body);
        if (name === 'core_commit' && loseReply) { loseReply = false; throw new TypeError('simulated lost reply'); }
        return Response.json(result);
      } catch (error) {
        if (error instanceof TypeError) throw error;
        if (error instanceof RpcError) {
          return Response.json({ code: error.sqlstate, message: error.code, details: error.details === null ? null : JSON.stringify(error.details), hint: null }, { status: 400 });
        }
        return Response.json({ code: 'XX000', message: String((error as Error).message) }, { status: 500 });
      }
    }
    return Response.json({ message: 'unknown route ' + route.pathname }, { status: 404 });
  };

  return {
    fetch: transport,
    tokenFor: mockToken,
    loseNextCommitReply: () => { loseReply = true; },
    storageOffline: (value) => { storageDown = value; },
    storage, anonKey, serviceKey, url,
  };
}

export interface TestApp {
  t: TestDatabase;
  supabase: FakeSupabase;
  handler: (request: Request) => Promise<Response>;
  users: { owner: string; editor: string; reader: string };
  tokens: { owner: string; editor: string; reader: string };
  origin: string;
  call(path: string, options?: { token?: string | null; body?: unknown; method?: string; origin?: string; headers?: Record<string, string> }): Promise<{ status: number; data: any; headers: Headers }>;
  close(): Promise<void>;
}

export interface TestAppOptions {
  app: string;
  origin: string;
  slug: string;
  createHandler: (config: { url: string; anonKey: string; serviceKey: string; fetch: typeof fetch; origins: string[]; release: string }) => (request: Request) => Promise<Response>;
}

export const TEST_PASSWORD = PASSWORD;

export async function createTestApp(options: TestAppOptions): Promise<TestApp> {
  const t = await createTestDatabase();
  const owner = await t.createUser();
  const editor = await t.createUser();
  const reader = await t.createUser();
  const emails = new Map([[owner, 'owner@example.invalid'], [editor, 'editor@example.invalid'], [reader, 'reader@example.invalid']]);
  await t.db.query(`insert into core.profiles (user_id, display_name) values ($1,'Owner'),($2,'Editor'),($3,'Reader')`, [owner, editor, reader]);
  await t.db.query(`insert into core.memberships (app, user_id, role) values ($1,$2,'owner'),($1,$3,'editor'),($1,$4,'reader')`, [options.app, owner, editor, reader]);
  const supabase = createFakeSupabase(t, emails);
  const handler = options.createHandler({ url: supabase.url, anonKey: supabase.anonKey, serviceKey: supabase.serviceKey, fetch: supabase.fetch, origins: [options.origin], release: 'test' });
  const tokens = { owner: supabase.tokenFor(owner), editor: supabase.tokenFor(editor), reader: supabase.tokenFor(reader) };
  return {
    t, supabase, handler, origin: options.origin,
    users: { owner, editor, reader }, tokens,
    async call(path, { token = tokens.owner, body, method, origin = options.origin, headers: extra = {} } = {}) {
      const request = new Request(`${supabase.url}/functions/v1/${options.slug}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const response = await handler(request);
      const text = await response.text();
      let data: any = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = text; }
      return { status: response.status, data, headers: response.headers };
    },
    close: () => t.close(),
  };
}
