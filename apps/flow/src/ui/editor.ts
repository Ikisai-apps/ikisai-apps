import type { SyncClient } from '@ikisai/sync-client';
import { confirmDialog, el, icon, replace, toast } from '@ikisai/ui-kit';
import { PIECES, PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { callProcedure, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { loadProjects, type Project } from '../app/data.ts';
import { pickBookingEvent, type BookingEvent } from '../app/links.ts';
import { busyButton } from './sheets-common.ts';
import type { ViewMount } from './shell.ts';

/**
 * Editor de flujos (0914, solo owner). Un flujo es una lista ordenada de piezas (columnas conocidas), cada una con su
 * nombre y sus opciones. Crear: desde una plantilla (Barra, Llegadas…, o las guardadas) o en blanco, con nombre y evento
 * de Booking opcionales. Editar: cambiar nombres, orden, opciones y piezas de un flujo no congelado. «Guardar como
 * plantilla» guarda sus columnas como versión nueva de una plantilla. La portada y los documentos se ponen en su Inicio.
 */
interface Row { id?: string; revision?: number; key: string; label: string; options: Record<string, boolean> }
interface TemplateColumn { template_key: string; version: number; label_base: string; key: string; label: string; config: Record<string, unknown>; position: number; deleted_at: string | null }
interface Column { id: string; revision: number; project_id: string; key: string; label: string; position: number; config: Record<string, unknown> | null; deleted_at: string | null }

const pieceOf = (key: string) => PIECES.find((p) => p.key === key);
const optionsOf = (key: string, config: Record<string, unknown> | null | undefined): Record<string, boolean> =>
  Object.fromEntries((pieceOf(key)?.options ?? []).map((o) => [o.key, config?.[o.key] === true]));

export function mountEditor(mode: 'new' | 'edit'): ViewMount {
  return ({ main, client, navigate, projectId }) => {
    if (client.bootstrap()?.membership.role !== 'owner') {
      main.append(el('p', { class: 'muted' }, 'El editor de flujos es del encargado.'));
      return () => undefined;
    }
    let rows: Row[] = [];
    let original: Column[] = [];
    let project: Project | null = null;
    let event: BookingEvent | null = null;
    let templateKey: string | null = null;
    let fromTemplate = '';
    const name = el('input', { type: 'text', maxlength: '120', placeholder: 'Nombre del flujo', 'aria-label': 'Nombre del flujo' });
    const eventButton = el('button', { type: 'button', class: 'ghost', onclick: () => void chooseEvent() }, 'Ligar a un evento de Booking');
    const templates = el('div', { class: 'flow-pick editor-templates' });
    const list = el('div', { class: 'editor-columns', role: 'list', 'aria-label': 'Columnas' });
    const add = el('select', { 'aria-label': 'Añadir columna', onchange: () => addPiece() });
    const foot = el('div', { class: 'flow-actions' });
    main.append(
      el('h1', { class: 'col-title' }, mode === 'new' ? 'Nuevo flujo' : 'Columnas del flujo'),
      ...(mode === 'new' ? [el('div', { class: 'editor-head' }, name, eventButton), el('h2', { class: 'col-title' }, 'Empezar desde'), templates] : []),
      el('h2', { class: 'col-title' }, 'Columnas'), list, el('label', { class: 'editor-add' }, icon('plus', 18), add), foot);
    main.setAttribute('data-feedback-id', mode === 'new' ? 'flow.editor.nuevo' : 'flow.editor.columnas');

    async function chooseEvent(): Promise<void> {
      if (!isOnline(client)) { toast('Necesita conexión.'); return; }
      try { event = await pickBookingEvent(client); } catch (error) { toast(describeError(error)); }
      eventButton.textContent = event ? `Evento: ${event.name}` : 'Ligar a un evento de Booking';
    }

    function paint(): void {
      replace(list, ...rows.map((r, i) => {
        const piece = pieceOf(r.key);
        const label = el('input', { type: 'text', maxlength: '60', value: r.label, 'aria-label': `Nombre de la columna ${i + 1}`, oninput: () => { r.label = label.value; } });
        return el('div', { class: 'qcard editor-row', role: 'listitem' },
          el('div', { class: 'editor-row-main' }, label, el('small', { class: 'muted' }, `${piece?.label ?? r.key} · ${piece?.hint ?? ''}`),
            ...(piece?.options ?? []).map((o) => el('label', { class: 'editor-option' },
              el('input', { type: 'checkbox', checked: r.options[o.key] === true, onchange: (e: Event) => { r.options[o.key] = (e.target as HTMLInputElement).checked; } }),
              el('span', null, o.label)))),
          el('div', { class: 'editor-row-tools' },
            el('button', { type: 'button', class: 'ghost icon-button', 'aria-label': 'Subir', disabled: i === 0, onclick: () => move(i, -1) }, icon('chevronUp', 18)),
            el('button', { type: 'button', class: 'ghost icon-button', 'aria-label': 'Bajar', disabled: i === rows.length - 1, onclick: () => move(i, 1) }, icon('chevronDown', 18)),
            el('button', { type: 'button', class: 'ghost icon-button', 'aria-label': 'Quitar', onclick: () => { rows.splice(i, 1); paint(); } }, icon('trash', 18))));
      }));
      if (!rows.length) list.append(el('p', { class: 'muted' }, 'Aún no hay columnas: añade la primera.'));
      const free = PIECES.filter((p) => !rows.some((r) => r.key === p.key));
      replace(add, el('option', { value: '' }, free.length ? 'Añadir columna…' : 'Ya están todas las piezas'), ...free.map((p) => el('option', { value: p.key }, `${p.label} · ${p.hint}`)));
      add.disabled = !free.length;
      replace(foot,
        ...(mode === 'edit' ? [el('button', { type: 'button', class: 'ghost', onclick: () => void saveAsTemplate() }, 'Guardar como plantilla')] : []),
        busyButton({ class: 'primary' }, mode === 'new' ? 'Crear flujo' : 'Guardar columnas', save));
    }

    function move(i: number, d: number): void { const [r] = rows.splice(i, 1); rows.splice(i + d, 0, r!); paint(); }
    function addPiece(): void {
      const p = pieceOf(add.value);
      if (p) rows.push({ key: p.key, label: p.label, options: optionsOf(p.key, null) });
      paint();
    }

    async function loadTemplates(): Promise<void> {
      const all = ((await client.list(TABLES.templateColumns)) as unknown as TemplateColumn[]).filter((t) => !t.deleted_at);
      const latest = new Map<string, number>();
      for (const t of all) latest.set(t.template_key, Math.max(latest.get(t.template_key) ?? 0, t.version));
      const pick = (key: string | null) => {
        templateKey = key;
        rows = key ? all.filter((t) => t.template_key === key && t.version === latest.get(key)).sort((a, b) => a.position - b.position)
          .map((t) => ({ key: t.key, label: t.label, options: optionsOf(t.key, t.config) })) : [];
        fromTemplate = JSON.stringify(rows);
        templates.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.key === (key ?? ''))));
        paint();
      };
      replace(templates, ...[...latest.keys()].sort().map((k) => {
        const base = all.find((t) => t.template_key === k && t.version === latest.get(k))?.label_base ?? k;
        return el('button', { type: 'button', class: 'secondary', 'data-key': k, onclick: () => pick(k) }, `${base} · v${latest.get(k)}`);
      }), el('button', { type: 'button', class: 'ghost', 'data-key': '', onclick: () => pick(null) }, 'En blanco'));
      pick(latest.has('barra') ? 'barra' : null);
    }

    async function loadColumns(): Promise<void> {
      project = (await loadProjects(client)).find((p) => p.id === projectId) ?? null;
      original = ((await client.list(TABLES.columns)) as unknown as Column[]).filter((c) => c.project_id === projectId && !c.deleted_at).sort((a, b) => a.position - b.position);
      rows = original.map((c) => ({ id: c.id, revision: c.revision, key: c.key, label: c.label, options: optionsOf(c.key, c.config) }));
      if (project?.frozen) {
        replace(main, el('h1', { class: 'col-title' }, 'Columnas del flujo'),
          el('p', { class: 'muted' }, 'Esta versión está congelada: su configuración no cambia. Crea una versión nueva desde su Inicio.'));
        return;
      }
      paint();
    }

    async function save(): Promise<void> {
      if (!isOnline(client)) { toast('Necesita conexión.'); return; }
      if (!rows.length) { toast('Un flujo necesita al menos una columna.'); return; }
      if (rows.some((r) => !r.label.trim())) { toast('Pon nombre a todas las columnas.'); return; }
      try {
        if (mode === 'new') {
          const columns = rows.map((r) => ({ key: r.key, label: r.label.trim(), options: r.options }));
          const sameAsTemplate = templateKey && JSON.stringify(rows) === fromTemplate;
          const out = await callProcedure<{ project_id: string; name: string }>(client, PROCEDURES.createFlow, {
            project_id: crypto.randomUUID(), ...(templateKey ? { template_key: templateKey } : {}), ...(sameAsTemplate ? {} : { columns }),
            ...(name.value.trim() ? { name: name.value.trim() } : {}),
            ...(event ? { booking_event_id: event.event_id, starts_on: event.starts_on, ends_on: event.ends_on } : {}) });
          await client.sync();
          toast(`Creado «${out.name}». Pon su portada y documentos en su Inicio, y da acceso al personal en Central.`);
          navigate(`#/p/${out.project_id}`);
          return;
        }
        // Editar: borrar lo quitado, actualizar y crear, con la posición nueva.
        const ops: unknown[] = [];
        for (const c of original) if (!rows.some((r) => r.id === c.id)) ops.push({ op: 'delete', table: TABLES.columns, id: c.id, expectedRevision: c.revision });
        rows.forEach((r, i) => {
          const base = original.find((c) => c.id === r.id);
          const config = { ...(base?.config ?? {}), ...r.options };
          for (const k of Object.keys(r.options)) if (!r.options[k]) delete (config as Record<string, unknown>)[k];
          if (base) {
            if (base.label !== r.label.trim() || base.position !== i + 1 || JSON.stringify(base.config ?? {}) !== JSON.stringify(config)) {
              ops.push({ op: 'update', table: TABLES.columns, id: base.id, expectedRevision: base.revision, fields: { label: r.label.trim(), position: i + 1, config } });
            }
          } else {
            const piece = pieceOf(r.key)!;
            ops.push({ op: 'insert', table: TABLES.columns, id: crypto.randomUUID(), fields: { project_id: projectId, key: r.key, label: r.label.trim(),
              behavior: piece.behavior, position: i + 1, config: { ...baseConfig(r.key), ...Object.fromEntries(Object.entries(r.options).filter(([, v]) => v)) } } });
          }
        });
        if (!ops.length) { toast('Sin cambios.'); return; }
        await client.commit(ops as any);
        toast('Columnas guardadas.');
        await loadColumns();
      } catch (error) { toast(describeError(error)); }
    }

    async function saveAsTemplate(): Promise<void> {
      const key = el('input', { type: 'text', maxlength: '31', placeholder: 'clave (p. ej. barra)', 'aria-label': 'Clave de la plantilla', value: project?.template_key ?? '' });
      const base = el('input', { type: 'text', maxlength: '80', placeholder: 'Nombre (p. ej. Barra)', 'aria-label': 'Nombre de la plantilla' });
      const ok = await confirmDialog({ title: 'Guardar como plantilla', text: 'Sus columnas, nombres y opciones quedan como versión nueva de la plantilla.', body: el('div', { class: 'editor-head' }, key, base), confirmLabel: 'Guardar' });
      if (!ok) return;
      try {
        const out = await callProcedure<{ template_key: string; version: number }>(client, PROCEDURES.saveTemplate, { project_id: projectId, template_key: key.value.trim(), label_base: base.value.trim() });
        toast(`Plantilla «${out.template_key}» v${out.version} guardada.`);
      } catch (error) { toast(describeError(error)); }
    }

    if (mode === 'new') void loadTemplates(); else void loadColumns();
    return () => undefined;
  };
}

/** Config base de una pieza (igual que flow.piece_config sin opciones). */
function baseConfig(key: string): Record<string, unknown> {
  if (key === 'ingredients') return { proposal: true, manual: true };
  if (key === 'logistics') return { manual: true };
  if (['arrival', 'bed', 'signature', 'departure'].includes(key)) return { stage: key };
  return {};
}

/** «Nuevo flujo» en la lista de flujos y «Columnas del flujo» en su Inicio (owner). */
export const editorLinks = (client: SyncClient, projectId?: string) =>
  client.bootstrap()?.membership.role === 'owner'
    ? el('a', { class: 'ghost button-link', href: projectId ? `#/p/${projectId}/editor` : '#/nuevo' }, projectId ? 'Columnas del flujo' : 'Nuevo flujo')
    : null;
