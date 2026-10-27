/** 0105: los hooks de validación reciben el rol y los ámbitos con los que empezó el lote, aunque un trigger del lote los cambie. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDatabase } from '../../packages/test-kit/src/pglite.ts';

const APP = 'invoices';
const TABLE = 'invoices.suppliers';

test('hooks · el payload lleva role y scopes iniciales; un trigger que sube el rol dentro del lote no engaña al hook', async () => {
  const t = await createTestDatabase();
  const editor = await t.createUser();
  await t.db.query(`insert into core.profiles (user_id, display_name) values ($1, 'Editor')`, [editor]);
  await t.db.query(`insert into core.memberships (app, user_id, role, scopes) values ($1, $2, 'editor', '{"projects": ["p1"]}'::jsonb)`, [APP, editor]);
  // Un trigger malicioso o descuidado que, al insertar un proveedor, sube al actor a owner dentro del mismo lote.
  await t.db.exec(`
    create function public.test_escalate() returns trigger language plpgsql as $$
    begin update core.memberships set role = 'owner', scopes = '{}'::jsonb where app = 'invoices'; return new; end $$;
    create trigger test_escalate after insert on invoices.suppliers for each row execute function public.test_escalate();
    create table public.test_hook_seen (role text, scopes jsonb, role_in_table text);
    create function public.test_hook(p jsonb) returns void language plpgsql as $$
    begin
      insert into public.test_hook_seen (role, scopes, role_in_table)
      select p->>'role', p->'scopes', (select role from core.memberships where app = p->>'app' and user_id = (p->>'actor')::uuid);
    end $$;
    insert into core.validate_hooks (app, procedure) values ('invoices', 'public.test_hook');
  `);
  const ops = [{ op: 'insert', table: TABLE, id: crypto.randomUUID(), fields: { name: 'Makro', tax_id: 'A12345678' } }];
  await t.rpc('core_commit', { p_app: APP, p_actor: editor, p_request_id: 'h1', p_digest: 'd1', p_expected_cursor: null, p_operations: ops });
  const seen = (await t.db.query<{ role: string; scopes: { projects: string[] }; role_in_table: string }>('select role, scopes, role_in_table from public.test_hook_seen')).rows[0]!;
  assert.equal(seen.role, 'editor', 'el hook recibe el rol con el que empezó el lote');
  assert.deepEqual(seen.scopes, { projects: ['p1'] }, 'y los ámbitos iniciales');
  assert.equal(seen.role_in_table, 'owner', 'la tabla ya decía owner: por eso no hay que leerla desde el hook');
  await t.close();
});
