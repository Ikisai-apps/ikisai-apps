/** Base PGlite con todas las migraciones y ayudas para probar `tasks.*` a través de `core.commit`. */
import assert from 'node:assert/strict';
import { createTestDatabase, RpcError, type TestDatabase } from '../../packages/test-kit/src/pglite.ts';
import { TABLES, createTabOps, emptyDataset, type Dataset, type Operation } from '../../packages/domain-tasks/src/index.ts';

export interface TasksDb {
  t: TestDatabase;
  owner: string;
  /** Crea un usuario con pertenencia a Tasks. */
  member(role: 'reader' | 'editor' | 'owner', scopes?: unknown): Promise<string>;
  setScopes(userId: string, scopes: unknown): Promise<void>;
  /** Ejecuta un lote con `core.commit` como el actor indicado (por defecto, el propietario). */
  commit(operations: Operation[], actor?: string): Promise<{ cursor: number; results: any[]; changes: any[] }>;
  /** Todas las filas, incluidas las borradas, como las vería el espejo de un propietario. */
  data(): Promise<Dataset>;
  /** Área nueva con Entrada y familias; devuelve sus ids. */
  area(name?: string): Promise<{ tab: string; inbox: string; families: Record<string, string> }>;
  read(name: string, args: Record<string, unknown>, actor?: string): Promise<any>;
  close(): Promise<void>;
}

let sequence = 0;
export const newId = (): string => crypto.randomUUID();

export async function createTasksDb(): Promise<TasksDb> {
  const t = await createTestDatabase();
  const owner = await t.createUser();
  await t.db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Propietaria')`, [owner]);
  await t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, 'owner', '"*"'::jsonb)`, [owner]);

  const api: TasksDb = {
    t, owner,
    async member(role, scopes = '*') {
      const id = await t.createUser();
      await t.db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Persona')`, [id]);
      await t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ('tasks', $1, $2, $3::jsonb)`, [id, role, JSON.stringify(scopes)]);
      return id;
    },
    async setScopes(userId, scopes) {
      await t.db.query(`update core.memberships set scopes = $2::jsonb, revision = revision + 1 where app = 'tasks' and user_id = $1`, [userId, JSON.stringify(scopes)]);
    },
    async commit(operations, actor = owner) {
      const requestId = `test-${++sequence}`;
      return (await t.rpc('core_commit', { p_app: 'tasks', p_actor: actor, p_request_id: requestId, p_digest: requestId, p_expected_cursor: null, p_operations: operations })) as any;
    },
    async data() {
      const out = emptyDataset() as unknown as Record<string, unknown[]>;
      for (const table of TABLES) {
        const result = (await t.rpc('core_snapshot_table', { p_app: 'tasks', p_role: 'owner', p_table: table, p_include_deleted: true, p_limit: 2000, p_offset: 0 })) as { rows: unknown[] };
        out[table] = result.rows;
      }
      return out as unknown as Dataset;
    },
    async area(name = 'Área') {
      const tab = newId(), inbox = newId();
      const ops = createTabOps({ id: tab, name, position: 1024, inboxId: inbox });
      await api.commit(ops);
      const families: Record<string, string> = {};
      for (const op of ops) if (op.table === 'tasks.families') families[String(op.fields!.system_key)] = op.id!;
      return { tab, inbox, families };
    },
    async read(name, args, actor = owner) {
      return t.rpc('core_read', { p_app: 'tasks', p_actor: actor, p_name: name, p_args: args });
    },
    close: () => t.close(),
  };
  return api;
}

/** Comprueba que la promesa falla con el código de dominio indicado y devuelve sus detalles. */
export async function rejects(promise: Promise<unknown>, code: string): Promise<any> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof RpcError, String(error));
    assert.equal(error.code, code, `${error.code} ${JSON.stringify(error.details)}`);
    return error.details;
  }
  assert.fail(`se esperaba ${code} y el lote se aceptó`);
}

export const insert = (table: string, id: string, fields: Record<string, unknown>): Operation => ({ op: 'insert', table, id, fields });
export const update = (table: string, id: string, expectedRevision: number, fields: Record<string, unknown>): Operation => ({ op: 'update', table, id, expectedRevision, fields });
export const remove = (table: string, id: string, expectedRevision: number): Operation => ({ op: 'delete', table, id, expectedRevision });
export const restore = (table: string, id: string, expectedRevision: number): Operation => ({ op: 'restore', table, id, expectedRevision });
