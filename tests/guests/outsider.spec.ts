/**
 * Guests · O4b, primera parte (RECURSOS.md §17; Booking §26, Food §2.6, contrato §3.10), contra las API reales sobre PGlite:
 * - **pestaña Outsider** solo con nivel de casa `outsider`, entre los retiros pasados y los demás; sin retiros, se entra en ella;
 * - **estancias** creadas eligiendo días en el calendario, con la cama habitual, cambio de fechas y quitar;
 * - **«hay alguien del staff»** y **notas con hora** (las del equipo y las propias);
 * - **«Sugerir un plato»** para el menú de casa: una sugerencia `plato_casa` de Food que sale en «Mis propuestas»;
 * - **la familia**: estancia para todos por defecto (con la clave de persona de sus fichas) y «Separar»;
 * - **retiros abiertos** para cualquier huésped, con su resumen y sin precio.
 */
import { expect, test, type Page } from 'playwright/test';
import { preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { freePort } from '../../packages/test-kit/src/net.ts';
import { startGuestsServer, type GuestsTestServer } from './server.ts';
import { buildGuestsApp } from './build.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/guests/vite.config.ts');
const CAPTURAS = process.env.GUESTS_CAPTURAS ?? '';
const PREFIJO = process.env.GUESTS_CAPTURAS_PREFIJO ?? 'despues';

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
  if (CAPTURAS) mkdirSync(CAPTURAS, { recursive: true });
});

test.afterAll(async () => {
  await new Promise<void>((resolve) => server?.httpServer.close(() => resolve()));
  await api?.close();
});

