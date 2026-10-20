import type { RowOperation } from '@ikisai/sync-client';
import {
  confirmDialog, createSortableList, el, icon, openSheet, positionBetween, renderMedal, replace, toast, toastWithAction, type Sheet,
} from '@ikisai/ui-kit';
import { SUGGESTED_TEAMS, canSeeReserved, todayInMadrid, validateOperations } from '@ikisai/domain-central';
import { T, describeError } from '../app/client.ts';
import { docTone, type Person, type PersonRecord, type PersonTeam, type Team } from './people.ts';
import type { ViewMount } from './shell.ts';
import { fbIgnoreWithin, fbMark } from './feedback.ts';

const PALETTE = ['#56663f', '#c4712f', '#3d6b8c', '#8c4a6b', '#b7791f', '#2f7a4b'];

/**
 * Equipos (API.md §2.11) · Tablero por equipo (Bloque 2, MUELA-085):
 * - Una columna por equipo con sus personas. Quien gestiona personas (owner y editor con ámbito `people`) añade con
 *   «Añadir a {equipo}» al pie y quita con la ✕, con «Deshacer»; edita nombre y color, y envía a la papelera.
 * - «Lo que les falta» (documentación caducada o por caducar) solo con permiso de datos reservados (§2): sin él, ni se
 *   descarga.
 * - «Ordenar» abre la lista reordenable del kit. Si no hay ninguno, propone los habituales (sin datos en Git).
 * - El lector lo ve sin botones. Funciona sin red, con la cola de sincronización.
 */
