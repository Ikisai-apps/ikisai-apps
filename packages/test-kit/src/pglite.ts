/**
 * Base de datos de pruebas: PGlite con los stubs mínimos de Supabase (schema auth, roles)
 * y todas las migraciones del repo aplicadas en orden. Sirve a la suite de conformidad
 * y a las pruebas de cada app.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const MIGRATIONS_DIR = path.join(REPO_ROOT, 'supabase/migrations');

export interface TestDatabase {
  db: PGlite;
  /** Ejecuta `select public.<name>(args…)` con los casts tomados del catálogo. */
  rpc(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Crea un usuario Auth sintético con sesión activa y devuelve su id. */
  createUser(id?: string): Promise<string>;
  /** Cierra la sesión del usuario (simula logout). */
  revokeSessions(userId: string): Promise<void>;
  close(): Promise<void>;
}

export class RpcError extends Error {
  code: string;
  details: unknown;
  sqlstate: string;
  constructor(sqlstate: string, message: string, details: unknown) {
    super(message);
    this.sqlstate = sqlstate;
    this.code = message;
    this.details = details;
  }
}

const AUTH_STUBS = `
create schema if not exists auth;
create table if not exists auth.users (id uuid primary key, email text, created_at timestamptz default now(), last_sign_in_at timestamptz);
create table if not exists auth.sessions (id uuid primary key, user_id uuid references auth.users(id) on delete cascade, not_after timestamptz, created_at timestamptz default now());
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
end $$;
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`;

export function migrationFiles(dir: string = MIGRATIONS_DIR): string[] {
  return fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
}

export async function createTestDatabase(options: { migrations?: string[] } = {}): Promise<TestDatabase> {
  const db = new PGlite();
  await db.exec(AUTH_STUBS);
  for (const file of options.migrations ?? migrationFiles()) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`Migración ${file} falló: ${(error as Error).message}`);
    }
  }
  const signatures = new Map<string, Array<{ name: string; type: string }>>();
  const rows = (await db.query<{ proname: string; args: string }>(
    `select p.proname, pg_get_function_identity_arguments(p.oid) args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
  )).rows;
  for (const row of rows) {
    const args = row.args
      ? row.args.split(',').map((part) => {
          const [name, ...type] = part.trim().split(/\s+/);
          return { name: name as string, type: type.join(' ') };
        })
      : [];
    signatures.set(row.proname, args);
  }
  return {
    db,
    async rpc(name, args) {
      const signature = signatures.get(name);
      if (!signature) throw new Error(`RPC desconocida: ${name}`);
      const placeholders = signature.map((arg, i) => `$${i + 1}::${arg.type}`).join(',');
      const values = signature.map((arg) => {
        const value = args[arg.name];
        if (value === undefined) return null;
        return arg.type === 'jsonb' ? JSON.stringify(value) : value;
      });
      try {
        const result = await db.query<{ result: unknown }>(`select public.${name}(${placeholders}) result`, values);
        return result.rows[0]?.result;
      } catch (error) {
        const e = error as { code?: string; message: string; detail?: string };
        let details: unknown = null;
        if (e.detail) {
          try { details = JSON.parse(e.detail); } catch { details = e.detail; }
        }
        throw new RpcError(e.code ?? 'XX000', e.message, details);
      }
    },
    async createUser(id = crypto.randomUUID()) {
      await db.query('insert into auth.users (id, email) values ($1, $2) on conflict do nothing', [id, `${id}@example.invalid`]);
      await db.query('insert into auth.sessions (id, user_id, not_after) values ($1, $1, null) on conflict do nothing', [id]);
      return id;
    },
    async revokeSessions(userId) {
      await db.query('delete from auth.sessions where user_id = $1', [userId]);
    },
    async close() {
      await db.close();
    },
  };
}
