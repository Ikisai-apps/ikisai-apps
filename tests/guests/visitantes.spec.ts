/**
 * Visitantes por QR (API.md §9.19), contra la API real sobre PGlite con el núcleo de visitantes (C11, 0096), el código
 * público del evento (Booking 0488) y sus peticiones (Booking #770):
 * - `/e/<código>` abre el evento sin sesión; se entra sin dar ningún dato y el acceso sigue al recargar;
 * - «Apuntarme» con los datos voluntarios queda «Pendiente»; «Mis eventos» lo recuerda en este móvil;
 * - un código que no es de nadie no dice si existió; «Salir de este móvil» lo borra todo.
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

test('§9.19 · por QR, sin datos: el evento, «Apuntarme» pendiente, «Mis eventos» y «Salir de este móvil»', async ({ page }) => {
  const r = await api.reservation({ title: 'Jornadas de otoño', start: day(3), end: day(4) });
  await api.booking.t.db.query('update booking.reservations set guests_visible = true, public_summary = $2 where id = $1', [r.id, 'Dos días de puertas abiertas.']);
  const code = (await api.booking.t.db.query<{ public_code: string }>('select public_code from booking.events where id = $1', [r.event])).rows[0]!.public_code;

  // El código en minúsculas también vale; la ruta deja de llevarlo.
  await page.goto(`${baseURL}/e/${code.toLowerCase()}`);
  await expect(page).toHaveURL(new RegExp(`/#/v/${code}$`));
  await expect(page.locator('#retreatTitle')).toHaveText('Jornadas de otoño');
  await expect(page.locator('#visitorSummary')).toHaveText('Dos días de puertas abiertas.');
  await expect(page.locator('#visitorWelcome')).toContainText('Entras sin dar ningún dato');
  await page.locator('#visitorEnter').click();

  // «Apuntarme»: el nombre es lo único obligatorio.
  await page.locator('#visitorJoin').click();
  await expect(page.locator('#visitorName')).toBeFocused();
  await page.locator('#visitorName').fill('Iker');
  await page.locator('#visitorJoinContact').fill('iker@example.invalid');
  await page.locator('#visitorJoin').click();
  await expect(page.locator('#visitorSent')).toContainText('Apuntarme · Pendiente');
  await expect(page.locator('#visitorJoinForm')).toHaveCount(0);
  // El contacto nunca vuelve en lo que ve el visitante.
  await expect(page.locator('#visitorRequests')).not.toContainText('iker@example.invalid');

  // Al recargar sigue siendo el mismo visitante, con su petición.
  await page.reload();
  await expect(page.locator('#visitorSent')).toContainText('Pendiente');
  await expect(page.locator('#visitorEnter')).toHaveCount(0);

  // «Mis eventos» de este móvil.
  await page.goto(`${baseURL}/#/v`);
  await expect(page.locator('#visitor-before')).toContainText('Jornadas de otoño');

  // Un código que no es de nadie: sin decir si existió.
  await page.goto(`${baseURL}/e/ZZZZZZZZZZ`);
  await expect(page.locator('#visitorUnknown')).toContainText('Este código no es de ningún evento abierto');

  // «Salir de este móvil»: se borra el acceso y la lista.
  await page.goto(`${baseURL}/#/v/${code}`);
  await page.locator('#visitorForget').click();
  await expect(page.locator('#visitorEmpty')).toBeVisible();
  await page.goto(`${baseURL}/#/v/${code}`);
  await expect(page.locator('#visitorEnter')).toBeVisible();
});

test('§9.19 · nunca en blanco: un evento que ya no abre y un acceso de visitante caducado lo dicen', async ({ page }) => {
  const r = await api.reservation({ title: 'Jornada de puertas abiertas', start: day(5), end: day(5) });
  await api.booking.t.db.query('update booking.reservations set guests_visible = true where id = $1', [r.id]);
  const code = (await api.booking.t.db.query<{ public_code: string }>('select public_code from booking.events where id = $1', [r.event])).rows[0]!.public_code;

  // Este móvil recuerda un evento que ya no existe (o cuyo código cambió) y su acceso guardado ya no vale.
  await page.goto(`${baseURL}/#/v`);
  await page.evaluate((c) => {
    localStorage.setItem('ikisai-visitor-events', JSON.stringify([c, 'ZZZZZZZZZZ']));
    localStorage.setItem('ikisai-visitor', 'acceso-que-ya-no-vale');
  }, code);
  await page.reload();
  await expect(page.locator('#visitor-before')).toContainText('Jornada de puertas abiertas');
  await expect(page.locator('#visitorListGone')).toContainText('1 evento ya no se puede abrir');

  // Al abrir el evento, el acceso se renueva solo y se dice por qué no se ve lo de antes; una vez.
  await page.goto(`${baseURL}/#/v/${code}`);
  await expect(page.locator('#visitorRenewed')).toContainText('Tu acceso de visitante anterior ya no valía');
  expect(await page.evaluate(() => localStorage.getItem('ikisai-visitor'))).not.toBe('acceso-que-ya-no-vale');
  await page.reload();
  await expect(page.locator('#visitorLeaveBox')).toBeVisible();
  await expect(page.locator('#visitorRenewed')).toHaveCount(0);
});

test('ENTRADA_PUBLICA · sin invitación ni QR: ven.ikisai.com enseña los eventos abiertos y se entra como visitante', async ({ page }) => {
  const r = await api.reservation({ title: 'Jornada abierta de la finca', start: day(6), end: day(6) });
  await api.booking.t.db.query(`update booking.reservations set guests_visible = true, event_type = 'jornadas_abiertas' where id = $1`, [r.id]);
  const code = (await api.booking.t.db.query<{ public_code: string }>('select public_code from booking.events where id = $1', [r.event])).rows[0]!.public_code;

  await page.goto(`${baseURL}/`);
  const open = page.locator('#openEvents');
  const card = open.locator(`a[data-code="${code}"]`);
  await expect(card).toContainText('Jornada abierta de la finca');
  await expect(card).toContainText('Jornadas abiertas');
  // Mirar no crea identidad: solo al «Entrar».
  expect(await page.evaluate(() => localStorage.getItem('ikisai-visitor'))).toBeNull();
  await card.click();
  await expect(page.locator('#retreatTitle')).toHaveText('Jornada abierta de la finca');
  await page.locator('#visitorEnter').click();
  await expect(page.locator('#visitorLeaveBox')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('ikisai-visitor'))).not.toBeNull();
});

test('ENTRADA_PUBLICA · «Reservar antes de venir»: precios y plazas para todas las noches y la solicitud con la plaza guardada', async ({ page }) => {
  const d = await api.openDays(day(10), day(14), { lodging_pay_mode: 'hold', lodging_hold_hours: 24 });
  // «Reservar antes de venir» va dentro de «Alójate aquí» (abierta por el QR), plegada.
  await page.goto(`${baseURL}/e/${d.code}?alojate`);
  await page.locator('#lodgeLater > summary').click();
  const stay = page.locator('#pubStay');
  await expect(stay).toBeVisible();
  // Mirar no pide nada ni crea identidad.
  await stay.locator('#pubStayFrom').fill(day(11));
  await stay.locator('#pubStayTo').fill(day(13));
  await stay.locator('#pubStayPersons').fill('3');
  await stay.locator('#pubStayLook').click();
  await expect(stay.locator('#pubStayAvailable')).toContainText('Quedan 2 plazas todas esas noches (2 noches)');
  await expect(stay.locator('#pubStayModes button')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('ikisai-visitor'))).toBeNull();

  await stay.locator('#pubStayPersons').fill('1');
  await stay.locator('#pubStayLook').click();
  const mode = stay.locator(`#pubStayModes [data-mode="${d.rate}"]`);
  await expect(mode).toContainText(/20,00.*la noche.*40,00.*en total/);
  await mode.getByRole('button', { name: 'Elegir' }).click();
  await expect(stay.locator('#pubStayPay')).toContainText('Te guardamos la plaza 24 horas y se paga en recepción.');
  // El nombre es lo único obligatorio.
  await stay.locator('#pubStaySend').click();
  await expect(stay.locator('#pubStayName')).toBeFocused();
  await stay.locator('#pubStayName').fill('Noa');
  await stay.locator('#pubStaySend').click();
  await expect(page.locator('#visitorSent')).toContainText('Noches · Pendiente');
  await expect(page.locator('#visitorSent')).toContainText('plaza guardada hasta');
  await expect(page.locator('#visitorSent')).toContainText(/40,00/);
});

test('«Alójate aquí» (como la barra): la pestaña en el evento abierto; cama y datos en borrador, «Ir a pagar» y su número', async ({ page, browser }) => {
  const d = await api.openDays(day(0), day(3), { lodging_pay_mode: 'hold', lodging_hold_hours: 2 });
  // Sin QR (desde la raíz pública) también: ven.ikisai.com es la única entrada (VG, 27-10 noche; vg-48, recomendada).
  const other = await browser.newPage();
  await other.goto(`${baseURL}/#/v/${d.code}`);
  await expect(other.locator('#retreatTitle')).toBeVisible();
  await expect(other.locator('#visitorTabs a[data-tab="alojate"]')).toBeVisible();
  await other.close();

  await page.goto(`${baseURL}/e/${d.code}?alojate`);
  await expect(page).toHaveURL(new RegExp(`/#/v/${d.code}/alojate$`));
  await expect(page.locator('#visitorTabs a[data-tab="alojate"]')).toHaveClass(/on/);
  const beds = page.locator('#lodgeBeds');
  await expect(beds.getByLabel('Asignadme una')).toBeChecked();
  await expect(page.locator('#lodgePrice')).toContainText(/20,00.*la noche/);
  // Las camas libres son de toda la casa (la base de pruebas la comparten otras pruebas): la de su habitación.
  await beds.locator('.glodge-room', { hasText: d.room }).getByLabel('Cama 1', { exact: true }).check();
  // Solo el nombre es obligatorio; el documento, no.
  await page.locator('#lodgeGo').click();
  await expect(page.locator('#lodge_first_name')).toBeFocused();
  await page.locator('#lodge_first_name').fill('Noa');
  await page.locator('#lodgeGo').click();
  await expect(page.locator('#lodgeNumber')).toHaveText(/\S+/);
  await expect(page.locator('#lodgePay')).toContainText('Ve a recepción y di tu número para pagar.');
  await expect(page.locator('#lodgePay')).toContainText('Cama 1');
  await expect(page.locator('#lodgeMissing')).toContainText('Número de documento');
  // Al volver, la misma estancia (no se pide otra vez).
  await page.reload();
  await expect(page.locator('#lodgeNumber')).toHaveText(/\S+/);
  await expect(page.locator('#lodgeForm')).toHaveCount(0);

  // Recepción cobra con su número (Booking 1401): la pantalla pasa a «Esta noche duermes en …».
  const request = (await api.booking.t.db.query<{ id: string }>(`select r.id from booking.visitor_requests r join booking.events e on e.id = r.event_id where e.public_code = $1 and r.kind = 'stay' order by r.created_at desc limit 1`, [d.code])).rows[0]!.id;
  await api.bookingCommit([{ op: 'call', procedure: 'booking.join_from_visitor', args: { request_id: request, decision: 'accept', method: 'cash' } }]);
  await page.reload();
  await expect(page.locator('#lodgeTonight')).toContainText('Esta noche duermes en');
  await expect(page.locator('#lodgeTonight')).toContainText('Cama 1');
});

test('ENTRADA_PUBLICA · «Guarda tu acceso»: correo y código, y se recupera en otro móvil con lo pedido', async ({ page, browser }) => {
  const r = await api.reservation({ title: 'Jornada para guardar acceso', start: day(7), end: day(7) });
  await api.booking.t.db.query('update booking.reservations set guests_visible = true where id = $1', [r.id]);
  const code = (await api.booking.t.db.query<{ public_code: string }>('select public_code from booking.events where id = $1', [r.event])).rows[0]!.public_code;
  const email = `noa-${Date.now()}@example.invalid`;

  await page.goto(`${baseURL}/e/${code}`);
  await page.locator('#visitorEnter').click();
  await page.locator('#visitorLeaveBox > summary').click();
  await page.locator('#visitorContact').fill('noa@example.invalid');
  await page.locator('#visitorLeave').click();
  await expect(page.locator('#visitorSent')).toContainText('Pendiente');

  const box = page.locator('#visitorAccess');
  await box.locator('summary').click();
  await box.locator('#accessEmail').fill('no-es-un-correo');
  await box.locator('#accessSend').click();
  await expect(box.locator('#accessWhy')).toContainText('Escribe un correo válido.');
  await box.locator('#accessEmail').fill(email);
  await box.locator('#accessSend').click();
  await expect(box.locator('#accessSent')).toContainText(email);
  await box.locator('#accessCode').fill('000000');
  await box.locator('#accessVerify').click();
  await expect(box.locator('#accessWhy')).toContainText('no vale o ha caducado');
  await box.locator('#accessCode').fill('123456');
  await box.locator('#accessVerify').click();
  await expect(box.locator('#accessSaved')).toContainText('Guardado con');

  // Otro móvil, desde «Mis eventos» (vacía): el mismo correo recupera el acceso, la lista (núcleo 0107) y lo pedido.
  const other = await browser.newPage();
  await other.goto(`${baseURL}/#/v`);
  await expect(other.locator('#visitorEmpty')).toBeVisible();
  const box2 = other.locator('#visitorAccess');
  await box2.locator('summary').click();
  await box2.locator('#accessEmail').fill(email);
  await box2.locator('#accessSend').click();
  await box2.locator('#accessCode').fill('123456');
  await box2.locator('#accessVerify').click();
  await expect(other.locator('#visitor-before')).toContainText('Jornada para guardar acceso');
  await other.locator(`#visitor-before a[data-code="${code}"]`).click();
  await expect(other.locator('#visitorSent')).toContainText('Pendiente');
  await other.close();
});

test('ENTRADA_PUBLICA · «Tu ficha está lista» y «Unir este móvil a mi ficha»: sin emparejar por nombre', async ({ page }) => {
  const r = await api.reservation({ title: 'Retiro con apuntarme', start: day(8), end: day(9) });
  await api.booking.t.db.query('update booking.reservations set guests_visible = true where id = $1', [r.id]);
  const code = (await api.booking.t.db.query<{ public_code: string }>('select public_code from booking.events where id = $1', [r.event])).rows[0]!.public_code;
  await page.goto(`${baseURL}/e/${code}`);
  await page.locator('#visitorEnter').click();
  await page.locator('#visitorName').fill('Iria');
  await page.locator('#visitorJoin').click();
  await expect(page.locator('#visitorSent')).toContainText('Pendiente');
  // Sin aceptar, no hay ficha que reclamar.
  await expect(page.locator('#visitorSent .gclaim')).toHaveCount(0);

  // El personal la acepta: Booking crea la ficha y la liga a la petición.
  const request = (await api.booking.t.db.query<{ id: string }>(`select id from booking.visitor_requests where event_id = $1 and kind = 'join' order by created_at desc limit 1`, [r.event])).rows[0]!.id;
  await api.bookingCommit([{ op: 'call', procedure: 'booking.join_from_visitor', args: { request_id: request, decision: 'accept' } }]);
  await page.reload();
  await page.locator(`#visitorSent .gclaim[data-request="${request}"]`).click();
  // Entra en su ficha con el enlace de un solo uso (aviso de datos de la primera entrada).
  await expect(page.locator('#privacyOk')).toBeVisible();
  await page.locator('#privacyOk').click();
  await expect(page.locator('#retreatTitle')).toBeVisible();
  // En el portal del huésped, este móvil (que fue visitante) puede unirse a la ficha y deshacerlo.
  const link = page.locator('#visitorLink');
  await expect(link).toBeVisible();
  await link.locator('#visitorLinkGo').click();
  await expect(link.locator('#visitorLinked')).toBeVisible();
  await link.locator('#visitorUnlink').click();
  await expect(link.locator('#visitorLinkGo')).toBeVisible();
});

test('§9.19 · «Mi pedido» (Flow FL2): «Abrir la carta» le da su número, que sigue al volver', async ({ page, context }) => {
  const r = await api.reservation({ title: 'Jornada con barra', start: day(0), end: day(1) });
  await api.booking.t.db.query('update booking.reservations set guests_visible = true where id = $1', [r.id]);
  const code = (await api.booking.t.db.query<{ public_code: string }>('select public_code from booking.events where id = $1', [r.event])).rows[0]!.public_code;
  await api.linkBar(r.event);
  // La carta de Flow es otra app: aquí basta con que se abra.
  await context.route('https://flow.ikisai.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Carta</title>' }));

  await page.goto(`${baseURL}/e/${code}`);
  await page.locator('#visitorEnter').click();
  const order = page.locator('#visitorOrder');
  // Los recorridos del evento: pedir en la barra y tus datos.
  await expect(page.locator('#visitorRoutes [data-route="carta"]')).toBeVisible();
  await expect(page.locator('#visitorRoutes [data-route="datos"]')).toBeVisible();
  // Aún sin número (sin cliente o con cliente sin número).
  await expect(order.locator('#visitorNumber')).toContainText(/Pide desde la carta|Aún no tienes número/);
  const [carta] = await Promise.all([context.waitForEvent('page'), order.locator('#visitorCarta').click()]);
  // La pestaña nace en blanco (para que el navegador no la bloquee) y luego va a la carta con su invitación y el traspaso
  // de esta identidad (`v`, 0106), para que la carta sea el mismo visitante.
  await carta.waitForURL(/^https:\/\/flow\.ikisai\.com\/\?invitacion=[^&]+&v=[0-9a-f]{64}$/);
  await carta.close();
  await expect(order.locator('#visitorNumber')).toContainText(/Tu número: \d+/);
  const number = (await order.locator('#visitorNumber').textContent())!.match(/\d+/)![0];
  await page.reload();
  await expect(page.locator('#visitorNumber')).toContainText(`Tu número: ${number}`);
  // Al acabar, la carta vuelve con `?siguiente=datos`: a lo que se pide aquí.
  await page.goto(`${baseURL}/e/${code}?siguiente=datos`);
  await expect(page.locator('#visitorRequests')).toBeFocused();
});

test('«Alójate aquí» · las camas en el plano: sin identidad de visitante, nunca; con ella y habiendo entrado, se elige tocando', async ({ page }) => {
  const d = await api.openDays(day(0), day(3), { lodging_pay_mode: 'hold', lodging_hold_hours: 2 });
  // Las dos camas recién creadas (cada fichero de pruebas tiene su base) y su pareja en Recursos, sobre un dibujo.
  const beds = (await api.booking.t.db.query<{ id: string; label: string }>(`select id, label from booking.beds order by created_at desc, label desc limit 2`)).rows;
  const byLabel = Object.fromEntries(beds.map((b) => [b.label, b.id]));
  const square = (x: number, y: number, s: number): Array<[number, number]> => [[x, y], [x + s, y], [x + s, y + s], [x, y + s]];
  const { ids } = await api.floorPlan([
    { name: 'Habitación de las jornadas', kind: 'habitacion', points: square(0.1, 0.1, 0.6) },
    { name: 'Cama 1', kind: 'cama', parent: 'Habitación de las jornadas', refs: [`booking.bed:${byLabel['Cama 1']}`], attributes: { bed_kind: 'individual' } },
    { name: 'Cama 2', kind: 'cama', parent: 'Habitación de las jornadas', refs: [`booking.bed:${byLabel['Cama 2']}`], attributes: { bed_kind: 'individual' } },
  ]);
  // Su sitio, en Booking (un solo modelo): `booking_public_beds` no da la habitación de Recursos, así que va por la de la cama.
  const space = (await api.booking.t.db.query<{ space_id: string }>('select space_id from booking.beds where id = $1', [byLabel['Cama 1']])).rows[0]!.space_id;
  await api.bedLayout(space, { cols: 4, rows: 4 }, [[byLabel['Cama 1']!, { x: 0, y: 0, rot: 0 }], [byLabel['Cama 2']!, { x: 2, y: 2, rot: 0 }]]);
  // La pareja que lee Booking (`booking.beds.resource_id`, la de `booking_public_beds`).
  for (const label of ['Cama 1', 'Cama 2']) await api.booking.t.db.query('update booking.beds set resource_id = $1 where id = $2', [ids[label], byLabel[label]]);

  // Sin `X-Visitor`, la ruta no da el plano.
  const anonymous = await page.request.get(`${baseURL}/api/v1/public/plans?event_code=${d.code}`);
  expect(anonymous.status()).toBe(401);

  await page.goto(`${baseURL}/e/${d.code}?alojate`);
  const box = page.locator('#lodgePlanBox');
  await box.locator('summary').click();
  const bed2 = box.locator(`.map-svg [data-space-id="${ids['Cama 2']}"]`);
  await expect(bed2).toBeVisible();
  await bed2.click();
  await expect(page.locator(`#lodgeBeds input[name="lodgeBed"][value="${byLabel['Cama 2']}"]`)).toBeChecked();
  // Sin datos de nadie en el plano.
  await expect(box).not.toContainText('Noa');
});

test('«Alójate aquí» · Guiado de Flow en ven.ikisai.com: señala el campo, explica el paso, avisa al guardar y vuelve a la guía', async ({ page }) => {
  const d = await api.openDays(day(0), day(3), { lodging_pay_mode: 'hold', lodging_hold_hours: 2 });
  const back = 'https://flow.ikisai.com/#/guia';
  const guide = new URLSearchParams({ campo: 'guests.visitante.alojate.viajero.first_name', paso: 'Escribe tu nombre', desde: 'flow', volver: back, titulo: 'la guía' });
  await page.goto(`${baseURL}/e/${d.code}?alojate&${guide}`);
  // La línea del paso arriba y el campo señalado (con su ancla del inventario); la URL, limpia.
  await expect(page.locator('.guia-callout')).toContainText('Escribe tu nombre');
  const name = page.locator('#lodge_first_name');
  await expect(name).toHaveAttribute('data-field-id', 'guests.visitante.alojate.viajero.first_name');
  await expect(name).toBeFocused();
  await expect(page).not.toHaveURL(/campo=/);
  await expect(page.locator('.return-link')).toHaveAttribute('href', back);
  // Al guardar con «Ir a pagar», se confirma el paso.
  await name.fill('Noa');
  await page.locator('#lodgeGo').click();
  await expect(page.locator('#lodgeNumber')).toHaveText(/\S+/);
  await expect(page.getByText('Hecho. Puedes volver a la guía.')).toBeVisible();
});