export const mountTeams: ViewMount = ({ main, client, navigate }) => {
  const canManage = canSeeReserved(client.bootstrap()?.membership);
  const reserved = canManage;
  let teams: Team[] = [];
  let links: PersonTeam[] = [];
  let people: Person[] = [];
  let records: PersonRecord[] = [];
  const host = el('div', { id: 'teamList', 'data-feedback-id': 'central.equipos.lista', 'data-feedback-label': 'Tablero de equipos' });
  replace(main,
    el('a', { href: '#/personas', class: 'backlink', 'data-feedback-id': 'central.equipos.volver', 'data-feedback-label': 'Volver a Personas' }, '← Personas'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.equipos.cabecera', 'data-feedback-label': 'Cabecera de Equipos' }, el('div', null, el('h2', null, 'Equipos'), el('p', null, 'Grupos de personas: cocina, mantenimiento, dirección… Una persona puede estar en varios.'))),
    canManage ? el('div', { class: 'toolbar' }, el('button', { class: 'ghost', type: 'button', id: 'orderTeams', 'data-feedback-id': 'central.equipos.ordenar', 'data-feedback-label': 'Ordenar equipos', onclick: () => openOrder() }, icon('grip', 16), 'Ordenar')) : null,
    host,
    canManage ? el('button', { class: 'fab', type: 'button', id: 'newTeam', 'data-feedback-id': 'central.equipos.nuevo', 'data-feedback-label': 'Nuevo equipo', onclick: () => openEditor(null) }, icon('plus'), 'Nuevo equipo') : null);

  const memberLinks = (id: string) => links.filter((x) => x.team_id === id && !x.deleted_at);
  const members = (id: string) => memberLinks(id).length;
  const personById = (id: string) => people.find((p) => p.id === id) ?? null;

  async function commit(operations: RowOperation[], ok: string | null): Promise<boolean> {
    const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' });
    if (issue) { toast(issue.message); return false; }
    try {
      await client.commit(operations);
      if (ok) toast(!navigator.onLine ? `${ok} Se sincronizará cuando haya red.` : ok);
      return true;
    } catch (e) { toast(describeError(e)); return false; }
  }

  /** Quitar a alguien de un equipo, con «Deshacer» (borra el vínculo y lo restaura, como la papelera de Personas). */
  async function removeFrom(t: Team, link: PersonTeam): Promise<void> {
    const name = personById(link.person_id)?.display_name ?? 'La persona';
    if (!(await commit([{ op: 'delete', table: T.personTeams, id: link.id, expectedRevision: link.revision }], null))) return;
    toastWithAction(`${name} ya no está en ${t.name}.`, {
      label: 'Deshacer',
      onClick: () => void (async () => {
        const fresh = ((await client.list(T.personTeams, { includeDeleted: true })) as unknown as PersonTeam[]).find((x) => x.id === link.id);
        if (fresh) await commit([{ op: 'restore', table: T.personTeams, id: fresh.id, expectedRevision: fresh.revision }], `${name} vuelve a ${t.name}.`);
      })(),
    });
  }

  function member(t: Team, link: PersonTeam): HTMLElement | null {
    const p = personById(link.person_id);
    if (!p || p.deleted_at) return null;
    const lack = reserved ? docTone(records, p.id, todayInMadrid()) : { tone: null, text: null };
    return el('li', { class: `ctl-member${p.active ? '' : ' inactive'}`, 'data-person': p.id },
      el('a', { href: `#/personas/${p.id}`, class: 'ctl-memberlink', 'data-feedback-id': 'central.equipos.tablero.persona', 'data-feedback-label': 'Persona del equipo', onclick: (e: Event) => { e.preventDefault(); navigate(`#/personas/${p.id}`); } },
        renderMedal({ name: p.display_name, initials: p.initials ?? null, size: 40 }),
        el('span', null, el('span', { class: 'ctl-membername' }, p.display_name),
          !p.active ? el('span', { class: 'muted small' }, 'Inactiva') : null,
          lack.text && lack.tone !== 'ok' ? el('span', { class: `ctl-lack ${lack.tone ?? ''}` }, lack.text) : null)),
      canManage ? el('button', { type: 'button', class: 'ctl-remove', 'aria-label': `Quitar a ${p.display_name} de ${t.name}`, 'data-feedback-id': 'central.equipos.tablero.quitar', 'data-feedback-label': 'Quitar del equipo', onclick: () => void removeFrom(t, link) }, icon('close', 16)) : null);
  }

  function column(t: Team): HTMLElement {
    const list = memberLinks(t.id).map((l) => member(t, l)).filter((x): x is HTMLElement => !!x);
    const lacking = reserved ? memberLinks(t.id).filter((l) => { const tone = docTone(records, l.person_id, todayInMadrid()).tone; return tone === 'alert' || tone === 'warn'; }).length : 0;
    return el('section', { class: 'ctl-teamcol', 'data-team': t.id, style: t.color ? `--team:${t.color}` : null, 'aria-label': t.name, 'data-feedback-id': 'central.equipos.lista.fila', 'data-feedback-label': 'Equipo' },
      el('header', { class: 'ctl-teamhead' },
        el('span', { class: 'chip teamchip', 'data-feedback-id': 'central.equipos.lista.nombre', 'data-feedback-label': 'Nombre del equipo', style: t.color ? `--team:${t.color}` : null }, t.name),
        el('span', { class: 'muted small', 'data-feedback-id': 'central.equipos.lista.miembros', 'data-feedback-label': 'Personas del equipo' }, `${members(t.id)} ${members(t.id) === 1 ? 'persona' : 'personas'}`),
        canManage ? el('button', { class: 'linkbtn', type: 'button', 'aria-label': `Editar ${t.name}`, 'data-feedback-id': 'central.equipos.lista.editar', 'data-feedback-label': 'Editar equipo', onclick: () => openEditor(t) }, 'Editar') : null),
      lacking ? el('p', { class: 'ctl-lack warn' }, `${lacking} con la documentación por revisar`) : null,
      list.length ? el('ul', { class: 'ctl-members' }, ...list) : el('p', { class: 'hint' }, 'Nadie en este equipo.'),
      canManage ? el('button', { type: 'button', class: 'ghost ctl-addto', 'data-feedback-id': 'central.equipos.tablero.anadir', 'data-feedback-label': 'Añadir al equipo', onclick: () => openAdd(t) }, icon('plus', 16), `Añadir a ${t.name}`) : null);
  }

  function paint(): void {
    if (!teams.length) {
      replace(host, el('div', { class: 'empty', 'data-feedback-id': 'central.equipos.vacio', 'data-feedback-label': 'Sin equipos' }, el('strong', null, 'Todavía no hay equipos'),
        canManage ? el('button', { class: 'primary', type: 'button', id: 'seedTeams', 'data-feedback-id': 'central.equipos.vacio.crear_habituales', 'data-feedback-label': 'Crear los equipos habituales', onclick: () => void seed() }, `Crear los habituales: ${SUGGESTED_TEAMS.join(', ')}`) : 'Los crea quien gestiona personas.'));
      return;
    }
    replace(host, fbIgnoreWithin(el('div', { class: 'ctl-board' }, ...teams.map(column)), '.ctl-membername'));
  }

  /** «Añadir a {equipo}»: las personas activas que aún no están, a un toque cada una. */
  function openAdd(t: Team): void {
    let sheet: Sheet | null = null;
    const inside = new Set(memberLinks(t.id).map((l) => l.person_id));
    const candidates = people.filter((p) => !p.deleted_at && p.active && !inside.has(p.id)).sort((a, b) => a.display_name.localeCompare(b.display_name, 'es'));
    const list = el('ul', { class: 'list ctl-addlist' }, ...candidates.map((p) => el('li', null,
      el('button', { type: 'button', class: 'ctl-addrow', 'data-person': p.id, 'data-feedback-id': 'central.equipos.anadir.persona', 'data-feedback-label': 'Añadir esta persona',
        onclick: async () => { if (await commit([{ op: 'insert', table: T.personTeams, id: crypto.randomUUID(), fields: { person_id: p.id, team_id: t.id } }], `${p.display_name} está ya en ${t.name}.`)) void sheet?.close(true); } },
        renderMedal({ name: p.display_name, initials: p.initials ?? null, size: 40 }), el('span', { 'data-feedback-ignore': '' }, p.display_name)))));
    sheet = openSheet({
      title: `Añadir a ${t.name}`,
      body: candidates.length ? list : el('p', { class: 'hint' }, 'Todas las personas activas están ya en este equipo.'),
      panelAttrs: { 'data-feedback-id': 'central.equipos.anadir', 'data-feedback-label': 'Añadir al equipo' },
      closeAttrs: { 'data-feedback-id': 'central.equipos.anadir.cerrar', 'data-feedback-label': 'Cerrar' },
    });
  }

  /** «Ordenar»: el orden de los equipos (el de las columnas y el de los filtros), con la lista reordenable del kit. */
  function openOrder(): void {
    const sortable = createSortableList<Team>({
      items: teams, key: (t) => t.id, render: (t) => el('span', { class: 'chip teamchip', style: t.color ? `--team:${t.color}` : null }, t.name), name: (t) => t.name, label: 'Equipos', id: 'teamsSortable',
      onReorder: async (items, move) => {
        const position = positionBetween(items[move.to - 1]?.position ?? null, items[move.to + 1]?.position ?? null);
        await commit([{ op: 'update', table: T.teams, id: move.item.id, expectedRevision: move.item.revision, fields: { position } }], 'Orden guardado.');
      },
    });
    openSheet({
      title: 'Ordenar equipos',
      body: el('div', null, el('p', { class: 'muted small' }, 'Arrastra o usa las flechas para ordenar.'), fbMark(sortable.element, 'central.equipos.lista.ordenable', 'Equipos ordenables')),
      panelAttrs: { 'data-feedback-id': 'central.equipos.orden', 'data-feedback-label': 'Ordenar equipos' },
      closeAttrs: { 'data-feedback-id': 'central.equipos.orden.cerrar', 'data-feedback-label': 'Cerrar' },
    });
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
            ...memberLinks(t.id).map((x) => ({ op: 'delete' as const, table: T.personTeams, id: x.id, expectedRevision: x.revision })),
            { op: 'delete', table: T.teams, id: t.id, expectedRevision: t.revision },
          ];
          if (await commit(ops, 'Equipo enviado a la papelera.')) await sheet?.close(true);
        } }, icon('trash', 18), 'Enviar a papelera')) : null),
      foot: [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.equipos.editar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, 'Cancelar'), save], initialFocus: name,
    });
  }

  async function load(): Promise<void> {
    const [t, l, p, r] = await Promise.all([
      client.list(T.teams), client.list(T.personTeams), client.list(T.people),
      reserved ? client.list(T.personRecords).catch(() => []) : Promise.resolve([]),
    ]);
    teams = (t as unknown as Team[]).sort((a, b) => (a.position - b.position) || a.name.localeCompare(b.name, 'es'));
    links = l as unknown as PersonTeam[];
    people = p as unknown as Person[];
    records = r as unknown as PersonRecord[];
    paint();
  }
  void load();
  const offs = [T.teams, T.personTeams, T.people, ...(reserved ? [T.personRecords] : [])].map((name) => client.onTable(name, () => void load()));
  return () => offs.forEach((off) => off());
};
