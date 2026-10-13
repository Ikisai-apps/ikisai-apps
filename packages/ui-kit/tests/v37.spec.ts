import { expect, test, type Page } from 'playwright/test';
import { DEFAULT_SPACE_KINDS as K, canPlace, demoSpaces, nextAltura, spaceDescendants, spacePath } from '../src/spaces/model.ts';

const row = (page: Page, id: string) => page.locator(`#spaceTreeHost .space-row[data-id="${id}"]`);
const rowsOf = (page: Page) => page.evaluate(() => (window as unknown as { spaceSource: { rows(): Array<{ id: string; parentId: string | null; name: string; active: boolean; position: number }> } }).spaceSource.rows());

/** Arrastra el asa de `from` hasta `ratio` (0 arriba, 0.5 centro, 1 abajo) de la fila `to`, con el ratón. */
async function drag(page: Page, from: string, to: string, ratio: number): Promise<void> {
  const handle = row(page, from).locator('.space-handle');
  await handle.hover();
  await page.mouse.down();
  const box = (await row(page, to).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * ratio, { steps: 8 });
  await page.mouse.move(box.x + box.width / 2 + 2, box.y + box.height * ratio, { steps: 2 });
}

test.describe('ui-kit v0.30 · reglas de espacios (RECURSOS.md §4.1)', () => {
  const rows = demoSpaces();
  const byId = (id: string) => rows.find((r) => r.id === id)!;
  test('el tipo fija el nivel; cama solo en habitación; altura solo en la raíz; sin ciclos; «Sin altura» solo en la migración', () => {
    expect(canPlace(K, 'cama', byId('hab-1')).ok).toBe(true);
    expect(canPlace(K, 'cama', byId('sala-roble'))).toEqual({ ok: false, reason: 'Una cama solo va dentro de una habitación.' });
    expect(canPlace(K, 'altura', null).ok).toBe(true);
    expect(canPlace(K, 'altura', byId('albergue')).ok).toBe(false);
    expect(canPlace(K, 'edificio', null).ok).toBe(false);
    expect(canPlace(K, 'edificio', null, { legacyRoot: true }).ok).toBe(true);
    expect(canPlace(K, 'habitacion', byId('alt-3')).ok).toBe(false);
    expect(canPlace(K, 'ubicacion', byId('cocina')).ok).toBe(true);
    expect(canPlace(K, 'ubicacion', byId('hab-1')).ok).toBe(false);
    expect(canPlace(K, 'edificio', byId('alt-1'), { rows, movingId: 'alt-1' }).ok).toBe(false);
  });

  test('ruta, descendientes y la siguiente altura libre', () => {
    expect(spacePath(rows, 'hab-3-c2')).toBe('Altura 3 › Albergue › Hab 3 › Cama 2');
    expect(spaceDescendants(rows, 'albergue').sort()).toEqual(['banos-alb', 'hab-1', 'hab-1-c1', 'hab-3', 'hab-3-c1', 'hab-3-c2'].sort());
    expect(nextAltura(rows)).toBeNull();
    expect(nextAltura(rows.filter((r) => r.id !== 'alt-2'))).toBe(2);
  });
});

