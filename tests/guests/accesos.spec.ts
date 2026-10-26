/**
 * Acceso que no caduca, «Mis retiros», dirección y fichas de equipo (API.md §9.17; encargo de VG del 26-10-2026), contra la
 * API real sobre PGlite con las migraciones de Booking 0481 y 0483:
 * - **«Mis retiros»**: pasados y próximos con el estado de la reserva; un retiro pasado sigue abriéndose;
 * - **ficha de equipo** (`portal_role`): la etiqueta, sin datos de registro ni firma (G-B2) y, en el Menú, que su ficha no
 *   llega a cocina (G-B1);
 * - **dirección** (`{all: true}`): «Todos los retiros», un retiro sin ficha con su programa y «Apuntarme» sin aprobación.
 */
import { expect, test } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../packages/test-kit/src/net.ts';
import { startGuestsServer, type GuestsTestServer } from './server.ts';
import { buildGuestsApp } from './build.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/guests/vite.config.ts');

let api: GuestsTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  api = await startGuestsServer();
  process.env.VITE_API_PROXY = api.url;
  await buildGuestsApp(); // un solo build entre workers (tests/guests/build.ts)
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

/** Día en Madrid desplazado `offset` días (AAAA-MM-DD). */
const day = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));

test('§9.17 a · «Mis retiros» enseña los pasados y los próximos con su estado, y un retiro pasado sigue abriéndose', async ({ page }) => {
  const pasado = await api.reservation({ title: 'Retiro de primavera', start: day(-40), end: day(-37) });
  const proximo = await api.reservation({ title: 'Retiro de otoño', start: day(20), end: day(22) });
  const a = await api.guest(pasado.event, { first_name: 'Iria', last_name_1: 'Vidal' });
  const b = await api.guest(proximo.event, { first_name: 'Iria', last_name_1: 'Vidal' });
  await api.guestLink(pasado.id, a, 'Iria', 'iria@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(proximo.id, b, 'Iria', 'iria@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de otoño');

  await page.goto(`${baseURL}/#/retiros`);
  await expect(page.locator('#mine-before')).toContainText('Retiro de otoño');
  await expect(page.locator('#mine-before .gstatus')).toHaveText('Confirmado');
  await expect(page.locator('#mine-after')).toContainText('Retiro de primavera');
  await expect(page.locator('#noAccess')).toHaveCount(0);
  await expect(page.locator('#retreatsAll')).toBeEmpty(); // sin dirección, no hay «Todos los retiros»

  // El pasado se abre como siempre (nada se borra al terminar).
  await page.locator('#mine-after a.gretreat').click();
  await expect(page).toHaveURL(new RegExp(`#/p/${a}$`));
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de primavera');
});

test('§9.17 d · ficha de equipo: «Equipo» en el retiro, sin datos de registro ni firma, y en el Menú que su ficha no llega a cocina', async ({ page }) => {
  const r = await api.reservation({ title: 'Retiro con equipo', start: day(12), end: day(14) });
  const nora = await api.guest(r.event, { first_name: 'Nora', last_name_1: 'Pinto', portal_role: 'staff' });
  await api.experience(r.id, { menu_visible: true });
  await api.restriction(r.event, nora, { type: 'alergia', subject: 'huevo', severity: 'grave' });
  await api.menu(r.event, [{ date: day(12), type: 'cena', time: '21:00', dishes: [{ name: 'Tortilla', allergens: ['huevos'], allergensChecked: true }] }]);
  await page.goto(`${baseURL}/i/${await api.guestLink(r.id, nora, 'Nora', 'nora@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#teamRole')).toHaveText('Equipo');

  // G-B2: el enlace directo a sus datos vuelve al Resumen.
  await page.goto(`${baseURL}/#/p/${nora}/datos`);
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro con equipo');

  // G-B1: nunca «Cocina tiene registrado…»; el cruce plato a plato sigue avisándole.
  await page.locator('#sections a[data-section="menu"]').click();
  await expect(page.locator('#menuKitchen')).toHaveText(/Tu ficha de equipo no llega a cocina: si comes aquí, avisa tú en cocina\./);
  await expect(page.locator('#menuKitchen')).not.toContainText('Cocina tiene registrado');
  await expect(page.locator('#menuList .gdish', { hasText: 'Tortilla' }).locator('.gcross')).toContainText('huevo');
});

test('§9.17 c · dirección: «Todos los retiros», un retiro sin ficha con su programa y «Apuntarme» sin aprobación', async ({ page }) => {
  const propio = await api.reservation({ title: 'Retiro de la casa', start: day(5), end: day(6) });
  const ajeno = await api.reservation({ title: 'Retiro de invierno', start: day(50), end: day(52) });
  await api.organizerInvoke(ajeno.id, 'booking.portal_program_save', {
    item: { id: crypto.randomUUID(), day: day(50), starts_at: '10:00', ends_at: '11:30', title: 'Paseo por el pinar', place_text: 'Pinar', kind: 'actividad', audience: 'todos', audience_guest_ids: [] } });
  const yo = await api.guest(propio.event, { first_name: 'Marga', last_name_1: 'Ruiz' });
  const token = await api.guestLink(propio.id, yo, 'Marga', 'marga@example.invalid');
  const account = await api.accountOf(yo);
  // «Todos» en sus grants de Guests (lo concede el núcleo por el nivel de casa).
  await api.booking.t.db.query(
    `update core.memberships set scopes = jsonb_set(scopes, '{grants}', coalesce(scopes->'grants', '[]'::jsonb) || '[{"all": true}]'::jsonb) where app = 'guests' and user_id = $1`, [account]);
  await page.goto(`${baseURL}/i/${token}`);
  await page.locator('#privacyOk').click();

  await page.goto(`${baseURL}/#/retiros`);
  const all = page.locator('#retreatsAll');
  await expect(all).toContainText('Todos los retiros');
  await expect(all).toContainText('Retiro de invierno');
  await page.locator('#retreatsSearch').fill('invierno');
  await expect(all.locator('a.gretreat')).toHaveCount(1);

  // Sin ficha: su programa y la franja de dirección.
  await all.locator('a.gretreat', { hasText: 'Retiro de invierno' }).click();
  await expect(page).toHaveURL(new RegExp(`#/r/${ajeno.id}$`));
  await expect(page.locator('#directionBand')).toHaveText('Lo ves como dirección. Aún no te has apuntado.');
  await expect(page.locator('#directionProgram')).toContainText('Paseo por el pinar');

  // «Apuntarme»: sin aprobación, y se abre su ficha con la etiqueta «Dirección».
  await page.locator('#directionJoin').click();
  await page.locator('#dialogConfirm').click();
  await expect(page).toHaveURL(/#\/p\/[0-9a-f-]{36}$/);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de invierno');
  await expect(page.locator('#teamRole')).toHaveText('Dirección');
});
