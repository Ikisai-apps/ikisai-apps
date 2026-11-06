import { confirmDialog, el, fieldAttrs, replace, toast } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { isOnline } from '../app/actions.ts';
import { busyButton } from './sheets-common.ts';
import type { ViewMount } from './shell.ts';

/**
 * «Carga asistida» (fl-25; núcleo 0120). Un agente deja propuestas hacia otra app (Booking, Finance…) agrupadas por
 * `groupKey`; aquí se recorren en tres tramos:
 * 1. Preparada: lo que propone el agente, propuesta a propuesta, con los campos que toca y los «por confirmar».
 * 2. Revisar: cada campo abre la pantalla real de la app con el campo señalado (Guiado del kit, ?campo=).
 * 3. Decidir: aceptar o rechazar el grupo entero, o cada propuesta. Aceptar la aplica en el acto en la app destino.
 * Flow no guarda nada: lee y decide por flow-api con la sesión de quien entra (`/carga/:app/...`).
 * Enlace directo: `#/carga?app=booking&grupo=<clave>`.
 */
interface Proposal {
  id: string; groupKey: string | null; summary: any; fields: string[] | null; uncertain: string[] | null; createdAt: string;
  operations: unknown[] | null; expiresAt: string | null;
}

const APPS: Array<[string, string, string]> = [['booking', 'Booking', 'https://booking.ikisai.com'], ['finance', 'Finance', 'https://finance.ikisai.com'],
  ['tasks', 'Tasks', 'https://tasks.ikisai.com'], ['food', 'Food', 'https://food.ikisai.com'], ['guests', 'Guests', 'https://guests.ikisai.com'],
  ['organizers', 'Organizers', 'https://organizers.ikisai.com']];
const hhmm = (iso: string | null) => (iso ? new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Madrid' }).format(new Date(iso)) : '');

/** Una frase del resumen de la propuesta (el núcleo la ensaya: antes/después). */
function headline(p: Proposal): string {
  const s = p.summary ?? {};
  if (typeof s.text === 'string' && s.text) return s.text;
  if (typeof s.headline === 'string' && s.headline) return s.headline;
  const n = Array.isArray(p.operations) ? p.operations.length : (Array.isArray(s.changes) ? s.changes.length : 0);
  return `${n} ${n === 1 ? 'cambio' : 'cambios'}`;
}

export const mountCarga: ViewMount = ({ main, client }) => {
  const params = new URLSearchParams(location.hash.split('?')[1] ?? '');
  let app = APPS.some(([k]) => k === params.get('app')) ? params.get('app')! : 'booking';
  const onlyGroup = params.get('grupo');
  const appSelect = el('select', { ...fieldAttrs({ id: 'flow.carga.app', type: 'select', storage: 'none' }), 'aria-label': 'App' },
    ...APPS.map(([k, label]) => el('option', { value: k, selected: k === app }, label))) as HTMLSelectElement;
  appSelect.addEventListener('change', () => { app = appSelect.value; void load(); });
  const body = el('section', { class: 'carga', 'aria-live': 'polite', 'data-feedback-id': 'flow.carga' });
  main.append(el('h1', { class: 'col-title' }, 'Carga asistida'),
    el('p', { class: 'muted small' }, 'Lo que un agente ha preparado para otra app. Revisa cada cambio en su pantalla y decide por grupo.'),
    el('div', { class: 'orders-tools' }, appSelect, busyButton({ class: 'ghost' }, 'Actualizar', load)), body);

  async function load(): Promise<void> {
    if (!isOnline(client)) { replace(body, el('p', { class: 'muted' }, 'La carga asistida necesita conexión.')); return; }
    replace(body, el('p', { class: 'muted' }, 'Cargando…'));
    try {
      const out = await client.api<{ items: Proposal[] }>(`/carga/${app}/proposals${onlyGroup ? `?grupo=${encodeURIComponent(onlyGroup)}` : ''}`);
      paint(out.items ?? []);
    } catch (error) { replace(body, el('p', { class: 'formerror', role: 'alert' }, describeError(error))); }
  }

  function paint(items: Proposal[]): void {
    if (!items.length) { replace(body, el('p', { class: 'muted' }, 'No hay propuestas pendientes en esta app.')); return; }
    const groups = new Map<string, Proposal[]>();
    for (const p of items) { const k = p.groupKey ?? ''; groups.set(k, [...(groups.get(k) ?? []), p]); }
    const base = APPS.find(([k]) => k === app)![2];
    replace(body, ...[...groups.entries()].map(([key, ps]) => {
      const doubtful = ps.filter((p) => (p.uncertain ?? []).length).length;
      return el('section', { class: 'carga-group', 'data-group': key },
        el('h2', null, key ? `Grupo ${key}` : 'Sin grupo', el('small', { class: 'muted' }, ` · ${ps.length} ${ps.length === 1 ? 'propuesta' : 'propuestas'}${doubtful ? ` · ${doubtful} con algo por confirmar` : ''}`)),
        el('ol', { class: 'carga-list' }, ...ps.map((p) => el('li', { class: 'qcard', 'data-proposal': p.id },
          el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }, headline(p)),
            el('small', { class: 'qcard-sub muted' }, `Preparada ${hhmm(p.createdAt)}${p.expiresAt ? ` · caduca ${hhmm(p.expiresAt)}` : ''}`),
            (p.fields ?? []).length ? el('ul', { class: 'carga-fields' }, ...(p.fields ?? []).map((f) => el('li', null,
              el('a', { href: `${base}/?desde=flow&volver=${encodeURIComponent(location.href)}&titulo=Flow&campo=${encodeURIComponent(f)}`, target: '_blank', rel: 'noopener' }, `Revisar ${f}`),
              (p.uncertain ?? []).includes(f) ? el('em', { class: 'carga-doubt' }, ' · por confirmar') : null))) : null),
          el('div', { class: 'flow-actions' },
            busyButton({ class: 'ghost', 'data-decide': 'approve' }, 'Aceptar', () => decide(`proposals/${p.id}/approve`, 'Aceptada.')),
            busyButton({ class: 'ghost danger-text', 'data-decide': 'reject' }, 'Rechazar', () => decide(`proposals/${p.id}/reject`, 'Rechazada.')))))),
        key ? el('div', { class: 'flow-actions' },
          busyButton({ class: 'primary', 'data-group-decide': 'approve' }, 'Aceptar el grupo', async () => {
            if (doubtful && !(await confirmDialog({ title: 'Aceptar el grupo', text: `${doubtful} ${doubtful === 1 ? 'propuesta tiene' : 'propuestas tienen'} algo por confirmar. ¿Aceptar igualmente?`, confirmLabel: 'Aceptar' }))) return;
            await decide(`group/${encodeURIComponent(key)}/approve`, 'Grupo aceptado.');
          }),
          busyButton({ class: 'ghost danger-text', 'data-group-decide': 'reject' }, 'Rechazar el grupo', () => decide(`group/${encodeURIComponent(key)}/reject`, 'Grupo rechazado.'))) : null);
    }));
  }

  async function decide(path: string, done: string): Promise<void> {
    if (!isOnline(client)) { toast('Decidir necesita conexión.'); return; }
    try { await client.api(`/carga/${app}/${path}`, { method: 'POST', json: {} }); toast(done); } catch (error) { toast(describeError(error)); }
    await load();
  }

  void load();
  return () => undefined;
};
