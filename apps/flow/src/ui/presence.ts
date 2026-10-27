import type { SyncClient } from '@ikisai/sync-client';
import { el, icon, replace, toast } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES, type PresenceStage } from '@ikisai/domain-flow';
import { callProcedure, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { loadProjects } from '../app/data.ts';
import { busyButton } from './sheets-common.ts';
import type { ViewMount } from './shell.ts';

/**
 * Columnas del check-in (comportamiento `guest_presence`, 0911): Llegada → Cama → Firma → Salida con los huéspedes del
 * evento de Booking (`booking.flow_guests_projection`: nombre corto, cama, noches, llegada, salida y si firmó).
 * - Llegada y Salida escriben en Booking (flow-api → booking-api, con el token de la persona) y se pueden deshacer.
 * - Cama es una marca de Flow («acompañado a su cama»).
 * - Firma solo avisa: el parte se firma en Huéspedes; la tarjeta se va sola al firmar.
 * Arriba lo que falta; debajo, en gris, lo hecho (con «Deshacer»). Se refresca cada 10 s con la pantalla visible.
 */
interface Guest {
  guest_id: string; display_name: string; portal_role: string | null; space_name: string | null; bed_label: string | null;
  from_date: string | null; to_date: string | null; arrived_at: string | null; left_at: string | null; signed: boolean;
}
interface Mark { guest_id: string; step: string; project_id: string; deleted_at: string | null }

const TITLES: Record<PresenceStage, string> = { arrival: 'Llegada', bed: 'Cama', signature: 'Firma', departure: 'Salida' };
const EMPTY: Record<PresenceStage, string> = {
  arrival: 'No queda nadie por llegar.', bed: 'Nadie espera a que lo acompañen a su cama.',
  signature: 'Todos los que han llegado han firmado.', departure: 'No queda nadie por irse.',
};
const REFRESH_MS = 10_000;
const day = (iso: string | null) => (iso ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date(iso)) : '');
const short = (d: string | null) => (d ? new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short' }).format(new Date(`${d}T12:00:00`)) : '');

export async function loadGuests(client: SyncClient, eventId: string): Promise<Guest[]> {
  const out = await client.api<{ rows: Guest[] }>('/read/booking.flow_guests_projection', { method: 'POST', json: { where: { event_id: eventId }, limit: 2000 } });
  return (out.rows ?? []).sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));
}