test.describe('ui-kit v0.30 · createSpaceTree', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 1600 });
    await page.goto('/#spaces');
    await expect(row(page, 'alt-1')).toBeVisible();
  });

  test('@smoke alturas con su descripción, desplegado hasta los edificios, «Sin altura» y búsqueda por la ruta', async ({ page }) => {
    await expect(row(page, 'alt-3').locator('.space-sub')).toHaveText('Albergue');
    await expect(row(page, 'albergue')).toBeVisible();
    // Desplegado hasta los edificios: se ven las habitaciones, no las camas.
    await expect(row(page, 'hab-1')).toBeVisible();
    await expect(row(page, 'hab-1-c1')).toHaveCount(0);
    await expect(page.locator('#spaceTreeHost .space-group')).toContainText('Sin altura');
    await expect(row(page, 'huerto')).toBeVisible();
    await page.locator('#spaceTreeHost .space-tree-search').fill('albergue hab 3');
    await expect(row(page, 'hab-3')).toBeVisible();
    await expect(row(page, 'alt-3')).toBeVisible();
    await expect(row(page, 'sala-roble')).toHaveCount(0);
    await page.locator('#spaceTreeHost .space-tree-search').fill('nada parecido');
    await expect(page.locator('#spaceTreeHost .space-tree-list')).toContainText('Ningún espacio coincide');
    await page.locator('#spaceTreeHost .space-tree-search').fill('');
    await expect(row(page, 'hab-1').locator('.space-sub')).toContainText('2 plazas');
    await row(page, 'hab-1').locator('.space-toggle').click();
    await expect(row(page, 'hab-1-c1').locator('.space-sub')).toContainText('Doble');
    const box = (await row(page, 'alt-1').locator('.space-handle').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(44);
    expect(box.height).toBeGreaterThanOrEqual(44);
  });

  test('arrastrar: al lado y dentro; una colocación no válida se marca con su motivo y no mueve nada', async ({ page }) => {
    await row(page, 'hab-3').locator('.space-toggle').click();
    // Una cama sobre una sala: no válido, con el motivo.
    await drag(page, 'hab-3-c1', 'sala-roble', 0.5);
    await expect(row(page, 'sala-roble')).toHaveClass(/drop-invalid/);
    await expect(page.locator('.space-ghost')).toContainText('Una cama solo va dentro de una habitación.');
    await page.mouse.up();
    expect((await rowsOf(page)).find((r) => r.id === 'hab-3-c1')!.parentId).toBe('hab-3');
    // Una cama en el centro de otra habitación: dentro.
    await drag(page, 'hab-3-c1', 'hab-1', 0.5);
    await expect(row(page, 'hab-1')).toHaveClass(/drop-inside/);
    await page.mouse.up();
    await expect.poll(async () => (await rowsOf(page)).find((r) => r.id === 'hab-3-c1')!.parentId).toBe('hab-1');
    // En el borde de una habitación, una cama también va dentro (al lado no podría ir).
    await drag(page, 'hab-3-c2', 'hab-1', 0.05);
    await expect(row(page, 'hab-1')).toHaveClass(/drop-inside/);
    await page.mouse.up();
    await expect.poll(async () => (await rowsOf(page)).find((r) => r.id === 'hab-3-c2')!.parentId).toBe('hab-1');
    // Una habitación encima de la Sala Roble: pasa al Edificio de salas, antes de ella.
    await drag(page, 'hab-1', 'sala-roble', 0.1);
    await expect(row(page, 'sala-roble')).toHaveClass(/drop-before/);
    await page.mouse.up();
    await expect.poll(async () => (await rowsOf(page)).find((r) => r.id === 'hab-1')!.parentId).toBe('ed-salas');
    const after = await rowsOf(page);
    expect(after.find((r) => r.id === 'hab-1')!.position).toBeLessThan(after.find((r) => r.id === 'sala-roble')!.position);
    // Un exterior sin altura se coloca en su altura.
    await drag(page, 'huerto', 'alt-2', 0.5);
    await page.mouse.up();
    await expect.poll(async () => (await rowsOf(page)).find((r) => r.id === 'huerto')!.parentId).toBe('alt-2');
    await expect(page.locator('#spaceTreeHost .space-group')).toHaveCount(0);
  });

  test('subir y bajar con los botones y con las flechas en el asa', async ({ page }) => {
    await row(page, 'sala-olivo').getByRole('button', { name: 'Subir Sala Olivo' }).click();
    await expect.poll(async () => { const r = await rowsOf(page); return r.find((x) => x.id === 'sala-olivo')!.position < r.find((x) => x.id === 'sala-roble')!.position; }).toBe(true);
    await row(page, 'sala-olivo').locator('.space-handle').focus();
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => { const r = await rowsOf(page); return r.find((x) => x.id === 'sala-olivo')!.position > r.find((x) => x.id === 'sala-roble')!.position; }).toBe(true);
    await expect(row(page, 'sala-olivo').locator('.space-handle')).toBeFocused();
  });

  test('crear dentro con «+», con aviso si el nombre ya existe al lado; editar los datos del tipo', async ({ page }) => {
    await row(page, 'albergue').getByRole('button', { name: 'Añadir dentro de Albergue' }).click();
    const sheet = page.locator('.sheet').last();
    await sheet.getByLabel('Tipo').selectOption('habitacion');
    await sheet.locator('input[name="name"]').fill('hab 3');
    await expect(sheet.locator('.hint.suggest')).toContainText('Ya hay uno que se llama «Hab 3».');
    await sheet.locator('input[name="name"]').fill('Hab 4');
    await sheet.getByLabel('Capacidad').fill('3');
    await page.getByRole('button', { name: 'Crear' }).click();
    await expect.poll(async () => (await rowsOf(page)).find((r) => r.name === 'Hab 4')?.parentId).toBe('albergue');
    await expect(row(page, 'hab-1')).toBeVisible();
    const id = (await rowsOf(page)).find((r) => r.name === 'Hab 4')!.id;
    await row(page, id).getByRole('button', { name: 'Editar Hab 4' }).click();
    await page.locator('.sheet').last().getByLabel('Reservable').check();
    await page.locator('.sheet').last().getByLabel('Código').fill('H4');
    await page.locator('.sheet').last().getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect(row(page, id).locator('.space-code')).toHaveText('H4');
    await expect(row(page, id).locator('.space-sub')).toContainText('Reservable');
  });

  test('«Duplicar» copia con lo de dentro; «Mover a…» lleva a un padre válido', async ({ page }) => {
    await row(page, 'hab-3').locator('.space-body').click();
    await page.locator('.sheet').last().getByRole('button', { name: 'Duplicar', exact: true }).click();
    await expect.poll(async () => (await rowsOf(page)).filter((r) => r.name === 'Hab 3 (copia)').length).toBe(1);
    const all = await rowsOf(page);
    const copy = all.find((r) => r.name === 'Hab 3 (copia)')!;
    expect(all.filter((r) => r.parentId === copy.id).map((r) => r.name).sort()).toEqual(['Cama 1', 'Cama 2']);
    await row(page, 'jardin').locator('.space-body').click();
    const sheet = page.locator('.sheet').last();
    await sheet.locator('.space-search').fill('altura 1');
    await expect(sheet.getByRole('option')).toHaveCount(1);
    await sheet.locator('.space-search').press('Enter');
    await page.locator('.sheet').last().getByRole('button', { name: 'Guardar', exact: true }).click();
    await expect.poll(async () => (await rowsOf(page)).find((r) => r.id === 'jardin')!.parentId).toBe('alt-1');
  });

  test('«Archivar» con todo lo de dentro, «Ver archivados» y «Recuperar»; la negativa del servidor se enseña tal cual', async ({ page }) => {
    await row(page, 'albergue').locator('.space-body').click();
    await page.getByRole('button', { name: 'Archivar' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('¿Archivar «Albergue» y 6 espacios de dentro?');
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archivar' }).click();
    await expect(row(page, 'albergue')).toHaveCount(0);
    expect((await rowsOf(page)).filter((r) => !r.active).length).toBe(7);
    await page.locator('#spaceTreeHost .space-tree-archived input').check();
    await expect(row(page, 'albergue')).toHaveClass(/archived/);
    await row(page, 'albergue').locator('.space-body').click();
    await page.getByRole('button', { name: 'Recuperar' }).click();
    await expect.poll(async () => (await rowsOf(page)).filter((r) => !r.active).length).toBe(0);
    await row(page, 'piscina').locator('.space-body').click();
    await page.getByRole('button', { name: 'Archivar' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Archivar' }).click();
    await expect(page.getByRole('alertdialog')).toContainText('tiene reservas futuras');
    expect((await rowsOf(page)).find((r) => r.id === 'piscina')!.active).toBe(true);
  });
});

test.describe('ui-kit v0.30 · createSpacePicker', () => {
  test('@smoke más usados a un toque, búsqueda con la ruta y teclado, chips con la ruta corta y «×»', async ({ page }) => {
    await page.goto('/#spaces');
    const picker = page.locator('#spacePickerMany');
    await picker.getByRole('button', { name: 'Cocina', exact: true }).click();
    await expect(picker.getByRole('button', { name: 'Cocina', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#spacePickedOut')).toHaveText('cocina');
    await picker.getByRole('combobox').fill('roble');
    await expect(picker.getByRole('option')).toHaveCount(1);
    await expect(picker.getByRole('option')).toContainText('Altura 1 › Edificio de salas');
    await picker.getByRole('combobox').press('Enter');
    await expect(page.locator('#spacePickedOut')).toHaveText('cocina, sala-roble');
    await expect(picker.locator('.space-chip', { hasText: 'Edificio de salas › Sala Roble' })).toBeVisible();
    await picker.getByRole('button', { name: 'Quitar Altura 1 › Edificio de salas › Cocina' }).click();
    await expect(page.locator('#spacePickedOut')).toHaveText('sala-roble');
    // Sin tildes ni mayúsculas, también por la ruta.
    await picker.getByRole('combobox').fill('albergue camara');
    await expect(picker.getByRole('option')).toContainText('Ningún espacio coincide');
    await picker.getByRole('combobox').fill('camara');
    await expect(picker.getByRole('option')).toContainText('Cámara');
  });

  test('filtro: solo lo reservable; elegir uno lo recuerda como reciente', async ({ page }) => {
    await page.goto('/#spaces');
    await page.evaluate(() => { try { localStorage.removeItem('ikisai-space-recent:demo-reservable'); } catch { /* */ } });
    await page.reload();
    const picker = page.locator('#spacePickerBookable');
    await picker.getByRole('combobox').fill('a');
    const names = await picker.locator('.space-result-name').allTextContents();
    expect(names.sort()).toEqual(['Hab 1', 'Hab 3', 'Sala Olivo', 'Sala Roble'].sort());
    await picker.getByRole('option', { name: /Hab 3/ }).click();
    await expect(picker.locator('.space-chip')).toHaveText(/Albergue › Hab 3/);
    await page.reload();
    await expect(page.locator('#spacePickerBookable .space-quick')).toContainText('Recientes');
    await expect(page.locator('#spacePickerBookable').getByRole('button', { name: 'Hab 3' })).toBeVisible();
  });
});

test.describe('ui-kit v0.30 · createSyncSpaceSource (adaptador sobre el sync-client de resources)', () => {
  test('lee el espejo, escribe en un lote con la revisión, archiva todo junto, tipos de space_kinds y rechazos tal cual', async () => {
    const { createSyncSpaceSource } = await import('../src/spaces/sync-source.ts');
    const now = '2026-10-13T10:00:00Z';
    const base = { created_at: now, updated_at: now, updated_by: 'u1', deleted_at: null };
    const spaces = [
      { ...base, id: 'a', revision: 3, parent_id: null, kind: 'altura', name: 'Altura 3', public_name: null, code: null, position: 1, active: true, notes: 'Albergue', attributes: {} },
      { ...base, id: 'b', revision: 7, parent_id: 'a', kind: 'edificio', name: 'Albergue', public_name: null, code: 'ALB', position: 1, active: true, notes: null, attributes: { bookable: true }, _pending: true },
      { ...base, id: 'c', revision: 2, parent_id: 'b', kind: 'habitacion', name: 'Hab 3', public_name: 'Habitación 3', code: null, position: 1, active: true, notes: null, attributes: {} },
    ];
    const kinds = [
      { ...base, id: 'k1', revision: 1, kind: 'cama', label: 'Cama', level: 4, parents: ['habitacion'], attribute_keys: ['bed_kind', 'capacity'], position: 20, active: true },
      { ...base, id: 'k2', revision: 1, kind: 'edificio', label: 'Edificio', level: 2, parents: ['altura', 'root'], attribute_keys: ['bookable', 'capacity', 'accessible'], position: 2, active: true },
    ];
    const commits: unknown[][] = [];
    let statusListener: ((s: { rejected: number }) => void) | null = null;
    const errors: string[] = [];
    const client = {
      list: async (table: string) => (table === 'resources.spaces' ? spaces : kinds),
      get: async (_t: string, id: string) => spaces.find((s) => s.id === id) ?? null,
      onTable: () => () => undefined,
      commit: async (ops: unknown[]) => { commits.push(ops); return { requestId: `req-${commits.length}` }; },
      onStatus: (l: (s: { rejected: number }) => void) => { statusListener = l; return () => undefined; },
      rejected: async () => [{ requestId: 'req-2', operations: [], baseRows: {}, rejectedAt: now, error: { status: 403, code: 'FORBIDDEN', message: 'Mover espacios es solo para administradores.', details: null } }],
    };
    const source = createSyncSpaceSource(client as never, { onError: (m) => errors.push(m) });
    const rows = await source.list();
    expect(rows[1]).toMatchObject({ id: 'b', parentId: 'a', code: 'ALB', pending: true, attributes: { bookable: true } });
    expect(rows[2]!.publicName).toBe('Habitación 3');
    await source.update('c', { name: 'Hab 3B', publicName: null });
    expect(commits[0]).toEqual([{ op: 'update', table: 'resources.spaces', id: 'c', expectedRevision: 2, fields: { name: 'Hab 3B', public_name: null } }]);
    await source.archive(['b', 'c']);
    expect(commits[1]).toEqual([
      { op: 'update', table: 'resources.spaces', id: 'b', expectedRevision: 7, fields: { active: false } },
      { op: 'update', table: 'resources.spaces', id: 'c', expectedRevision: 2, fields: { active: false } },
    ]);
    await source.createMany([{ id: 'n1', parentId: 'b', kind: 'habitacion', name: 'Hab 9', publicName: null, code: null, position: 2, active: true, notes: null, attributes: {} }]);
    expect((commits[2]![0] as { op: string; fields: Record<string, unknown> }).op).toBe('insert');
    expect((commits[2]![0] as { fields: Record<string, unknown> }).fields).toMatchObject({ parent_id: 'b', kind: 'habitacion', name: 'Hab 9' });
    const k = await source.listKinds();
    expect(k.map((x) => x.kind)).toEqual(['edificio', 'cama']);
    expect(k[0]).toMatchObject({ level: 2, parents: ['altura'] });
    expect(k[1]!.attributes!.map((a) => a.label)).toEqual(['Tipo de cama', 'Plazas']);
    statusListener!({ rejected: 1 });
    await expect.poll(() => errors).toEqual(['Mover espacios es solo para administradores.']);
    statusListener!({ rejected: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(errors).toHaveLength(1);
  });
});
