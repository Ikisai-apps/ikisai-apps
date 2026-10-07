import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, createSortableList, el, icon, openSheet, positionBetween, replace, toast, type Sheet } from '@ikisai/ui-kit';
import { SUGGESTED_TEAMS, canSeeReserved, validateOperations } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import type { PersonTeam, Team } from './people.ts';
import type { ViewMount } from './shell.ts';
import { fbMark } from './feedback.ts';

const PALETTE = ['#56663f', '#c4712f', '#3d6b8c', '#8c4a6b', '#b7791f', '#2f7a4b'];

/**
 * Equipos (API.md §2.11): lista con orden manual, alta con color, renombrar y papelera. Los gestionan el owner y el
 * editor con ámbito `people`; el resto los ve. Si no hay ninguno, la interfaz propone los habituales (sin datos en Git).
 */
export const mountTeams: ViewMount = ({ main, client }) => {
  const canManage = canSeeReserved(client.bootstrap()?.membership);
  let teams: Team[] = [];
  let links: PersonTeam[] = [];
  const host = el('div', { id: 'teamList', 'data-feedback-id': 'central.equipos.lista', 'data-feedback-label': 'Lista de equipos' });
  replace(main,
    el('a', { href: '#/personas', class: 'backlink', 'data-feedback-id': 'central.equipos.volver', 'data-feedback-label': 'Volver a Personas' }, '← Personas'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.equipos.cabecera', 'data-feedback-label': 'Cabecera de Equipos' }, el('div', null, el('h2', null, 'Equipos'), el('p', null, 'Grupos de personas: cocina, mantenimiento, dirección… Una persona puede estar en varios.'))),
    host,
    canManage ? el('button', { class: 'fab', type: 'button', id: 'newTeam', 'data-feedback-id': 'central.equipos.nuevo', 'data-feedback-label': 'Nuevo equipo', onclick: () => openEditor(null) }, icon('plus'), 'Nuevo equipo') : null);

  const members = (id: string) => links.filter((x) => x.team_id === id && !x.deleted_at).length;

  async function commit(operations: RowOperation[], ok: string): Promise<boolean> {
    const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' });
    if (issue) { toast(issue.message); return false; }
    try {
      await client.commit(operations);
      toast(!navigator.onLine ? `${ok} Se sincronizará cuando haya red.` : ok);
      return true;
    } catch (e) { toast(describeError(e)); return false; }
  }

  function row(t: Team): HTMLElement {
    return el('div', { class: 'teamrow', 'data-team': t.id, 'data-feedback-id': 'central.equipos.lista.fila', 'data-feedback-label': 'Equipo' },
      el('span', null, el('span', { class: 'chip teamchip', 'data-feedback-id': 'central.equipos.lista.nombre', 'data-feedback-label': 'Nombre del equipo', style: t.color ? `--team:${t.color}` : null }, t.name), ' ',
        el('span', { class: 'muted small', 'data-feedback-id': 'central.equipos.lista.miembros', 'data-feedback-label': 'Personas del equipo' }, `${members(t.id)} ${members(t.id) === 1 ? 'persona' : 'personas'}`)),
      canManage ? el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'central.equipos.lista.editar', 'data-feedback-label': 'Editar equipo', onclick: () => openEditor(t) }, 'Editar') : null);
  }

  function paint(): void {
    if (!teams.length) {
      replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.equipos.vacio', 'data-feedback-label': 'Sin equipos' }, el('strong', null, 'Todavía no hay equipos'),
        canManage ? el('button', { class: 'primary', type: 'button', id: 'seedTeams', 'data-feedback-id': 'central.equipos.vacio.crear_habituales', 'data-feedback-label': 'Crear los equipos habituales', onclick: () => void seed() }, `Crear los habituales: ${SUGGESTED_TEAMS.join(', ')}`) : 'Los crea quien gestiona personas.'));
      return;
    }
    if (!canManage) { replace(host, el('div', { class: 'decisions', 'data-feedback-id': 'central.equipos.lista.solo_lectura', 'data-feedback-label': 'Equipos (solo lectura)' }, ...teams.map((t) => el('div', { class: 'personrow' }, row(t))))); return; }
    const sortable = createSortableList<Team>({
      items: teams, key: (t) => t.id, render: (t) => row(t), name: (t) => t.name, label: 'Equipos', id: 'teamsSortable',
      onReorder: async (items, move) => {
        const position = positionBetween(items[move.to - 1]?.position ?? null, items[move.to + 1]?.position ?? null);
        await commit([{ op: 'update', table: T.teams, id: move.item.id, expectedRevision: move.item.revision, fields: { position } }], 'Orden guardado.');
      },
    });
    replace(host, fbMark(sortable.element, 'central.equipos.lista.ordenable', 'Equipos ordenables'));
  }

  async function seed(): Promise<void> {
    const ops: RowOperation[] = SUGGESTED_TEAMS.map((name, i) => ({ op: 'insert', table: T.teams, id: crypto.randomUUID(), fields: { name, color: PALETTE[i % PALETTE.length], position: (i + 1) * 1024 } }));
    await commit(ops, 'Equipos creados.');
  }

  function openEditor(t: Team | null): void {
    let sheet: Sheet | null = null;
    const error = el('p', { class: 'formerror', role: 'alert', 'data-feedback-id': 'central.equipos.editar.error', 'data-feedback-label': 'Error del formulario' });
    const name = el('input', { id: 'tm-name', type: 'text', maxlength: '60', value: t?.name ?? '' }) as HTMLInputElement;
    const color = el('input', { id: 'tm-color', type: 'color', value: t?.color ?? PALETTE[teams.length % PALETTE.length]! }) as HTMLInputElement;
    const save = el('button', { class: 'primary', type: 'button', id: 'saveTeam', 'data-feedback-id': 'central.equipos.editar.guardar', 'data-feedback-label': 'Guardar', onclick: async () => {
      error.textContent = '';
      if (!name.value.trim()) { error.textContent = 'El nombre es obligatorio.'; return; }
      const fields = { name: name.value.trim(), color: color.value.toLowerCase() };
      const last = teams.at(-1)?.position ?? 0;
      const ok = t
        ? await commit([{ op: 'update', table: T.teams, id: t.id, expectedRevision: t.revision, fields }], 'Equipo guardado.')
        : await commit([{ op: 'insert', table: T.teams, id: crypto.randomUUID(), fields: { ...fields, position: last + 1024 } }], 'Equipo creado.');
      if (ok) await sheet?.close(true);
    } }, 'Guardar');
    sheet = openSheet({
      title: t ? 'Editar equipo' : 'Nuevo equipo',
      panelAttrs: { 'data-feedback-id': 'central.equipos.editar', 'data-feedback-label': t ? 'Editar equipo' : 'Nuevo equipo' },
      closeAttrs: { 'data-feedback-id': 'central.equipos.editar.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
      body: el('div', { 'data-feedback-id': 'central.equipos.editar.formulario', 'data-feedback-label': 'Formulario del equipo' },
        el('label', { class: 'field', 'data-feedback-id': 'central.equipos.editar.campo_nombre', 'data-feedback-label': 'Nombre' }, el('span', null, 'Nombre'), name),
        el('label', { class: 'field', 'data-feedback-id': 'central.equipos.editar.campo_color', 'data-feedback-label': 'Color' }, el('span', null, 'Color'), color),
        error,
        t ? el('div', { class: 'zone', 'data-feedback-id': 'central.equipos.editar.zona', 'data-feedback-label': 'Zona de peligro' }, el('button', { class: 'danger', type: 'button', id: 'deleteTeam', 'data-feedback-id': 'central.equipos.editar.papelera', 'data-feedback-label': 'Enviar a papelera', onclick: async () => {
          const n = members(t.id);
          if (!(await confirmDialog({ title: `¿Enviar «${t.name}» a la papelera?`, text: n ? `Sus ${n} personas dejan de estar en este equipo (no se borran).` : undefined, confirmLabel: 'Enviar a papelera', danger: true }))) return;
          const ops: RowOperation[] = [
            ...links.filter((x) => x.team_id === t.id && !x.deleted_at).map((x) => ({ op: 'delete' as const, table: T.personTeams, id: x.id, expectedRevision: x.revision })),
            { op: 'delete', table: T.teams, id: t.id, expectedRevision: t.revision },
          ];
          if (await commit(ops, 'Equipo enviado a la papelera.')) await sheet?.close(true);
        } }, icon('trash', 18), 'Enviar a papelera')) : null),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.equipos.editar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save], initialFocus: name,
    });
  }

  async function load(): Promise<void> {
    teams = ((await client.list(T.teams)) as unknown as Team[]).sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name, 'es'));
    links = (await client.list(T.personTeams)) as unknown as PersonTeam[];
    paint();
  }
  void load();
  const offs = [client.onTable(T.teams, () => void load()), client.onTable(T.personTeams, () => void load())];
  return () => offs.forEach((off) => off());
};