/** Día en Madrid desplazado `offset` días (AAAA-MM-DD). */
const day = (offset: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(Date.now() + offset * 86_400_000));
/** Día `n` del mes que viene (AAAA-MM-DD). */
function nextMonthDay(n: number): string {
  const [y, m] = day(0).split('-').map(Number) as [number, number];
  const next = m === 12 ? [y + 1, 1] : [y, m + 1];
  return `${next[0]}-${String(next[1]).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
}
const navMain = (page: Page) => page.locator('nav.nav > a.navbtn:not(.navextra)');
const bar = (page: Page, label: string) => navMain(page).filter({ hasText: label });
const cell = (page: Page, d: string) => page.locator(`#calendar .cal-day:not(.outside)[data-day="${d}"]`);

async function capture(page: Page, name: string): Promise<void> {
  if (CAPTURAS) await page.screenshot({ path: path.join(CAPTURAS, `${PREFIJO}-${name}.png`), fullPage: true });
}

test('O4b · un huésped sin nivel outsider no ve la pestaña Outsider ni las estancias', async ({ page }) => {
  const a = await api.reservation({ title: 'Retiro A', start: day(10), end: day(12) });
  const b = await api.reservation({ title: 'Retiro B', start: day(40), end: day(42) });
  const ga = await api.guest(a.event, { first_name: 'Sol' });
  const gb = await api.guest(b.event, { first_name: 'Sol' });
  await api.guestLink(b.id, gb, 'Sol', 'sol@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(a.id, ga, 'Sol', 'sol@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTabs a')).toHaveCount(2);
  await expect(page.locator('#outsiderTab')).toHaveCount(0);
  await bar(page, 'Calendario').click();
  await expect(page.locator('#calendarNewStay')).toHaveCount(0);
  await expect(page.locator('#calendar .cal-legend')).not.toContainText('Mis estancias');
});

test('O4b · outsider y huésped: pestaña Outsider entre retiros, estancia con su cama habitual, cambiar fechas y quitar', async ({ page }) => {
  const pasado = await api.reservation({ title: 'Retiro de verano', start: day(-60), end: day(-58) });
  const proximo = await api.reservation({ title: 'Retiro de invierno', start: day(50), end: day(52) });
  const g1 = await api.guest(pasado.event, { first_name: 'Teo' });
  const g2 = await api.guest(proximo.event, { first_name: 'Teo' });
  await api.guestLink(pasado.id, g1, 'Teo', 'teo@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(proximo.id, g2, 'Teo', 'teo@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de invierno');
  // Central lo convierte en outsider; su cama habitual la pone el personal.
  const account = await api.makeOutsider(g2);
  const room = await api.room(pasado.event, { name: 'Habitación del jardín', enSuite: true, beds: ['Cama 1'] });
  await api.outsiderBed(account, room.bedIds[0]!);
  await page.reload();
  // El enlace manda mientras la app sigue abierta; al recargar, la pestaña del próximo retiro, con la Outsider delante.
  await expect(page.locator('#retreatTabs a')).toHaveText([/Retiro de verano/, /Outsider/, /Retiro de invierno/]);
  await page.locator('#outsiderTab').click();
  await expect(page).toHaveURL(/#\/outsider$/);
  await expect(page.locator('#outsiderTitle')).toBeVisible();
  await expect(bar(page, 'Retiros')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#outsiderNoStay')).toBeVisible();
  await expect(page.locator('#outsiderDefaultBed')).toContainText('Habitación del jardín · Cama 1');

  // Nueva estancia: el calendario en «elegir días»; llegada el 10 y salida el 12 del mes que viene (2 noches).
  await page.locator('#newStay').click();
  await expect(page).toHaveURL(/#\/calendario\/nueva$/);
  await expect(page.locator('.cal-selectbar')).toBeVisible();
  await page.locator('#calendar button[aria-label="Siguiente"]').click();
  await cell(page, nextMonthDay(10)).click();
  await cell(page, nextMonthDay(12)).click();
  await expect(page.locator('.cal-selectbar')).toContainText('2 noches');
  await page.locator('.cal-selectbar button', { hasText: 'Guardar estancia' }).click();
  await expect(page.getByText('Estancia guardada.')).toBeVisible();
  await expect(page.locator('#calendar .cal-event[data-layer="stay"]').first()).toBeVisible();
  const stays = async () => (await api.booking.t.db.query<{ from_date: string; to_date: string; bed_id: string; source: string }>(
    `select from_date::text, to_date::text, bed_id, source from booking.stays where account_id = $1 and deleted_at is null`, [account])).rows;
  expect(await stays()).toEqual([{ from_date: nextMonthDay(10), to_date: nextMonthDay(12), bed_id: room.bedIds[0], source: 'guest' }]);

  // Cambiar fechas desde el panel del día: del 11 al 14.
  await cell(page, nextMonthDay(10)).click();
  await page.locator('#dayActions button', { hasText: 'Cambiar fechas' }).click();
  await cell(page, nextMonthDay(11)).click();
  await cell(page, nextMonthDay(14)).click();
  await page.locator('.cal-selectbar button', { hasText: 'Guardar estancia' }).click();
  await expect(page.getByText('Fechas cambiadas.')).toBeVisible();
  await expect.poll(async () => (await stays()).map((s) => [s.from_date, s.to_date])).toEqual([[nextMonthDay(11), nextMonthDay(14)]]);
  await capture(page, 'outsider-calendario');

  // Quitar.
  await cell(page, nextMonthDay(12)).click();
  await page.locator('#dayActions button', { hasText: 'Quitar estancia' }).click();
  await page.getByRole('button', { name: 'Quitar estancia' }).last().click();
  await expect(page.getByText('Estancia quitada.')).toBeVisible();
  await expect.poll(async () => (await stays()).length).toBe(0);
});

test('O4b · outsider sin retiros: entra en la pestaña Outsider; «hay alguien», notas y «Sugerir un plato» en «Mis propuestas»', async ({ page }) => {
  const r = await api.reservation({ title: 'Retiro de paso', start: day(5), end: day(6) });
  const g = await api.guest(r.event, { first_name: 'Nora' });
  await page.goto(`${baseURL}/i/${await api.guestLink(r.id, g, 'Nora', 'nora@example.invalid')}`);
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toHaveText('Retiro de paso');
  // Outsider sin entradas de huésped (p. ej., una voluntaria que nunca vino a un retiro).
  const account = await api.makeOutsider(g, { noRetreats: true });
  await api.staffStay(day(1), day(3));
  await api.staffNote(account, `${day(2)}T16:30:00Z`, 'Te dejamos las llaves en recepción');
  await page.goto(`${baseURL}/`);
  await expect(page).toHaveURL(/#\/outsider$/);
  await expect(page.locator('#retreatTabs')).toHaveCount(0); // sin retiros, sin pestañas
  await expect(navMain(page)).toHaveText(['Calendario', 'Retiros']);

  // «Sugerir un plato»: una sugerencia `plato_casa` de Food, pendiente, en «Mis propuestas».
  await page.locator('#dishName').fill('Lentejas de la abuela');
  await page.locator('#dishService').selectOption('cena');
  await page.locator('#dishSend').click();
  await expect(page.getByText('Sugerencia enviada. Cocina la revisará.')).toBeVisible();
  await expect(page.locator('#outsiderProposals')).toContainText('Lentejas de la abuela');
  const suggestions = (await api.booking.t.db.query<{ app: string; kind: string; status: string; operations: any }>(
    `select app, kind, status, operations from core.suggestions where author_id = $1`, [account])).rows;
  expect(suggestions).toHaveLength(1);
  expect(suggestions[0]).toMatchObject({ app: 'food', kind: 'plato_casa', status: 'pending' });
  expect(suggestions[0]!.operations[0]).toMatchObject({ op: 'call', procedure: 'food.house_dish_from_suggestion', args: { name: 'Lentejas de la abuela', service: 'cena' } });
  await capture(page, 'outsider-pestana');

  // Calendario: «hay alguien» rayado, la nota del equipo con su hora de Madrid, y una nota propia que se añade y se borra.
  await bar(page, 'Calendario').click();
  await expect(page.locator('#calendar .cal-legend-shade')).toHaveText('Hay alguien del staff');
  await expect(cell(page, day(2))).toHaveClass(/shaded/);
  await cell(page, day(2)).click();
  await expect(page.locator('.cal-agenda')).toContainText('Te dejamos las llaves en recepción');
  await expect(page.locator('.cal-agenda')).toContainText(/1[78]:30/); // 16:30 UTC = 18:30 en verano y 17:30 en invierno
  await page.locator('#addNote').click();
  await page.locator('#noteTime').fill('19:15');
  await page.locator('#noteText').fill('Llego en el tren de las 19:00');
  await page.locator('#noteSave').click();
  await expect(page.getByText('Nota guardada.')).toBeVisible();
  await expect(page.locator('#dayActions')).toContainText('19:15 · Llego en el tren de las 19:00');
  const notes = async () => (await api.booking.t.db.query<{ note: string; author_kind: string }>(`select note, author_kind from booking.stay_notes where account_id = $1 and deleted_at is null order by at`, [account])).rows;
  await expect.poll(notes).toEqual([{ note: 'Te dejamos las llaves en recepción', author_kind: 'staff' }, { note: 'Llego en el tren de las 19:00', author_kind: 'outsider' }]);
  await page.locator('#dayActions .gday-note button').click();
  await expect(page.getByText('Nota borrada.')).toBeVisible();
  await expect.poll(async () => (await notes()).length).toBe(1);
});

test('O4b · la familia: estancia para todos por defecto (con su clave de persona) y «Separar» a uno con otras fechas', async ({ page }) => {
  // Lejos del mes que viene, para que su barra no tape los días de la estancia.
  const r = await api.reservation({ title: 'Retiro con los niños', start: day(70), end: day(72) });
  const marta = await api.guest(r.event, { first_name: 'Marta', last_name_1: 'Gil' });
  const nico = await api.guest(r.event, { first_name: 'Nico', last_name_1: 'Gil' });
  await api.guestLink(r.id, nico, 'Nico', 'gil@example.invalid');
  await page.goto(`${baseURL}/i/${await api.guestLink(r.id, marta, 'Marta', 'gil@example.invalid')}`);
  await page.locator('#privacyOk').click();
  const account = await api.makeOutsider(marta);
  // El nivel de casa llega con el arranque: se vuelve a abrir la app.
  await page.goto(`${baseURL}/#/calendario`);
  await page.reload();
  await page.locator('#calendarNewStay').click();
  await page.locator('#calendar button[aria-label="Siguiente"]').click();
  await cell(page, nextMonthDay(5)).click();
  await cell(page, nextMonthDay(8)).click();
  await page.locator('.cal-selectbar button', { hasText: 'Guardar estancia' }).click();
  // Para todos por defecto, con una casilla por persona.
  await expect(page.locator('#whoList input:checked')).toHaveCount(2);
  await page.locator('#whoOk').click();
  await expect(page.getByText('Estancia guardada.')).toBeVisible();
  const keys = async () => (await api.booking.t.db.query<{ id: string; person_key: string | null }>(`select id, person_key from booking.guests where id = any($1::uuid[])`, [[marta, nico]])).rows;
  const persons = async () => (await api.booking.t.db.query<{ from_date: string; to_date: string; names: string[]; keys: string[] }>(
    `select s.from_date::text, s.to_date::text, array_agg(p.name order by p.name) names, array_agg(p.person_key::text order by p.name) keys
       from booking.stays s join booking.stay_persons p on p.stay_id = s.id and p.deleted_at is null
      where s.account_id = $1 and s.deleted_at is null group by s.id order by s.from_date`, [account])).rows;
  await expect.poll(async () => (await persons()).map((x) => x.names)).toEqual([['Marta', 'Nico']]);
  // Cada persona de la estancia es la de sus fichas de huésped (la clave se crea al unirlas).
  const byGuest = new Map((await keys()).map((k) => [k.id, k.person_key]));
  expect((await persons())[0]!.keys).toEqual([byGuest.get(marta), byGuest.get(nico)]);

  // «Separar»: Nico llega un día más tarde.
  await cell(page, nextMonthDay(5)).click();
  await expect(page.locator('#dayActions .gday-who')).toHaveText('Para: Marta, Nico');
  await page.locator('#dayActions button', { hasText: 'Separar' }).click();
  await page.locator('#whoList label', { hasText: 'Nico' }).locator('input').check();
  await page.locator('#splitFrom').fill(nextMonthDay(6));
  await page.locator('#whoOk').click();
  await expect(page.getByText('Estancia separada.')).toBeVisible();
  await expect.poll(async () => (await persons()).map((x) => [x.from_date, x.to_date, x.names])).toEqual([
    [nextMonthDay(5), nextMonthDay(8), ['Marta']],
    [nextMonthDay(6), nextMonthDay(8), ['Nico']],
  ]);
  await expect(page.locator('#calendar .cal-event[data-layer="stay"]', { hasText: 'Nico' }).first()).toBeVisible();
});

test('O4b · retiros abiertos: cualquier huésped los ve en el calendario, con su resumen y sin precio', async ({ page }) => {
  const mio = await api.reservation({ title: 'Mi retiro', start: day(30), end: day(31) });
  const abierto = await api.reservation({ title: 'Yoga y huerto', start: nextMonthDay(20), end: nextMonthDay(22) });
  const oculto = await api.reservation({ title: 'Retiro privado', start: nextMonthDay(24), end: nextMonthDay(25) });
  await api.booking.t.db.query(`update booking.reservations set guests_visible = true, public_summary = $2 where id = $1`, [abierto.id, 'Tres días de yoga suave y trabajo en el huerto.']);
  const g = await api.guest(mio.event, { first_name: 'Iván' });
  await page.goto(`${baseURL}/i/${await api.guestLink(mio.id, g, 'Iván')}`);
  await page.locator('#privacyOk').click();
  await bar(page, 'Calendario').click();
  await expect(page.locator('#calendar .cal-legend')).toContainText('Retiros abiertos');
  await page.locator('#calendar button[aria-label="Siguiente"]').click();
  await expect(page.locator(`#calendar .cal-event[data-event-id="abierto:${abierto.id}"]`).first()).toBeVisible();
  await expect(page.locator(`#calendar .cal-event[data-event-id="abierto:${oculto.id}"]`)).toHaveCount(0);
  await cell(page, nextMonthDay(20)).click();
  await expect(page.locator('#dayActions .gday-open')).toContainText('Yoga y huerto');
  await expect(page.locator('#dayActions .gday-open')).toContainText('Tres días de yoga suave y trabajo en el huerto.');
  await expect(page.locator('#dayActions')).not.toContainText('€');
  // Sin nivel outsider, nada de estancias.
  await expect(page.locator('#calendarNewStay')).toHaveCount(0);
});
