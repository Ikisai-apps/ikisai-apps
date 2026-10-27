/**
 * «Tus ofertas de hoy» en el Menú (API.md §9.18), contra la API real sobre PGlite con `food.portal_offers` (Food 1111) y el
 * grupo de comida de la ficha (Booking 0485):
 * - un huésped ve lo incluido de todos y la carta «de pago» con su precio, con el cruce de su alergia; nunca lo de otro
 *   grupo ni lo interno;
 * - una ficha de equipo de su grupo ve también su menú y lo interno, con «Solo equipo».
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

test('§9.18 · «Tus ofertas de hoy»: lo incluido y la carta de pago para el huésped; su grupo y lo interno solo para el equipo', async ({ page }) => {
  const r = await api.reservation({ title: 'Retiro con barra', start: day(0), end: day(1) });
  await api.experience(r.id, { menu_visible: true });
  const menuId = await api.menu(r.event, [{ date: day(0), type: 'cena', time: '21:00', dishes: [
    { name: 'Crema de calabaza', allergensChecked: true },
    { name: 'Tarta de nueces', allergens: ['frutos_de_cascara'], allergensChecked: true },
  ] }]);
  await api.offer(r.event, menuId, { name: 'Menú del retiro', payer: 'organizador', place: 'Comedor' });
  await api.offer(r.event, menuId, { name: 'Menú vegano', meal_groups: ['veganos'], payer: 'organizador' });
  await api.offer(r.event, menuId, { name: 'Comida del equipo', audience: 'interna' });
  const barra = await api.carta(r.event, 'Barra', [{ code: 'A', name: 'Vino tinto', price: 350, allergens: ['sulfitos'] }]);
  await api.offer(r.event, barra, { name: 'Barra', payer: 'huesped', charge_when: 'barra', place: 'Porche' });

  // Un huésped sin grupo, con alergia grave a las nueces.
  const ana = await api.guest(r.event, { first_name: 'Ana', last_name_1: 'Mora' });
  await api.restriction(r.event, ana, { type: 'alergia', subject: 'nueces', severity: 'grave' });
  await page.goto(`${baseURL}/i/${await api.guestLink(r.id, ana, 'Ana', 'ana@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await page.locator('#sections a[data-section="menu"]').click();
  const offers = page.locator('#menuOffers');
  await expect(offers.locator('#menuOffersTitle')).toHaveText('Tus ofertas de hoy');
  await expect(offers.locator('.goffer', { hasText: 'Menú del retiro' })).toContainText('Incluido');
  await expect(offers.locator('.goffer', { hasText: 'Menú del retiro' }).locator('.gcross.warn')).toHaveCount(1); // la tarta, por su alergia
  await expect(offers).not.toContainText('Menú vegano');
  await expect(offers).not.toContainText('Comida del equipo');
  const carta = offers.locator('.goffer-carta', { hasText: 'Barra' });
  await expect(carta.locator('.goffer-mode')).toHaveText('De pago');
  await expect(carta.locator('.goffer-price')).toHaveText('3,50 €');
  await expect(carta).toContainText('En Porche');

  // Una ficha de equipo del grupo «veganos»: su menú y lo interno, con «Solo equipo».
  const nico = await api.guest(r.event, { first_name: 'Nico', last_name_1: 'Sanz', portal_role: 'staff', meal_group: 'veganos' });
  await page.goto(`${baseURL}/i/${await api.guestLink(r.id, nico, 'Nico', 'nico@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await page.locator('#sections a[data-section="menu"]').click();
  await expect(offers).toContainText('Menú vegano');
  await expect(offers.locator('.goffer', { hasText: 'Comida del equipo' })).toContainText('Solo equipo');
});
