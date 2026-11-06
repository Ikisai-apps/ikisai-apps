import { el, fieldAttrs, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { loadProjects } from '../app/data.ts';
import { busyButton } from './sheets-common.ts';
import type { ViewMount } from './shell.ts';

/**
 * «Qué flujos quieres en este dispositivo» (fl-22, VG 05-11): el móvil de la barra no tiene por qué bajarse el Avance ni los
 * demás flujos. Lo elegido se guarda en el dispositivo (`setScope` del cliente) y viaja en `X-Ikisai-Scope`; la Edge solo deja
 * bajar lo de esos flujos (nunca más de lo que permiten tus ámbitos). La lista de flujos se ve siempre entera.
 * Cambiarlo rehace los datos del dispositivo; si hay cambios sin enviar, se avisa y no se toca nada.
 */
const KEY = 'flow-ambito-dispositivo';

export const mountDeviceScope: ViewMount = ({ main, client }) => {
  const body = el('section', { class: 'device-scope', 'data-feedback-id': 'flow.dispositivo' });
  main.append(el('h1', { class: 'col-title' }, 'Flujos en este dispositivo'),
    el('p', { class: 'muted small' }, 'Este dispositivo solo baja los datos de los flujos que marques. Sin ninguno marcado, baja todos los tuyos.'), body);

  void loadProjects(client).then((projects) => {
    const live = projects.filter((p) => p.status === 'active' && !p.frozen).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    let saved: string[] = [];
    try { saved = JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[]; } catch { saved = []; }
    const boxes = live.map((p) => {
      const box = el('input', { ...fieldAttrs({ id: 'flow.dispositivo.flujo', type: 'checkbox', storage: 'none' }), type: 'checkbox', value: p.id, checked: saved.includes(p.id) }) as HTMLInputElement;
      return { box, row: el('label', { class: 'apps-row' }, box, ' ', p.name) };
    });
    replace(body, ...boxes.map((b) => b.row), el('div', { class: 'flow-actions' }, busyButton({ class: 'primary' }, 'Guardar y rehacer los datos', async () => {
      const chosen = boxes.filter((b) => b.box.checked).map((b) => b.box.value);
      try {
        await client.setScope(chosen.length ? { projects: chosen } : null);
        try { localStorage.setItem(KEY, JSON.stringify(chosen)); } catch { /* sin almacenamiento */ }
        toast(chosen.length ? `Este dispositivo baja ${chosen.length === 1 ? 'un flujo' : `${chosen.length} flujos`}.` : 'Este dispositivo baja todos tus flujos.');
        void client.sync();
      } catch (error) {
        const code = (error as { code?: string }).code;
        toast(code === 'PENDING_CHANGES' ? 'Hay cambios de este dispositivo sin enviar: espera a que se envíen y vuelve a guardar.' : describeError(error));
      }
    })));
  }).catch((error) => replace(body, el('p', { class: 'formerror', role: 'alert' }, describeError(error))));
  return () => undefined;
};
