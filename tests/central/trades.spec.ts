/**
 * Central · fase P1: oficios en árbol y capacidades con la estrella de nivel del kit. Crear el árbol, añadir capacidades
 * en la ficha, cambiar el nivel pulsando la estrella, filtrar Personas por un oficio con lo que cuelga de él, ver las chips y
 * «Quién sabe hacerlo» en cada oficio. Datos ficticios.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { buildCentralApp } from './e2e-build.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;
const ids = { ana: crypto.randomUUID(), bea: crypto.randomUUID() };

test.beforeAll(async () => {
  test.setTimeout(180_000);
  api = await startCentralServer();
  const seeded = await api.app.call('/api/v1/commands', { body: { requestId: 'trades-seed', operations: [
    { op: 'insert', table: 'central.people', id: ids.ana, fields: { display_name: 'Ana Ficticia', relation: 'equipo', base_role: 'mantenimiento_logistica', house_level: 'staff', position: 1 } },
    { op: 'insert', table: 'central.people', id: ids.bea, fields: { display_name: 'Bea Ficticia', relation: 'equipo', base_role: 'limpieza', house_level: 'staff', position: 2 } },
  ] } });
  if (seeded.status !== 200) throw new Error(JSON.stringify(seeded.data));
  process.env.VITE_API_PROXY = api.url;
  await buildCentralApp();
  server = await preview({
    configFile,
    logLevel: 'silent',
    preview: { port: await freePort(), strictPort: true, host: '127.0.0.1', proxy: { '/api': { target: api.url, changeOrigin: true } } },
  });
  baseURL = server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${server.config.preview.port}`;
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  await api?.close();
});

async function login(page: Page): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill('owner@example.invalid');
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: 'Hola, Owner' })).toBeVisible();
}
const level = async (person: string) => (await api.app.t.db.query<{ l: number }>(`select level as l from central.person_trades where person_id = $1 and deleted_at is null`, [person])).rows[0]?.l;

async function newTrade(page: Page, name: string, parent?: string): Promise<void> {
  if (parent) {
    await page.locator('.traderow', { hasText: parent }).first().click();
    await page.locator('#addSubtrade').click();
  } else await page.locator('#newTrade').click();
  await page.locator('#tr-name').fill(name);
  await page.locator('#saveTrade').click();
  await expect(page.locator('.traderow', { hasText: name })).toBeVisible();
}

test('oficios · árbol, capacidades con estrella, filtro con descendientes, chips, «Quién sabe hacerlo» y herencia del padre', async ({ page }) => {
  await login(page);
  await page.goto(`${baseURL}/#/personas`);
  await page.locator('#manageTrades').click();
  await expect(page.getByText('Todavía no hay oficios')).toBeVisible();
  await newTrade(page, 'Fontanería');
  await newTrade(page, 'ACS', 'Fontanería');
  await newTrade(page, 'Electricidad');

  // Ficha de Ana: añadir «Fontanería › ACS» y subirle el nivel a experto con la estrella.
  await page.goto(`${baseURL}/#/personas/${ids.ana}`);
  await expect(page.locator('#blockTrades')).toContainText('Sin oficios.');
  await page.locator('#addTrade').click();
  await page.locator('#pt-trade').selectOption({ label: '· ACS' });
  await page.locator('.sheet .level-star').click(); // Sabe → Experto
  await page.locator('#pt-note').fill('Calentadores');
  await page.locator('#savePersonTrade').click();
  await expect(page.locator('#personTrades')).toContainText('Fontanería › ACS');
  await expect(page.locator('#personTrades')).toContainText('Experto');
  await expect.poll(() => level(ids.ana)).toBe(2);
  // Pulsar la estrella de la fila cambia el nivel (vuelve a «Aprende»).
  await page.locator('#personTrades .level-star').first().click();
  await expect.poll(() => level(ids.ana)).toBe(0);

  // Bea sabe electricidad (nivel por defecto: «Sabe»).
  await page.goto(`${baseURL}/#/personas/${ids.bea}`);
  await page.locator('#addTrade').click();
  await page.locator('#pt-trade').selectOption({ label: 'Electricidad' });
  await page.locator('#savePersonTrade').click();
  await expect(page.locator('#personTrades')).toContainText('Sabe');

  // Personas: filtrar por «Fontanería» incluye a quien sabe «ACS»; chips del oficio en la fila.
  await page.goto(`${baseURL}/#/personas`);
  await expect(page.locator('.personrow', { hasText: 'Ana Ficticia' })).toContainText('ACS');
  await page.locator('#peopleTrade').selectOption({ label: 'Fontanería' });
  await expect(page.locator('.personrow')).toHaveCount(1);
  await expect(page.locator('.personrow', { hasText: 'Ana Ficticia' })).toBeVisible();
  await page.locator('#peopleTrade').selectOption('');
  await expect(page.locator('.personrow')).toHaveCount(2);

  // Oficios: «Quién sabe hacerlo» con su nivel; archivar saca el oficio de la lista.
  await page.goto(`${baseURL}/#/personas/oficios`);
  // Caracterización (R7): «N personas» cuenta solo las del propio oficio, no lo que cuelga de él.
  await expect(page.locator('.traderow', { hasText: 'Fontanería' }).locator('.accountmeta')).toHaveText('0 personas');
  await expect(page.locator('.traderow', { hasText: 'ACS' }).locator('.accountmeta')).toHaveText('1 persona');
  await expect(page.locator('.traderow', { hasText: 'Electricidad' }).locator('.accountmeta')).toHaveText('1 persona');
  // R7 · cobertura con el grado efectivo (1510): lo del hijo no sube al padre. Ana aprende ACS, no Fontanería.
  const row = (name: string) => page.locator('.traderow', { has: page.locator('.accountname', { hasText: new RegExp(`^${name}$`) }) });
  await expect(row('Fontanería').locator('.tradecoverage')).toHaveCount(0);
  await expect(row('Fontanería').locator('.tradeflags')).toHaveText('En riesgo');
  await expect(row('ACS').locator('.tradecoverage')).toHaveText('1 aprende');
  await expect(row('ACS').locator('.tradeflags')).toHaveText(/En riesgo\s*Sin experto/);
  await expect(row('Electricidad').locator('.tradecoverage')).toHaveText('1 sabe');
  await expect(row('Electricidad').locator('.tradeflags')).toHaveText('En riesgo');
  // «Solo en riesgo»: cada fila suelta, con su ruta.
  await page.locator('#tradesRisk').check();
  await expect(page.locator('.traderow')).toHaveCount(3);
  await expect(page.locator('.traderow .accountname', { hasText: 'Fontanería › ACS' })).toBeVisible();
  await page.locator('#tradesRisk').uncheck();
  await expect(row('ACS')).toBeVisible();
  // Desde el panel se llega con el filtro puesto.
  await page.goto(`${baseURL}/#/personas/oficios?riesgo`);
  await expect(page.locator('#tradesRisk')).toBeChecked();
  await expect(page.locator('.traderow .accountname', { hasText: 'Fontanería › ACS' })).toBeVisible();
  await page.goto(`${baseURL}/#/personas/oficios`);
  await page.locator('.traderow', { hasText: 'ACS' }).click();
  await expect(page.locator('#tradePeople')).toContainText('Ana Ficticia');
  await expect(page.locator('#tradePeople')).toContainText('Aprende');
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  await page.locator('.traderow', { hasText: 'Electricidad' }).click();
  await page.locator('#archiveTrade').click();
  await expect(page.getByText('Oficio archivado.')).toBeVisible();
  await expect(page.locator('.traderow', { hasText: 'Electricidad' })).toHaveCount(0);
  await page.locator('#tradesArchived').check();
  await expect(page.locator('.traderow', { hasText: 'Electricidad' })).toContainText('Archivado');
  await page.locator('#tradesArchived').uncheck();

  // 1510 · lo del padre baja a los hijos: Bea sabe Fontanería, así que sabe ACS.
  await page.goto(`${baseURL}/#/personas/${ids.bea}`);
  await page.locator('#addTrade').click();
  await page.locator('#pt-trade').selectOption({ label: 'Fontanería' });
  await page.locator('#savePersonTrade').click();
  await expect(page.locator('#personTrades')).toContainText('Fontanería');
  // En su ficha basta con el padre: ACS no se pinta.
  await expect(page.locator('#personTrades .caprow', { hasText: 'ACS' })).toHaveCount(0);
  await page.goto(`${baseURL}/#/personas/oficios`);
  await expect(row('Fontanería').locator('.tradecoverage')).toHaveText('1 sabe');
  await expect(row('ACS').locator('.tradecoverage')).toHaveText('1 aprende · 1 sabe');
  await expect(row('ACS').locator('.accountmeta')).toHaveText('2 personas');
  await expect(row('Fontanería').locator('.accountmeta')).toHaveText('1 persona');
  await row('ACS').click();
  await expect(page.locator('#tradePeople [data-person="' + ids.bea + '"]')).toContainText('Sabe · por Fontanería');
  await expect(page.locator('#tradePeople [data-person="' + ids.ana + '"]')).not.toContainText('por ');
  await page.getByRole('button', { name: 'Cerrar', exact: true }).click();
  // Filtrar Personas por ACS enseña también a quien lo sabe por Fontanería; por Fontanería, a quien sabe ACS (como antes).
  await page.goto(`${baseURL}/#/personas`);
  await page.locator('#peopleTrade').selectOption({ label: '· ACS' });
  await expect(page.locator('.personrow')).toHaveCount(2);
  await page.locator('#peopleTrade').selectOption({ label: 'Fontanería' });
  await expect(page.locator('.personrow')).toHaveCount(2);
  await page.locator('#peopleTrade').selectOption('');

  // En el hijo no se puede tener menos que en el padre: el aviso lo dice y la estrella no baja de «Sabe».
  await page.goto(`${baseURL}/#/personas/${ids.bea}`);
  await page.locator('#addTrade').click();
  await page.locator('#pt-trade').selectOption({ label: '· ACS' });
  await expect(page.locator('#pt-min')).toHaveText('Por «Fontanería» ya tiene Sabe: aquí, como mínimo, Sabe.');
  const star = page.locator('.sheet .level-star');
  await expect(star).toHaveAttribute('data-level', '1');
  await star.click(); // Sabe → Experto
  await expect(star).toHaveAttribute('data-level', '2');
  await star.click(); // Experto → Aprende, que no se puede: se queda en Sabe
  await expect(star).toHaveAttribute('data-level', '1');
  await page.locator('#savePersonTrade').click();
  const bea = async (trade: string) => (await api.app.t.db.query<{ l: number }>(`select x.level as l from central.person_trades x join central.trades t on t.id = x.trade_id
    where x.person_id = $1 and t.name = $2 and x.deleted_at is null`, [ids.bea, trade])).rows[0]?.l;
  await expect.poll(() => bea('ACS')).toBe(1);
  // En la fila, la estrella tampoco baja del mínimo.
  const acs = page.locator('#personTrades .caprow', { hasText: 'Fontanería › ACS' });
  await acs.locator('.level-star').click(); // Sabe → Experto
  await expect.poll(() => bea('ACS')).toBe(2);
  await acs.locator('.level-star').click(); // Experto → Aprende: se guarda Sabe
  await expect.poll(() => bea('ACS')).toBe(1);
  await expect(page.getByText('Nivel: Sabe. Por «Fontanería» ya tiene Sabe: aquí, como mínimo, Sabe.')).toBeVisible();
});

test('oficios · importar de Tasks con vista previa: repetidas juntas, archivadas sin marcar, sin duplicar al repetir', async ({ page }) => {
  const db = api.app.t.db;
  const [tabA, tabB, famA, famB, fA, fB, viejo] = Array.from({ length: 7 }, () => crypto.randomUUID());
  await db.query(`insert into tasks.tabs (id, name) values ($1, 'Área A'), ($2, 'Área B')`, [tabA, tabB]);
  await db.query(`insert into tasks.families (id, tab_id, name, color) values ($1, $2, 'Tipo: Acción', '#336699'), ($3, $4, 'Tipo: accion', '#336699')`, [famA, tabA, famB, tabB]);
  await db.query(`insert into tasks.labels (id, tab_id, family_id, parent_id, name, archived) values
    ($1, $2, $3, null, 'Carpintería', false), ($4, $2, $3, $1, 'Puertas', false), ($5, $6, $7, null, 'carpinteria', false), ($8, $2, $3, null, 'Oficio viejo', true)`,
    [fA, tabA, famA, crypto.randomUUID(), fB, tabB, famB, viejo]);

  await login(page);
  await page.goto(`${baseURL}/#/personas/oficios`);
  await page.locator('#importTrades').click();
  const preview = page.locator('#importPreview');
  await expect(preview).toContainText('Carpintería');
  await expect(preview.locator('.importrow', { hasText: 'Carpintería' })).toContainText('En 2 áreas');
  await expect(page.locator(`#imp-${viejo}`)).not.toBeChecked(); // archivada en Tasks: sin marcar
  await page.locator('#applyImport').click();
  await expect(page.getByText('2 oficios importados.')).toBeVisible();
  await expect(page.locator('.traderow', { hasText: 'Puertas' })).toBeVisible();
  const imported = (await db.query<{ p: string }>(`select central.trade_path(id) as p from central.trades where deleted_at is null and source_label_id is not null order by 1`)).rows.map((r) => r.p);
  expect(imported).toEqual(['Carpintería', 'Carpintería › Puertas']);

  // Repetir no duplica: todo sale como «Ya existe».
  await page.locator('#importTrades').click();
  await expect(page.locator('#importPreview .importrow', { hasText: 'Puertas' })).toContainText('Ya existe');
  await page.locator('#applyImport').click();
  await expect(page.getByText('No hay nada marcado para importar.')).toBeVisible();
});
