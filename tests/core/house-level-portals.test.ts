/** Nivel de casa → portales y Flow (0095): dirección entra en Guests y Organizers con «todos» y es owner de Flow; staff y outsider, lo suyo; el pase se alarga al refrescar. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp } from '../../packages/test-kit/src/http.ts';
import { createApp } from '../../supabase/functions/_kit/mod.ts';

test('nivel de casa · dirección: owner de Flow, «todos» en los portales (en Guests solo sin huésped); al bajar de nivel se retira', async () => {
  const app = await createTestApp({ app: 'central', slug: 'central-api', origin: 'https://central.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'central', slug: 'central-api', origins: ['https://central.ikisai.com'] }) });
  try {
    const db = app.t.db;
    const boss = await app.t.createUser();
    await db.query(`select core.apply_house_level($1, 'direccion')`, [boss]);
    const roles = await db.query<{ app: string; role: string; all: boolean }>(
      `select app, role, core.portal_all_grant(scopes) as all from core.memberships where user_id = $1 order by app`, [boss]);
    const byApp = Object.fromEntries(roles.rows.map((r) => [r.app, r]));
    assert.equal(byApp.flow?.role, 'owner');
    assert.equal(byApp.tasks?.role, 'owner');
    assert.equal(byApp.guests?.role, 'editor'); assert.equal(byApp.guests?.all, true);
    assert.equal(byApp.organizers?.role, 'editor'); assert.equal(byApp.organizers?.all, true);
    const reservation = crypto.randomUUID();
    const scope = async (portal: string, guest: string | null) =>
      (await db.query<{ ok: boolean }>(`select core.portal_in_scope($1, $2, $3, $4) as ok`, [portal, boss, reservation, guest])).rows[0]?.ok;
    assert.equal(await scope('organizers', null), true, 'coorganizadora de cualquier retiro');
    assert.equal(await scope('guests', null), true, 've cualquier retiro');
    assert.equal(await scope('guests', crypto.randomUUID()), false, 'pero no actúa como un huésped ajeno');
    // Baja a staff: pierde «todos» y el owner derivado; Flow queda como editor.
    await db.query(`select core.apply_house_level($1, 'staff')`, [boss]);
    const after = await db.query<{ app: string; role: string; all: boolean }>(
      `select app, role, core.portal_all_grant(scopes) as all from core.memberships where user_id = $1 order by app`, [boss]);
    const afterByApp = Object.fromEntries(after.rows.map((r) => [r.app, r]));
    assert.equal(afterByApp.flow?.role, 'editor');
    assert.equal(afterByApp.guests, undefined, 'sin nivel dirección no hay pertenencia derivada en Guests');
    assert.equal(afterByApp.organizers, undefined);
  } finally {
    await app.close();
  }
});

test('nivel de casa · outsider es outsider en Flow; el pase común se alarga al tocarlo', async () => {
  const app = await createTestApp({ app: 'central', slug: 'central-api', origin: 'https://central.ikisai.com', createHandler: (config) =>
    createApp({ ...config, app: 'central', slug: 'central-api', origins: ['https://central.ikisai.com'] }) });
  try {
    const db = app.t.db;
    const helper = await app.t.createUser();
    await db.query(`select core.apply_house_level($1, 'outsider')`, [helper]);
    const flow = await db.query<{ role: string }>(`select role from core.memberships where user_id = $1 and app = 'flow'`, [helper]);
    assert.equal(flow.rows[0]?.role, 'outsider');
    const digest = 'a'.repeat(64);
    await db.query(`select core.sso_issue($1, $2, 1)`, [helper, digest]);
    const before = (await db.query<{ e: string }>(`select expires_at::text as e from core.sso_passes where digest = $1`, [digest])).rows[0]?.e;
    const touched = (await db.query<{ ok: boolean }>(`select core.sso_touch($1, 30) as ok`, [digest])).rows[0]?.ok;
    assert.equal(touched, true);
    const after = (await db.query<{ e: string }>(`select expires_at::text as e from core.sso_passes where digest = $1`, [digest])).rows[0]?.e;
    assert.ok(after! > before!, 'caduca más tarde');
    assert.equal((await db.query<{ ok: boolean }>(`select core.sso_touch($1, 30) as ok`, ['b'.repeat(64)])).rows[0]?.ok, false);
  } finally {
    await app.close();
  }
});
