/**
 * Tasks · regla de nombres de etiquetas (FB_2026_033; docs/tasks/API.md §27.2). Cada caso se prueba dos veces: contra el
 * hook real (`tasks.validate_label_names`, PGlite con todas las migraciones) y con el dominio (`assertLabelNames`, lo que
 * comprueba el núcleo del navegador antes de encolar) sobre los mismos datos. Los dos tienen que decir lo mismo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTasksDb, insert, newId, rejects, update, type TasksDb } from './db.ts';
import { DomainError, assertLabelNames, labelClashMessage, labelNameClash, labelNameKey, type Operation } from '../../packages/domain-tasks/src/index.ts';

let db: TasksDb;
let A: { tab: string; families: Record<string, string> }, B: { tab: string; families: Record<string, string> };
const ZONA_A = newId(), ZONA_G = newId();
let position = 1024;

const label = (id: string, tab: string | null, family: string, name: string, parent: string | null = null): Operation =>
  insert('tasks.labels', id, { tab_id: tab, family_id: family, parent_id: parent, name, position: (position += 1024) });
const rev = async (id: string) => (await db.data())['tasks.labels'].find((l) => l.id === id)!.revision;

/** El hook y el dominio, con el mismo lote y los mismos datos de partida. `code` nulo: se acepta. */
async function both(operations: Operation[], code: string | null): Promise<any> {
  const data = await db.data();
  let domain: DomainError | null = null;
  try { assertLabelNames(data, operations); } catch (error) { domain = error as DomainError; }
  if (!code) {
    assert.equal(domain, null, `el dominio rechazó: ${domain?.message}`);
    await db.commit(operations);
    return null;
  }
  assert.equal(domain?.code, code, 'el dominio debía rechazar');
  const details = await rejects(db.commit(operations), code);
  assert.equal(details.conflictId, (domain!.details as any).conflictId, 'hook y dominio señalan la misma');
  return { details, message: domain!.message };
}

test.before(async () => {
  db = await createTasksDb();
  A = await db.area('Retiros');
  B = await db.area('Mejoras');
  // Una familia propia de A y la General equivalente (mismo nombre, sin clave de sistema).
  await db.commit([
    insert('tasks.families', ZONA_A, { tab_id: A.tab, name: 'Zona', color: '#7a6a55', position: 50_000 }),
    insert('tasks.families', ZONA_G, { tab_id: null, name: ' zona ', color: '#7a6a55', position: 50_000 }),
  ]);
});
test.after(async () => { await db?.close(); });

test('normalización: sin mayúsculas, espacios a los lados ni tildes; la ñ se queda', () => {
  assert.equal(labelNameKey('  Habitación  '), 'habitacion');
  assert.equal(labelNameKey('BAÑO'), 'baño');
  assert.notEqual(labelNameKey('Baño'), labelNameKey('Bano'));
});

const ALBERGUE = newId(), SALAS = newId(), BANO = newId(), BANO_SALAS = newId(), DUCHA = newId(), DUCHA_SALAS = newId();

test('madre repetida, rechazada', async () => {
  await both([label(ALBERGUE, A.tab, A.families.space!, 'Albergue'), label(SALAS, A.tab, A.families.space!, 'Salas')], null);
  const out = await both([label(newId(), A.tab, A.families.space!, ' albergue ')], 'DUPLICATE_LABEL');
  assert.equal(out.details.conflictId, ALBERGUE);
  assert.equal(out.message, `Ya hay una «Albergue» en «${out.details.familyName.trim()}».`);
});

test('hija repetida bajo la misma madre, rechazada; con mayúsculas o tildes distintas, también', async () => {
  await both([label(BANO, A.tab, A.families.space!, 'Baño', ALBERGUE)], null);
  const out = await both([label(newId(), A.tab, A.families.space!, 'BAÑO', ALBERGUE)], 'DUPLICATE_LABEL');
  assert.equal(out.message, 'Ya hay una «Baño» en «Albergue».');
  assert.deepEqual([out.details.where, out.details.parentName], ['Albergue', 'Albergue']);
  await both([label(newId(), A.tab, A.families.space!, 'Habitación', ALBERGUE)], null);
  await both([label(newId(), A.tab, A.families.space!, 'habitacion ', ALBERGUE)], 'DUPLICATE_LABEL');
});

test('la misma hija bajo madres distintas, aceptada; y una madre puede llamarse como una hija', async () => {
  await both([label(BANO_SALAS, A.tab, A.families.space!, 'Baño', SALAS)], null);
  await both([label(newId(), A.tab, A.families.space!, 'Baño')], null);
});

test('dos hijas iguales en el mismo lote, rechazadas', async () => {
  await both([label(newId(), A.tab, A.families.space!, 'Cocina', SALAS), label(newId(), A.tab, A.families.space!, 'cocina', SALAS)], 'DUPLICATE_LABEL');
});

test('áreas distintas no se ven juntas: la misma etiqueta en dos áreas, aceptada', async () => {
  await both([label(newId(), B.tab, B.families.space!, 'Albergue')], null);
});

