/**
 * Bloque «Portal del organizador» de la ficha (contrato §3.6): emite, lista, amplía y revoca los enlaces personales del
 * portal Organizers. Todo pasa por la API (necesita red) y solo lo ven editor y owner. La URL completa solo existe en la
 * respuesta de la emisión: se enseña una vez en una hoja y no se guarda en ningún sitio.
 */
import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, el, formatDate, openSheet, toast, type Sheet } from '@ikisai/ui-kit';
import { describeError } from '../app/client.ts';
import { buildForm, type FieldSpec } from './form.ts';

export interface PortalLink {
  linkId: string;
  app: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  extendedUntil: string | null;
  validUntil: string | null;
}

interface Issued { linkId: string; url: string; validUntil: string | null }

export interface PortalBlockOptions {
  client: SyncClient;
  reservation: { id: string; contact_name?: unknown; contact_email?: unknown };
  editable: boolean;
}

export interface PortalBlock {
  render(options: PortalBlockOptions): HTMLElement;
  destroy(): void;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null);
const localDay = (date: Date): string => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

/** Final del día local `AAAA-MM-DD` como instante ISO. */
export function endOfDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y!, m! - 1, d!, 23, 59, 59, 0).toISOString();
}

/** Estado legible de un enlace: «Revocado», «Caducado» o la fecha límite. */
export function validityText(link: PortalLink): { text: string; state: 'revoked' | 'expired' | 'valid' } {
  if (link.revokedAt) return { text: 'Revocado', state: 'revoked' };
  if (!link.validUntil || Date.parse(link.validUntil) < Date.now()) return { text: 'Caducado', state: 'expired' };
  return { text: `Válido hasta ${formatDate(link.validUntil)}`, state: 'valid' };
}

