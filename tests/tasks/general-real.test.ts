/**
 * Tasks · catálogo General con datos como los de producción (FB_2026_023, aviso urgente del 9-10-2026): VG en la raíz de
 * «Persona» en cuatro áreas y bajo «Staff» en Mejoras; la familia de fases de Mejoras renombrada «Persona» (clave `phase`,
 * con una VG archivada); «Zona: Espacio» sin clave en Mejoras y, en Retiros, su familia de responsables renombrada «Zona:
 * Espacio» (clave `person`), con las mismas cinco zonas. Comprueba la corrección de claves (y de los responsables que eran
 * zonas), la fusión con madre distinta en la raíz, la familia General sin clave cuando no coinciden y «Hacer General».
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, type TestApp } from '../../packages/test-kit/src/http.ts';
import { createTasksApp, TASKS_ORIGINS } from '../../supabase/functions/tasks-api/app.ts';
import { createTabOps, type Operation } from '../../packages/domain-tasks/src/index.ts';

const origin = TASKS_ORIGINS[0]!;
const uuid = (): string => crypto.randomUUID();
const AREAS = ['Apps', 'Gestiones', 'Mantenimiento', 'Personales', 'Mejoras', 'Retiros'] as const;
const ZONES = ['Albergue', 'Depósito', 'Entre Edificios', 'Piscina', 'Salas'];
let app: TestApp;
let seq = 0;
const tab: Record<string, string> = {}, person: Record<string, string> = {}, phase: Record<string, string> = {}, vg: Record<string, string> = {};
let staff = '', zonaMejoras = '', zonaRetiros = '', personaPhase = '', solo = '';
const zoneLabels: Record<string, string[]> = { Mejoras: [], Retiros: [] };

const rows = async (t: string) => (await app.call(`/api/v1/snapshot?tables=${t}&includeDeleted=1&limit=2000`)).data.tables[0].rows as any[];
const commit = (operations: Operation[]) => app.call('/api/v1/commands', { body: { requestId: `seed-${++seq}`, operations } });
const ok = async (operations: Operation[]) => { const res = await commit(operations); assert.equal(res.status, 200, JSON.stringify(res.data)); };
const merge = (groups: unknown[]) => app.call('/api/v1/labels/general/merge', { body: { requestId: `merge-${++seq}`, groups } });

test.before(async () => {
  app = await createTestApp({ app: 'tasks', slug: 'tasks-api', origin, createHandler: (config) => createTasksApp({ ...config, origins: [origin] }) });
  let position = 0;
  for (const name of AREAS) {
    const ops = createTabOps({ id: (tab[name] = uuid()), name, position: (position += 1024) });
    person[name] = ops.find((o) => o.fields?.system_key === 'person')!.id!;
    phase[name] = ops.find((o) => o.fields?.system_key === 'phase')!.id!;
    await ok(ops);
  }
  for (const name of ['Apps', 'Gestiones', 'Mantenimiento', 'Personales']) await ok([{ op: 'insert', table: 'tasks.labels', id: (vg[name] = uuid()), fields: { tab_id: tab[name], family_id: person[name], name: 'VG', position: 1024 } }]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: (staff = uuid()), fields: { tab_id: tab.Mejoras, family_id: person.Mejoras, name: 'Staff', position: 1024 } }]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: (vg.Mejoras = uuid()), fields: { tab_id: tab.Mejoras, family_id: person.Mejoras, parent_id: staff, name: 'VG', position: 2048 } }]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: (solo = uuid()), fields: { tab_id: tab.Personales, family_id: person.Personales, name: 'Solo mía', position: 3072 } }]);
  await ok([{ op: 'insert', table: 'tasks.families', id: (zonaMejoras = uuid()), fields: { tab_id: tab.Mejoras, name: 'Zona: Espacio', color: '#7a6a55', position: 90_000, system_key: null } }]);
  // Como en producción: familias renombradas que conservan su clave de sistema.
  zonaRetiros = person.Retiros!; personaPhase = phase.Mejoras!;
  await app.t.db.query(`update tasks.families set name = 'Zona: Espacio' where id = $1`, [zonaRetiros]);
  await app.t.db.query(`update tasks.families set name = 'Persona' where id = $1`, [personaPhase]);
  await ok([{ op: 'insert', table: 'tasks.labels', id: uuid(), fields: { tab_id: tab.Mejoras, family_id: personaPhase, name: 'VG', position: 1024, archived: true } }]);
  for (const [i, z] of ZONES.entries()) {
    const m = uuid(), r = uuid();
    zoneLabels.Mejoras!.push(m); zoneLabels.Retiros!.push(r);
    await ok([
      { op: 'insert', table: 'tasks.labels', id: m, fields: { tab_id: tab.Mejoras, family_id: zonaMejoras, name: z, position: (i + 1) * 1024 } },
      { op: 'insert', table: 'tasks.labels', id: r, fields: { tab_id: tab.Retiros, family_id: zonaRetiros, name: z, position: (i + 1) * 1024 } },
    ]);
  }
  // Una tarea de Retiros con una zona y otra de Mejoras con su VG.
  const inboxOf = async (name: string) => (await rows('tasks.projects')).find((p) => p.tab_id === tab[name] && p.system === 'inbox').id;
  await ok([{ op: 'insert', table: 'tasks.tasks', id: uuid(), fields: { tab_id: tab.Mejoras, project_id: await inboxOf('Mejoras'), title: 'Con VG', position: 1024, owner_label_id: vg.Mejoras } }]);
  // En Retiros, una tarea con una zona como «responsable» (lo permitía la clave equivocada).
  await ok([{ op: 'insert', table: 'tasks.tasks', id: uuid(), fields: { tab_id: tab.Retiros, project_id: await inboxOf('Retiros'), title: 'En la piscina', position: 1024, owner_label_id: zoneLabels.Retiros![3]! } }]);
});
test.after(async () => { await app.close(); });

test('corregir las claves incoherentes (como la vista previa) y fusionar: VG en la raíz, zonas en una familia General sin clave', async () => {
  const fams = await rows('tasks.families');
  const row = (id: string) => fams.find((f) => f.id === id);
  // Sin la marca de Persona, una zona no puede seguir de responsable: la corrección los quita en el mismo lote.
  const owned = (await rows('tasks.tasks')).find((t) => t.title === 'En la piscina');
  assert.equal((await commit([{ op: 'update', table: 'tasks.families', id: zonaRetiros, expectedRevision: row(zonaRetiros).revision, fields: { system_key: null } }])).status, 422, 'sin quitar el responsable, no');
  await ok([
    { op: 'update', table: 'tasks.families', id: zonaRetiros, expectedRevision: row(zonaRetiros).revision, fields: { system_key: null } },
    { op: 'update', table: 'tasks.families', id: personaPhase, expectedRevision: row(personaPhase).revision, fields: { system_key: null } },
    { op: 'update', table: 'tasks.tasks', id: owned.id, expectedRevision: owned.revision, fields: { owner_label_id: null } },
  ]);
  const res = await merge([
    { ids: [vg.Apps, vg.Gestiones, vg.Mantenimiento, vg.Personales, vg.Mejoras], root: true },
    ...ZONES.map((_, i) => [zoneLabels.Mejoras![i]!, zoneLabels.Retiros![i]!]),
  ]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const labels = await rows('tasks.labels'), families = await rows('tasks.families'), g = res.data.generals as Record<string, string>;
  const general = labels.find((l) => l.id === g[vg.Apps!]);
  assert.deepEqual([general.tab_id, general.parent_id, general.name], [null, null, 'VG']);
  assert.equal(families.find((f) => f.id === general.family_id).system_key, 'person');
  for (const v of Object.values(vg)) assert.equal(g[v!], general.id);
  // La VG de Mejoras (bajo Staff) pasa a la General en la raíz; Staff sigue en Mejoras; su tarea, con la General.
  assert.equal(labels.find((l) => l.id === vg.Mejoras).archived, true);
  assert.equal(labels.find((l) => l.id === staff).archived, false);
  assert.equal((await rows('tasks.tasks')).find((t) => t.title === 'Con VG').owner_label_id, general.id);
  // Zonas: una familia General «Zona: Espacio» sin clave (en Retiros no eran responsables).
  const zone = labels.find((l) => l.id === g[zoneLabels.Mejoras![0]!]);
  const zf = families.find((f) => f.id === zone.family_id);
  assert.deepEqual([zf.tab_id, zf.name, zf.system_key], [null, 'Zona: Espacio', null]);
  assert.equal(labels.filter((l) => l.tab_id === null && l.family_id === zf.id).length, 5);
});

test('«Hacer General» con una sola etiqueta', async () => {
  const res = await merge([[solo]]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const made = (await rows('tasks.labels')).find((l) => l.id === res.data.generals[solo]);
  assert.deepEqual([made.tab_id, made.name], [null, 'Solo mía']);
  // Dos de la misma área en un grupo, no.
  const bad = await merge([[staff, (await rows('tasks.labels')).find((l) => l.tab_id === tab.Mejoras && l.name === 'Albergue').id]]);
  assert.equal(bad.status, 422);
});