const PATIO_G = newId(), HUERTO_B = newId();
test('General frente a la de un área en la misma familia, rechazada (en los dos sentidos)', async () => {
  await both([label(PATIO_G, null, ZONA_G, 'Patio')], null);
  // Una del área en su familia propia equivalente («Zona» y « zona »), y una del área en la familia General.
  await both([label(newId(), A.tab, ZONA_A, 'patio')], 'DUPLICATE_LABEL');
  const out = await both([label(newId(), B.tab, ZONA_G, 'Pátio')], 'DUPLICATE_LABEL');
  assert.equal(out.message, 'Ya hay una «Patio» en «zona» (General).');
  // Crear una General que ya está en un área.
  await both([label(HUERTO_B, B.tab, ZONA_G, 'Huerto')], null);
  const general = await both([label(newId(), null, ZONA_G, 'huerto')], 'DUPLICATE_LABEL');
  assert.match(general.message, /\(de Mejoras\)\.$/);
});

const DEPOSITO = newId(), DEPOSITO_2 = newId();
test('una archivada no bloquea; desarchivarla con choque, rechazado', async () => {
  await both([label(DEPOSITO, A.tab, A.families.space!, 'Depósito')], null);
  await both([update('tasks.labels', DEPOSITO, await rev(DEPOSITO), { archived: true })], null);
  await both([label(DEPOSITO_2, A.tab, A.families.space!, 'Deposito')], null);
  await both([update('tasks.labels', DEPOSITO, await rev(DEPOSITO), { archived: false })], 'DUPLICATE_LABEL');
  // Renombrada antes, sí se puede desarchivar.
  await both([update('tasks.labels', DEPOSITO, await rev(DEPOSITO), { archived: false, name: 'Depósito viejo' })], null);
});

test('mover de madre a una donde choca, rechazado; mover de familia, también', async () => {
  await both([label(DUCHA, A.tab, A.families.space!, 'Ducha', ALBERGUE), label(DUCHA_SALAS, A.tab, A.families.space!, 'Ducha', SALAS)], null);
  await both([update('tasks.labels', DUCHA, await rev(DUCHA), { parent_id: SALAS })], 'DUPLICATE_LABEL');
  // A la raíz del todo: ya hay un «Baño» raíz, así que el de Albergue no puede subir.
  await both([update('tasks.labels', BANO, await rev(BANO), { parent_id: null })], 'DUPLICATE_LABEL');
  // De familia: «Patio» de la General ya está; una raíz de A en su «Zona» propia choca al llegar.
  const suelto = newId();
  await both([label(suelto, A.tab, A.families.phase!, 'Patio')], null);
  await both([update('tasks.labels', suelto, await rev(suelto), { family_id: ZONA_A })], 'DUPLICATE_LABEL');
});

test('renombrar a un nombre que choca, rechazado; a otro libre, aceptado', async () => {
  await both([update('tasks.labels', DUCHA, await rev(DUCHA), { name: 'baño' })], 'DUPLICATE_LABEL');
  await both([update('tasks.labels', DUCHA, await rev(DUCHA), { name: 'Ducha grande' })], null);
});

test('datos viejos ya repetidos: no rompen otros cambios, ni un renombrado que deja igual el nombre normalizado', async () => {
  // Como en producción: dos «Mesa» raíz en la misma familia, de antes de la regla (sin pasar por el hook).
  const m1 = newId(), m2 = newId();
  await db.t.db.query(`insert into tasks.labels (id, tab_id, family_id, name, position) values ($1, $3, $4, 'Mesa', 1), ($2, $3, $4, 'mesa', 2)`, [m1, m2, A.tab, A.families.space]);
  await both([update('tasks.labels', m1, await rev(m1), { position: 99 })], null);
  await both([update('tasks.labels', m2, await rev(m2), { name: 'Mésa ' })], null);
  await both([label(newId(), A.tab, A.families.space!, 'Silla')], null);
  // Una tercera, en cambio, empeora el choque.
  await both([label(newId(), A.tab, A.families.space!, 'MESA')], 'DUPLICATE_LABEL');
  // Y una de las viejas, archivada y desarchivada, vuelve a entrar en el choque.
  await both([update('tasks.labels', m2, await rev(m2), { archived: true })], null);
  await both([update('tasks.labels', m2, await rev(m2), { archived: false })], 'DUPLICATE_LABEL');
});

test('renombrar una familia para que coincida con otra junta sus etiquetas: si chocan, rechazado', async () => {
  const fam = newId(), id = newId();
  await both([insert('tasks.families', fam, { tab_id: A.tab, name: 'Lugares', color: '#123456', position: 60_000 }), label(id, A.tab, fam, 'Patio')], null);
  const revision = (await db.data())['tasks.families'].find((f) => f.id === fam)!.revision;
  await both([update('tasks.families', fam, revision, { name: 'ZONA' })], 'DUPLICATE_LABEL');
});

test('aviso del editor (labelNameClash): la misma regla, sin lote', async () => {
  const data = await db.data();
  const clash = labelNameClash(data, { tab_id: A.tab, family_id: A.families.space!, parent_id: ALBERGUE, name: ' baño' });
  assert.equal(clash?.clash.id, BANO);
  assert.equal(labelClashMessage(clash!), 'Ya hay una «Baño» en «Albergue».');
  assert.equal(labelNameClash(data, { id: BANO, tab_id: A.tab, family_id: A.families.space!, parent_id: ALBERGUE, name: 'Baño' }), null, 'consigo misma no choca');
  assert.equal(labelNameClash(data, { tab_id: A.tab, family_id: A.families.space!, parent_id: SALAS, name: 'Lavabo' }), null);
});