export function createPortalBlock(): PortalBlock {
  let current: PortalBlockOptions | null = null;
  let loadedFor: string | null = null;
  let items: PortalLink[] | null = null;
  let loadError: string | null = null;
  let loading = false;
  const host = el('article', { class: 'card', id: 'blockPortal' });

  async function refresh(): Promise<void> {
    const o = current;
    if (!o || !o.editable || !navigator.onLine || loading) return;
    loading = true;
    try {
      const out = await o.client.api<{ items: PortalLink[] }>(`/portal-links?reservation=${encodeURIComponent(o.reservation.id)}`);
      items = (out.items ?? []).filter((item) => item.app === 'organizers');
      loadError = null;
    } catch (error) {
      loadError = describeError(error);
    } finally {
      loading = false;
      paint();
    }
  }

  /** Hoja con la URL recién emitida: es la única vez que se ve. Al cerrarla, el DOM que la contiene desaparece. */
  function showIssued(issued: Issued, name: string): void {
    const field = el('textarea', { id: 'portalUrl', class: 'portal-url', rows: 3, readonly: true, spellcheck: false, 'aria-label': 'Enlace del organizador', onfocus: (e: Event) => (e.target as HTMLTextAreaElement).select() }, issued.url);
    const copy = async () => {
      try { await navigator.clipboard.writeText(issued.url); toast('Enlace copiado'); } catch { field.select(); toast('No se pudo copiar. Selecciona el enlace y cópialo a mano.'); }
    };
    const canShare = typeof navigator.share === 'function';
    const share = async () => {
      try { await navigator.share({ title: 'Portal del organizador', text: `Enlace personal para ${name}`, url: issued.url }); } catch { /* cancelado por la persona */ }
    };
    const sheet: Sheet = openSheet({
      title: 'Enlace generado',
      meta: `Para ${name}${issued.validUntil ? ` · válido hasta ${formatDate(issued.validUntil)}` : ''}`,
      body: el('div', { class: 'portal-issued' },
        el('div', { class: 'portal-urlbox' }, field),
        el('div', { class: 'choices' },
          el('button', { class: 'primary', type: 'button', id: 'portalCopy', onclick: () => void copy() }, 'Copiar'),
          canShare ? el('button', { class: 'ghost', type: 'button', id: 'portalShare', onclick: () => void share() }, 'Compartir') : null),
        el('p', { class: 'hint', id: 'portalOnce', role: 'note' }, 'Este enlace no se volverá a mostrar. Si se pierde, genera otro.')),
      foot: el('div', { class: 'choices' }, el('button', { class: 'ghost', type: 'button', id: 'portalDone', onclick: () => void sheet.close(true) }, 'Cerrar')),
      onClose: () => { field.value = ''; void refresh(); },
    });
  }

  function openIssue(): void {
    const o = current!;
    const specs: FieldSpec[] = [
      { key: 'person_name', label: 'Nombre del organizador', type: 'text', max: 120 },
      { key: 'person_email', label: 'Correo (opcional)', type: 'email', max: 320, hint: 'Con correo, el organizador conserva la misma cuenta en sus próximos retiros' },
    ];
    const form = buildForm(specs, null, { person_name: str(o.reservation.contact_name), person_email: str(o.reservation.contact_email) });
    const send = el('button', { class: 'primary', type: 'button', id: 'portalIssue', onclick: () => void submit() }, 'Generar enlace');
    async function submit(): Promise<void> {
      const values = form.values();
      const name = str(values.person_name);
      const email = str(values.person_email);
      if (!name) return form.showError('Escribe el nombre del organizador.');
      if (email && !EMAIL.test(email)) return form.showError('El correo no parece válido.');
      if (!navigator.onLine) return form.showError('Generar el enlace necesita conexión.');
      send.disabled = true;
      try {
        const issued = await o.client.api<Issued>('/portal-links', { json: { app: 'organizers', scope: { reservation_id: o.reservation.id }, person: { name, ...(email ? { email } : {}) } } });
        showIssued(issued, name);
      } catch (error) {
        form.showError(describeError(error));
        send.disabled = false;
      }
    }
    const sheet: Sheet = openSheet({
      title: 'Enlace para el organizador',
      body: el('form', { onsubmit: (e: Event) => { e.preventDefault(); void submit(); } }, form.element),
      foot: el('div', { class: 'choices' }, send, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar')),
      initialFocus: form.first(),
    });
  }

  function openExtend(link: PortalLink): void {
    const min = localDay(new Date());
    const form = buildForm([{ key: 'until', label: 'Ampliar hasta', type: 'date', dateMin: min, hint: 'El enlace sirve hasta el final de ese día.' }], null, { until: link.validUntil ? localDay(new Date(link.validUntil)) : null });
    const save = el('button', { class: 'primary', type: 'button', id: 'portalExtendSave', onclick: () => void submit() }, 'Ampliar');
    async function submit(): Promise<void> {
      const until = str(form.values().until);
      if (!until) return form.showError('Elige una fecha.');
      if (until < min) return form.showError('La fecha no puede ser anterior a hoy.');
      save.disabled = true;
      try {
        await current!.client.api(`/portal-links/${encodeURIComponent(link.linkId)}/extend`, { json: { until: endOfDay(until) } });
        await sheet.close(true);
        toast('Enlace ampliado.');
        void refresh();
      } catch (error) {
        form.showError(describeError(error));
        save.disabled = false;
      }
    }
    const sheet: Sheet = openSheet({
      title: 'Ampliar enlace',
      meta: link.label ?? 'Organizador',
      body: el('form', { onsubmit: (e: Event) => { e.preventDefault(); void submit(); } }, form.element),
      foot: el('div', { class: 'choices' }, save, el('button', { class: 'ghost', type: 'button', onclick: () => void sheet.close() }, 'Cancelar')),
      initialFocus: form.first(),
    });
  }

  async function revoke(link: PortalLink): Promise<void> {
    const name = link.label ?? 'El organizador';
    if (!(await confirmDialog({ title: 'Revocar enlace', text: `${name} dejará de poder entrar con este enlace.`, confirmLabel: 'Revocar', danger: true }))) return;
    try {
      await current!.client.api(`/portal-links/${encodeURIComponent(link.linkId)}/revoke`, { json: {} });
      toast('Enlace revocado.');
    } catch (error) {
      toast(describeError(error));
    }
    void refresh();
  }

  function linkRow(link: PortalLink, online: boolean): HTMLElement {
    const v = validityText(link);
    const who = link.label ?? 'organizador';
    return el('li', { class: 'row portal-link', dataset: { state: v.state, link: link.linkId } },
      el('div', { class: 'row-title' }, el('span', { class: 'name' }, link.label ?? 'Organizador'),
        el('span', { class: `chip${v.state === 'valid' ? ' ok' : ' muted'}`, dataset: { role: 'validity' } }, v.text)),
      el('div', { class: 'row-meta' }, el('span', null, `Creado ${formatDate(link.createdAt)}`), el('span', null, link.lastUsedAt ? `Último uso ${formatDate(link.lastUsedAt)}` : 'Sin usar')),
      link.revokedAt ? null : el('div', { class: 'row-actions portal-actions' },
        el('button', { class: 'ghost small', type: 'button', dataset: { action: 'extend' }, disabled: !online, 'aria-label': `Ampliar hasta… (enlace de ${who})`, onclick: () => openExtend(link) }, 'Ampliar hasta…'),
        el('button', { class: 'ghost small', type: 'button', dataset: { action: 'revoke' }, disabled: !online, 'aria-label': `Revocar (enlace de ${who})`, onclick: () => void revoke(link) }, 'Revocar')));
  }

  function paint(): void {
    if (!current) return;
    const online = navigator.onLine;
    const parts: Array<HTMLElement | null> = [
      el('div', { class: 'cardhead' }, el('h3', null, 'Portal del organizador')),
      !online ? el('p', { class: 'hint', id: 'portalOffline', role: 'status' }, 'Los enlaces del organizador necesitan conexión. Se podrán gestionar al reconectar.') : null,
      online && loadError ? el('p', { class: 'hint', id: 'portalError', role: 'alert' }, loadError) : null,
      items === null ? (online && !loadError ? el('p', { class: 'hint' }, 'Cargando enlaces…') : null)
        : items.length === 0 ? el('p', { class: 'hint', id: 'portalEmpty' }, 'Todavía no hay enlaces para esta reserva.')
        : el('ul', { class: 'list', id: 'portalList' }, items.map((link) => linkRow(link, online))),
      el('p', { style: 'margin-top:10px' }, el('button', { class: 'ghost small', type: 'button', id: 'generatePortalLink', disabled: !online, onclick: openIssue }, 'Generar enlace para el organizador')),
    ];
    host.replaceChildren(...parts.filter((part): part is HTMLElement => part !== null));
  }

  const onNet = () => { paint(); if (navigator.onLine) void refresh(); };
  window.addEventListener('online', onNet);
  window.addEventListener('offline', onNet);

  return {
    render(o) {
      if (loadedFor !== o.reservation.id) { loadedFor = o.reservation.id; items = null; loadError = null; }
      current = o;
      paint();
      if (items === null) void refresh();
      return host;
    },
    destroy() { window.removeEventListener('online', onNet); window.removeEventListener('offline', onNet); current = null; },
  };
}
