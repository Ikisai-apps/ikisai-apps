/**
 * Central · «Textos y contacto»: los textos sembrados, edición con vista previa ya sustituida, aviso de versión nueva,
 * marcadores, historial de versiones y lectura sin edición para quien no es owner. Contra la central-api real (server.ts).
 */
import { expect, test, type Page } from 'playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { freePort } from '../food/helpers.ts';
import { startCentralServer, type CentralTestServer } from './server.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const configFile = path.resolve(here, '../../apps/central/vite.config.ts');

let api: CentralTestServer;
let server: PreviewServer;
let baseURL: string;

test.beforeAll(async () => {
  // Compilar la app con Vite puede pasar de los 90 s con la máquina cargada (fallo visto con @smoke en paralelo).
  test.setTimeout(180_000);
  api = await startCentralServer();
  await api.app.t.db.query(`select central.seed_texts()`);
  await api.app.t.db.query(`select central.seed_contact_audiences()`); // como en producción: un correo por público
  process.env.VITE_API_PROXY = api.url;
  await build({ configFile, logLevel: 'silent' });
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

async function login(page: Page, email: string, name: string): Promise<void> {
  await page.goto(`${baseURL}/`);
  await page.getByLabel('Correo electrónico').fill(email);
  await page.getByLabel('Contraseña').fill(api.password);
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('heading', { name: `Hola, ${name}` })).toBeVisible();
}

test('textos · sembrados, edición con vista previa y versión nueva, marcadores, historial y lector', async ({ page, browser }) => {
  await login(page, 'owner@example.invalid', 'Owner');
  await page.locator('#homeTexts').click();
  await expect(page.getByRole('heading', { name: 'Textos y contacto' })).toBeVisible();
  await expect(page.locator('[data-text="contact.organizers.email"]')).toContainText('organiza@ikisai.com');
  const audiences = page.locator('[data-kind="correos"]');
  await expect(audiences).toContainText('Correos por público');
  await expect(audiences.locator('[data-text="contact.guests.email"]')).toContainText('ven@ikisai.com');
  await expect(audiences.locator('[data-text="contact.phone"]')).toHaveCount(0);
  await expect(page.locator('[data-text="contact.phone"]')).toContainText('614 76 57 96');
  const privacy = page.locator('[data-text="portal.privacy"]');
  // La semilla de los correos por público cambió su marcador de contacto: v2 en los dos idiomas.
  await expect(privacy).toContainText('ES v2');
  await expect(privacy).toContainText('EN v2');
  await expect(page.locator('[data-text="contact.organizers.email"]')).toContainText('EN usa el español');

  // Editar: la vista previa sustituye los marcadores (sin Entidad, «—»; el contacto, de sus textos).
  await privacy.getByRole('button', { name: 'Editar' }).click();
  await expect(page.locator('#tx-preview')).toContainText('Contacto: ven@ikisai.com · 614 76 57 96.');
  await expect(page.locator('#tx-preview')).toContainText('(NIF —)');
  await expect(page.locator('#tx-version')).toHaveText('Versión actual: v2.');
  await page.locator('#tx-body').press('End');
  await page.locator('#tx-body').evaluate((t: HTMLTextAreaElement) => { t.setSelectionRange(t.value.length, t.value.length); });
  await page.locator('#tx-body').pressSequentially('\n\nEscríbenos a ');
  await page.locator('.markerbtn', { hasText: 'Correo para organizadores' }).click();
  await expect(page.locator('#tx-preview')).toContainText('Escríbenos a organiza@ikisai.com');
  await expect(page.locator('#tx-version')).toContainText('Al guardar se crea la versión v3; las aceptaciones anteriores conservan su versión');
  await page.locator('#saveText').click();
  await expect(page.getByText('Texto guardado.')).toBeVisible();
  await expect(privacy).toContainText('ES v3');
  await expect(privacy).toContainText('EN v2');
  await expect.poll(async () => (await api.app.t.db.query<{ version: string }>(`select version from central.texts where key = 'portal.privacy' and lang = 'es'`)).rows[0]!.version).toBe('v3');

  // Historial: la v1 sigue ahí, tal como era.
  await privacy.getByRole('button', { name: 'Editar' }).click();
  await expect(page.locator('#tx-history')).toContainText('Versiones anteriores (2)');
  await page.locator('#tx-history summary').first().click();
  await page.locator('.textversion summary').first().click();
  await expect(page.locator('.textversion[data-version="v1"]')).not.toContainText('Escríbenos a');
  await page.keyboard.press('Escape');

  // Inglés: la traducción existente se abre aparte; un texto sin traducción se traduce partiendo del español.
  await privacy.locator('[data-lang-action="en"]').click();
  await expect(page.locator('#tx-preview')).toContainText('Data protection information');
  await page.keyboard.press('Escape');
  const phone = page.locator('[data-text="contact.phone"]');
  await phone.getByRole('button', { name: 'Traducir al inglés' }).click();
  await expect(page.locator('#tx-translate')).toBeVisible();
  await expect(page.locator('#tx-body')).toHaveValue('614 76 57 96');
  await page.locator('#tx-body').fill('+34 614 76 57 96');
  await page.locator('#saveText').click();
  await expect(page.getByText('Texto guardado.')).toBeVisible();
  await expect(phone).toContainText('EN v1');
  await expect.poll(async () => (await api.app.t.db.query<{ n: number }>(`select count(*)::int as n from central.texts where key = 'contact.phone' and lang = 'en'`)).rows[0]!.n).toBe(1);

  // Quien no es owner lo lee sin poder cambiarlo.
  const other = await browser.newContext();
  const reader = await other.newPage();
  await login(reader, 'reader@example.invalid', 'Reader');
  await reader.locator('#homeTexts').click();
  await expect(reader.locator('#newText')).toHaveCount(0);
  await expect(reader.getByRole('button', { name: 'Traducir al inglés' })).toHaveCount(0);
  await reader.locator('[data-text="portal.privacy"]').getByRole('button', { name: 'Versiones' }).click();
  await expect(reader.locator('#tx-body')).toBeDisabled();
  await expect(reader.locator('#saveText')).toBeHidden();
  await other.close();
});
