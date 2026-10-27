import { expect, test } from 'playwright/test';
import { groupLanes, LANE_NONE } from '../src/pieces/lanes-group.ts';

/** Encargo de Core (27-10, traspaso de Flow v03 §12): carriles agrupando por cualquier clave, sin tocar createLanes. */
const WORK = [
  { id: 't1', who: 'Ana', phase: 'hoy' },
  { id: 't2', who: 'luis', phase: 'hoy' },
  { id: 't3', who: 'Ana', phase: 'manana' },
  { id: 't4', who: null, phase: 'hoy' },
  { id: 't5', who: 'Ángel', phase: 'otra' },
];

test.describe('ui-kit v0.65 · groupLanes', () => {
  test('agrupa por la clave: fijos en su orden (también vacíos), el resto por título y «Sin asignar» al final', ({}, info) => {
    test.skip(info.project.name !== 'escritorio', 'función pura: una vez basta');
    const byWho = groupLanes(WORK, { key: (t) => t.who, mount: () => {} });
    expect(byWho.map((l) => [l.id, l.title, l.count])).toEqual([['Ana', 'Ana', 2], ['Ángel', 'Ángel', 1], ['luis', 'luis', 1], [LANE_NONE, 'Sin asignar', 1]]);
    const byPhase = groupLanes(WORK, { key: (t) => t.phase, order: ['hoy', 'manana', 'semana'], title: (k) => ({ hoy: 'Hoy', manana: 'Mañana', semana: 'Semana' } as Record<string, string>)[k] ?? k, mount: () => {} });
    expect(byPhase.map((l) => `${l.title}:${l.count}${l.empty ? '·vacío' : ''}`)).toEqual(['Hoy:3', 'Mañana:1', 'Semana:0·vacío', 'otra:1']);
    expect(groupLanes(WORK, { key: (t) => t.phase, order: ['hoy', 'semana'], hideEmpty: true, mount: () => {} }).map((l) => l.id)).toEqual(['hoy', 'manana', 'otra']);
    expect(groupLanes([], { key: () => 'x', noneTitle: 'Nadie', mount: () => {} })).toEqual([]);
  });

  test('@smoke en la demo: cambiar de agrupación repinta los carriles con sus tarjetas y vacíos', async ({ page }) => {
    await page.goto('/');
    const host = page.locator('#groupLanesHost');
    await host.scrollIntoViewIfNeeded();
    const lanes = host.locator('.lanes-lane');
    await expect(lanes).toHaveCount(4);
    await expect(host).toContainText('Sin asignar');
    await expect(host.getByText('Revisar la ducha 3')).toBeVisible();
    await page.locator('#groupPick [data-group="phase"]').click();
    await expect(lanes).toHaveCount(4);
    await expect(host).toContainText('Esta semana');
    await expect(host).not.toContainText('Sin asignar');
    // «Esta semana» no tiene nada: mini columna plegada.
    await expect(host.locator('.lanes-mini')).toHaveCount(1);
    await expect(host.getByText('Cloro de la piscina')).toBeVisible();
    await expect(page.locator('#groupPick [data-group="phase"]')).toHaveAttribute('aria-pressed', 'true');
  });
});