export function mountPresence(stage: PresenceStage): ViewMount {
  return ({ main, client, projectId }) => {
    const canEdit = ['editor', 'owner'].includes(client.bootstrap()?.membership.role ?? '');
    let guests: Guest[] = [];
    let marks = new Set<string>();
    let eventId: string | null = null;
    let search = '';
    let error = '';

    const searchInput = el('input', { type: 'search', placeholder: 'Buscar por nombre', 'aria-label': 'Buscar por nombre', autocomplete: 'off',
      oninput: () => { search = searchInput.value.trim().toLocaleLowerCase('es'); paint(); } });
    const count = el('p', { class: 'muted small', role: 'status' });
    const listEl = el('div', { class: 'fqueue presence-list', role: 'list' });
    main.append(el('h1', { class: 'col-title' }, TITLES[stage]), el('div', { class: 'orders-tools' }, searchInput), count, listEl);

    /** ¿Le falta este paso? ¿Lo tiene hecho? (los que no tocan esta columna, ni una cosa ni otra) */
    function state(g: Guest): 'todo' | 'done' | null {
      const arrived = !!g.arrived_at;
      switch (stage) {
        case 'arrival': return g.left_at ? null : arrived ? (day(g.arrived_at) === day(new Date().toISOString()) ? 'done' : null) : 'todo';
        case 'bed': return !arrived || g.left_at ? null : marks.has(g.guest_id) ? 'done' : 'todo';
        case 'signature': return !arrived || g.left_at ? null : g.signed ? 'done' : 'todo';
        case 'departure': return !arrived ? null : g.left_at ? (day(g.left_at) === day(new Date().toISOString()) ? 'done' : null) : 'todo';
      }
    }

    function card(g: Guest, done: boolean): HTMLElement {
      const bed = [g.space_name, g.bed_label].filter(Boolean).join(' · ');
      const nights = g.from_date ? `${short(g.from_date)} – ${short(g.to_date)}` : '';
      const sub = [bed || 'sin cama asignada', nights, g.portal_role === 'staff' || g.portal_role === 'direccion' ? 'equipo' : ''].filter(Boolean).join(' · ');
      return el('div', { class: `qcard presence-card${done ? ' is-done' : ''}`, role: 'listitem' },
        el('span', { class: 'qcard-text' }, el('strong', { class: 'qcard-title' }, g.display_name), el('small', { class: 'qcard-sub muted' }, sub)),
        ...actions(g, done));
    }

    function actions(g: Guest, done: boolean): HTMLElement[] {
      if (!canEdit) return [];
      if (stage === 'signature') return done ? [el('span', { class: 'qcard-state' }, icon('check', 16), ' Firmado')] : [el('span', { class: 'qcard-state muted' }, 'Firma en Huéspedes')];
      const label = done ? 'Deshacer' : stage === 'arrival' ? 'Ha llegado' : stage === 'bed' ? 'En su cama' : 'Se ha ido';
      return [busyButton({ class: done ? 'ghost' : 'primary' }, label, () => act(g, done))];
    }

    async function act(g: Guest, undo: boolean): Promise<void> {
      if (!isOnline(client)) { toast('Necesita conexión.'); return; }
      try {
        if (stage === 'bed') {
          await callProcedure(client, PROCEDURES.markPresence, { project_id: projectId, guest_id: g.guest_id, step: 'bed', undo });
        } else {
          await client.api(`/checkin/${projectId}/guests/${g.guest_id}/${stage === 'arrival' ? 'arrive' : 'leave'}`, { method: 'POST', json: { undo } });
          toast(undo ? 'Deshecho.' : stage === 'arrival' ? `${g.display_name}: ha llegado.` : `${g.display_name}: se ha ido.`);
        }
        await refresh();
      } catch (e) { toast(describeError(e)); }
    }

    function paint(): void {
      if (error) { replace(listEl, el('p', { class: 'formerror', role: 'alert' }, error)); count.textContent = ''; return; }
      const shown = guests.filter((g) => !search || g.display_name.toLocaleLowerCase('es').includes(search));
      const todo = shown.filter((g) => state(g) === 'todo');
      const done = shown.filter((g) => state(g) === 'done');
      count.textContent = `${todo.length} por hacer${done.length ? ` · ${done.length} hechos hoy` : ''}`;
      if (stage === 'departure') todo.sort((a, b) => (a.to_date ?? '9').localeCompare(b.to_date ?? '9'));
      replace(listEl, ...(todo.length ? todo.map((g) => card(g, false)) : [el('p', { class: 'muted fqueue-empty' }, search ? 'Nadie con ese nombre.' : EMPTY[stage])]),
        ...done.map((g) => card(g, true)));
    }

    async function readMarks(): Promise<void> {
      const rows = (await client.list(TABLES.presenceMarks)) as unknown as Mark[];
      marks = new Set(rows.filter((m) => !m.deleted_at && m.project_id === projectId && m.step === 'bed').map((m) => m.guest_id));
    }

    async function refresh(): Promise<void> {
      try {
        if (!eventId) eventId = (await loadProjects(client)).find((p) => p.id === projectId)?.booking_event_id ?? null;
        if (!eventId) { error = 'Este flujo aún no está ligado a su evento de Booking: el encargado lo liga en el Inicio.'; paint(); return; }
        if (stage === 'bed') await readMarks();
        if (document.visibilityState !== 'hidden' && isOnline(client)) guests = await loadGuests(client, eventId);
        error = '';
      } catch (e) { error = describeError(e); }
      paint();
    }

    void refresh();
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, REFRESH_MS);
    const offMarks = client.onTable(TABLES.presenceMarks, () => { void readMarks().then(paint); });
    return () => { clearInterval(timer); offMarks(); };
  };
}
