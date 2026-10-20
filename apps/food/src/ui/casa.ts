/**
 * Food · «Casa» (Bloque 2, barra C, MUELA-077 §3 y §4): la Despensa y la Maquinaria en una pantalla con dos pestañas
 * (`segmented`, como las de la ficha del menú). `#/despensa` y `#/maquinaria` siguen vivas y abren su pestaña (Inicio y
 * la receta enlazan a ellas); `#/casa` abre la última que se usó en este dispositivo.
 */
import { el, replace } from '@ikisai/ui-kit';
import { mountEquipment } from './equipment.ts';
import { mountPantry } from './pantry.ts';
import type { ViewMount } from './shell.ts';

export const CASA_HASH = '#/casa';
export type CasaTab = 'despensa' | 'maquinaria';
const TAB_KEY = 'food.casa.pestana';
const TABS: Array<{ key: CasaTab; label: string; hash: string }> = [
  { key: 'despensa', label: 'Despensa', hash: '#/despensa' },
  { key: 'maquinaria', label: 'Maquinaria', hash: '#/maquinaria' },
];

/** La pestaña de `#/casa`: la última que se abrió aquí; si no, la Despensa. */
export function lastCasaTab(): CasaTab {
  try { return localStorage.getItem(TAB_KEY) === 'maquinaria' ? 'maquinaria' : 'despensa'; } catch { return 'despensa'; }
}

export const mountCasa = (tab: CasaTab): ViewMount => (ctx) => {
  try { localStorage.setItem(TAB_KEY, tab); } catch { /* sin almacenamiento: solo esta visita */ }
  const inner = el('div', { id: 'casaView' });
  const bar = el('nav', { 'data-feedback-id': 'food.casa.pestanas', 'data-feedback-label': 'Pestañas de Casa', class: 'segmented fd-casatabs', id: 'casaTabs', 'aria-label': 'Casa' },
    ...TABS.map((t) => el('button', {
      type: 'button', class: t.key === tab ? 'on' : '', 'data-tab': t.key, 'aria-current': t.key === tab ? 'page' : null,
      onclick: () => { if (t.key !== tab) ctx.navigate(t.hash); },
    }, t.label)));
  replace(ctx.main, bar, inner);
  return (tab === 'despensa' ? mountPantry : mountEquipment)({ ...ctx, main: inner });
};
