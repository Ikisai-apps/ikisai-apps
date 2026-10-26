/**
 * Pestaña «Experiencia» (fases 4 y 5, API.md §15.3; pasada única, zona 3): lo que ven y hacen tus asistentes en su enlace
 * personal de Ikisai Guests, en seis apartados con ruta propia (`#/retiro/{id}/experiencia/{apartado}`):
 * - «Qué ven»: lo siguiente que conviene hacer y los apartados por momentos (antes, durante y después del retiro), cada
 *   uno con su estado escrito y su casilla «Lo ven tus asistentes»; el mensaje de bienvenida y la vista previa (O6);
 * - «Programa» (Booking), «Menú» (Food) y «Alojamiento» (Booking y la configuración propia);
 * - «Materiales» (archivos, enlaces y textos) y «Preguntas» con sus respuestas y CSV.
 * Lo propio vive en el espejo local (`app/own.ts`): se guarda solo, también sin red, y la cola lo envía al volver. Cambiar
 * de apartado no vuelve a montar la ficha del retiro (evento `org-exp-section` desde `shell.ts`).
 */
import { compressImage, confirmDialog, createSaveState, el, icon, openSheet, renderSteps, replace, toast, type Child, type IconName, type StepItem } from '@ikisai/ui-kit';
import type { RowOperation } from '@ikisai/sync-client';
import { answerText, MATERIAL_MAX_BYTES, sensitiveQuestion, toCsv } from '../../../../supabase/functions/_domain/organizers/mod.ts';
import type { ReservationStatus } from '../app/api.ts';
import { describeError, errorCode } from '../app/client.ts';
import { MODULE_OF, sectionsOf, stepsOf, type SectionKey, type SectionsInput, type SectionState, type SectionStateName } from '../app/experience-state.ts';
import { L, t } from '../app/i18n.ts';
import { fileIdOf, libraryOf, nextPosition, proposes, rowsOf, save, TABLES, watch, type Row } from '../app/own.ts';
import { uploadNow } from '../app/upload-now.ts';
import { fbIgnore, fbMark, loading, needsNet, section } from './common.ts';
import { renderLodging } from './lodging.ts';
import { renderMenu, type PortalMenu } from './menu.ts';
import { renderProgram, type PortalProgram } from './program.ts';
import { typing } from './offers.ts';
import type { ViewContext } from './shell.ts';

const WINDOWS: Array<[string, string]> = [['always', L('Siempre')], ['before', L('Antes del retiro')], ['during', L('Durante el retiro')], ['after', L('Después del retiro')]];
const TYPES: Array<[string, string]> = [['text', L('Texto libre')], ['choice', L('Una opción')], ['multi', L('Varias opciones')], ['yes_no', L('Sí o no')], ['number', L('Número')], ['date', L('Fecha')]];
const KINDS: Record<string, string> = { file: L('Archivo'), link: L('Enlace'), text: L('Texto') };
const KIND_ICON: Record<string, string> = { file: 'attach', link: 'copy', text: 'list' };
const label = (pairs: Array<[string, string]>, key: unknown) => t(pairs.find(([k]) => k === key)?.[1] ?? '');
const options = (pairs: Array<[string, string]>, current: unknown) => pairs.map(([v, l]) => el('option', { value: v, selected: v === current ? '' : null }, t(l)));
const slug = (text: string) => text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'opcion';

export type ExperienceSection = 'ven' | 'programa' | 'menu' | 'alojamiento' | 'materiales' | 'preguntas';
const SECTIONS: Array<[ExperienceSection, string]> = [['ven', L('Qué ven')], ['programa', L('Programa')], ['menu', L('Menú')], ['alojamiento', L('Alojamiento')], ['materiales', L('Materiales')], ['preguntas', L('Preguntas')]];
const SECTION_KEY = 'ikisai-organizers-experience-section';
const isSection = (k: unknown): k is ExperienceSection => SECTIONS.some(([s]) => s === k);
/** El apartado de la URL (`#/retiro/{id}/experiencia/{apartado}`), si lo hay. */
const sectionInUrl = (): ExperienceSection | null => {
  const m = location.hash.match(/\/experiencia\/([a-z]+)$/i);
  const k = m?.[1]?.toLowerCase();
  return isSection(k) ? k : null;
};

type RowKey = SectionKey | 'respuestas';
const ROW_TITLE: Record<RowKey, string> = {
  programa: L('Programa'), menu: L('Menú'), alojamiento: L('Alojamiento'), materiales: L('Materiales'), preguntas: L('Preguntas'), plano: L('Plano de Ikisai'), respuestas: L('Respuestas'),
};
const ROW_ICON: Record<RowKey, IconName> = { programa: 'calendar', menu: 'chef', alojamiento: 'bed', materiales: 'attach', preguntas: 'help', plano: 'pin', respuestas: 'list' };
/** El estado de cada apartado dicho con texto (además del color). */
const STATE_LABEL: Record<SectionStateName, string> = {
  ok: L('Lo ven'), hidden: L('No lo ven'), todo: L('Por hacer'), later: L('Más adelante'), vacio: L('Vacío'), unknown: L('Sin datos'), loading: L('…'),
};
/** Forma de `booking.portal_rooms` que necesita la portada (el resto lo pinta `lodging.ts`). */
type RoomsRead = Exclude<SectionsInput['rooms'], null | { error: string }>;

interface ChoiceOption { value: string; label: string }

export function renderExperience(ctx: ViewContext, reservationId: string, status?: ReservationStatus): HTMLElement {
  const saves = createSaveState({ savedMs: 4000 });
  const modulesHost = el('div', { id: 'expModulesHost' });
  const materialsHost = el('div', { id: 'expMaterialsHost' });
  const questionsHost = el('div', { id: 'expQuestionsHost' });
  const otherHost = el('div', { id: 'expOtherHost' });
  const nav = el('nav', { class: 'orgsubnav', 'aria-label': t('Apartados de la experiencia') });
  // Apartado inicial: el de la URL; si no, el último de esta sesión («vuelta al último apartado»); si no, «Qué ven».
  const fromUrl = sectionInUrl();
  let current: ExperienceSection = fromUrl ?? (() => { try { const s = sessionStorage.getItem(SECTION_KEY); return isSection(s) ? s : 'ven'; } catch { return 'ven'; } })();
  const remember = (k: ExperienceSection) => { try { sessionStorage.setItem(SECTION_KEY, k); } catch { /* sin almacenamiento */ } };
  remember(current);
  /** Al llegar por URL a un apartado, el foco va a su título. */
  let focusPending = !!fromUrl;
  let other: (HTMLElement & { destroy?: () => void }) | null = null;
  const host = el('div', { id: 'experience', 'data-feedback-id': 'organizers.experiencia', 'data-feedback-label': 'Experiencia' }, loading());
  let alive = true;
  let exp: Row | null = null;
  let materials: Row[] = [];
  let questions: Row[] = [];
  let answers: Row[] = [];
  let painted = false;
  /** Los cambios de la experiencia van en fila: el primero crea la fila y los siguientes la actualizan. */
  let queue: Promise<void> = Promise.resolve();
  let messageTimer: ReturnType<typeof setTimeout> | null = null;
  // Lecturas de la portada (Booking y Food, con caché): `null` mientras se leen; `{ error }` sin red y sin copia.
  let program: SectionsInput['program'] = null;
  let menu: SectionsInput['menu'] = null;
  let rooms: SectionsInput['rooms'] = null;
  let comments: number | null = null;
  /** Botones de la portada atados a la red (vista previa): se sueltan al repintar y al salir. */
  let modulesBound: Array<() => void> = [];

  async function read(): Promise<void> {
    const [e, m, q, a] = await Promise.all([
      rowsOf(ctx.client, TABLES.experiences, reservationId), rowsOf(ctx.client, TABLES.materials, reservationId),
      rowsOf(ctx.client, TABLES.questions, reservationId), rowsOf(ctx.client, TABLES.answers, reservationId),
    ]);
    exp = e[0] ?? null; materials = m; questions = q; answers = a;
  }

  /** Programa, menú, habitaciones y comentarios a cocina, en paralelo y después de pintar. */
  async function loadExtra(): Promise<void> {
    const failed = (error: unknown) => ({ error: errorCode(error) || 'ERROR' });
    const args = { reservation_id: reservationId };
    const [p, m, r, c] = await Promise.all([
      ctx.api.readAny<PortalProgram>('booking.portal_program', args).then((x) => x.value, failed),
      ctx.api.readAny<PortalMenu>('food.portal_menu', args).then((x) => x.value, failed),
      ctx.api.readAny<RoomsRead>('booking.portal_rooms', args).then((x) => x.value, failed),
      ctx.api.readAny<{ items: unknown[] }>('food.portal_my_menu_comments', args).then((x) => x.value.items.length, () => null),
    ]);
    program = p; menu = m; rooms = r; comments = c;
    if (!alive) return;
    paintNav();
    if (!(modulesHost.contains(document.activeElement) && typing())) paintModules();
  }

  const sections = () => sectionsOf({ exp, materials, questions, answers, program, menu, rooms, comments });
  const windowLabel = (w: string | undefined) => (w ? label(WINDOWS, w) : '');
  const stateText = (st: SectionState) => (st.state === 'ok' && st.window ? windowLabel(st.window) : t(STATE_LABEL[st.state]));
  const sectionText = (st: SectionState) => [t(st.textKey, st.vars), st.extraKey ? t(st.extraKey, st.extraVars) : ''].filter(Boolean).join(' · ');

  function track(run: () => Promise<void>): Promise<void> {
    return saves.track('experiencia', run(), { retry: () => track(run) }).catch((error) => { toast(describeError(error)); });
  }

  function setExperience(fields: Record<string, unknown>): Promise<void> {
    queue = queue.then(() => track(async () => {
      const current = (await rowsOf(ctx.client, TABLES.experiences, reservationId))[0] ?? null;
      const ops: RowOperation[] = current
        ? [{ op: 'update', table: TABLES.experiences, id: current.id, expectedRevision: current.revision, fields }]
        : [{ op: 'insert', table: TABLES.experiences, id: crypto.randomUUID(), fields: { reservation_id: reservationId, ...fields } }];
      await ctx.usage.run('organizers.experiencia.guardar', () => save(ctx.client, ops, current ? [current] : []));
      exp = (await rowsOf(ctx.client, TABLES.experiences, reservationId))[0] ?? null;
    }));
    return queue;
  }

  // --- Qué ven tus asistentes: lo siguiente, los tres momentos y la vista previa ----------------------------------------
  function paintModules(): void {
    for (const off of modulesBound.splice(0)) off();
    const s = sections();
    const value = (key: string, fallback: unknown) => (exp && exp[key] !== undefined && exp[key] !== null ? exp[key] : fallback);
    const windowSelect = (key: string) => el('select', { id: `exp-${key}`, 'aria-label': t('Cuándo lo ven'),
      onchange: (e: Event) => void setExperience({ [key]: (e.target as HTMLSelectElement).value }).then(paintModules) }, ...options(WINDOWS, value(key, 'always')));
    /** La casilla de siempre, fuera del botón de la fila (con Espacio se marca sin abrir el apartado). */
    const moduleRow = (key: string, windowKey?: string) => {
      const on = value(key, false) === true;
      return el('div', { class: 'orgmodule', 'data-module': key },
        el('label', { class: 'field check' },
          el('input', { type: 'checkbox', id: `exp-${key}`, checked: on ? '' : null, onchange: (e: Event) => { void setExperience({ [key]: (e.target as HTMLInputElement).checked }).then(paintModules); } }),
          el('span', null, t('Lo ven tus asistentes'))),
        on && windowKey ? el('label', { class: 'field orgmodule-window' }, el('span', null, t('Cuándo lo ven')), windowSelect(windowKey)) : null);
    };
    const row = (k: RowKey, st: SectionState | null, text: string, openTo: ExperienceSection | null, withModule: boolean, windowKey?: string) => {
      const inner: Child[] = [
        el('span', { class: 'orgexp-icon', 'aria-hidden': 'true' }, icon(ROW_ICON[k], 20)),
        el('span', { class: 'orgexp-text' }, el('strong', null, t(ROW_TITLE[k])), el('span', { class: 'small' }, text)),
        st ? el('span', { class: `chip orgexp-state ${st.state}` }, stateText(st)) : null,
      ];
      const state = st?.state ?? 'ok';
      return fbMark(el('li', { class: `orgexp-row ${state}`, 'data-section': k },
        openTo
          ? el('button', { type: 'button', class: 'orgexp-open', onclick: () => go(openTo) }, ...inner, el('span', { class: 'orgexp-chev', 'aria-hidden': 'true' }, '›'))
          : el('div', { class: 'orgexp-open static' }, ...inner),
        withModule && k !== 'respuestas' ? moduleRow(MODULE_OF[k], windowKey) : null), 'organizers.experiencia.apartado', 'Apartado de la experiencia');
    };
    const sectionRow = (k: SectionKey, openTo: ExperienceSection | null, windowKey?: string) => row(k, s[k], sectionText(s[k]), openTo, true, windowKey);
    const r = answers.length;
    const answersRow = row('respuestas', null, r === 1 ? t('1 respuesta · descárgala en CSV') : t('{r} respuestas · descárgalas en CSV', { r }), 'preguntas', false);

    // Lo siguiente.
    const nextBox = fbMark(el('div', { id: 'expNext', class: 'orgexp-next' }), 'organizers.experiencia.siguiente', 'Siguiente paso de la experiencia');
    const keys = stepsOf(s);
    if (status === 'cerrada') {
      replace(nextBox, el('p', { class: 'orgexp-nextline' }, el('strong', null, t('El retiro ya terminó')), el('span', { class: 'muted small' }, t('Las respuestas y los materiales siguen aquí.'))));
    } else if ([s.programa, s.menu, s.alojamiento].some((x) => x.state === 'loading') && !keys.length) {
      replace(nextBox, loading());
    } else if (!keys.length) {
      replace(nextBox, el('p', { class: 'orgexp-nextline' }, el('strong', null, t('Por ahora, nada que hacer aquí')),
        el('span', { class: 'muted small' }, t('Programa y alojamiento, cuando la reserva esté confirmada. Ya puedes escribir la bienvenida y preparar preguntas y materiales.'))));
    } else {
      const item = (k: SectionKey): StepItem => {
        const st = s[k];
        if (st.state === 'hidden') {
          return { id: k, title: t('{que}: publicado, pero tus asistentes no lo ven', { que: t(ROW_TITLE[k]) }), done: false, stateText: sectionText(st), action: t('Mostrárselo'),
            onClick: () => void setExperience({ [MODULE_OF[k]]: true }).then(paintModules) };
        }
        if (st.state === 'todo') return { id: k, title: t(st.nextKey ?? ROW_TITLE[k]), done: false, stateText: sectionText(st), action: t('Abrir'), href: `#/retiro/${reservationId}/experiencia/${k}` };
        return { id: k, title: t(ROW_TITLE[k]), done: true, stateText: sectionText(st) };
      };
      replace(nextBox, renderSteps({ items: keys.map(item), readyText: t('Lo que preparas les llega a su enlace.') }));
    }

    const message = el('textarea', { id: 'exp-message', rows: '3', maxlength: '1000', placeholder: t('Os esperamos en Ikisai…'),
      oninput: (e: Event) => {
        const text = (e.target as HTMLTextAreaElement).value;
        if (messageTimer) clearTimeout(messageTimer);
        saves.set('experiencia', 'pending');
        messageTimer = setTimeout(() => { messageTimer = null; void setExperience({ organizer_message: text.trim() ? text : null }); }, 800);
      } }, String(value('organizer_message', ''))) as HTMLTextAreaElement;
    const messageBox = fbMark(section(t('Mensaje de bienvenida'), { id: 'expMessage' },
      el('p', { class: 'muted small' }, t('Lo verán al abrir su enlace. Opcional.')),
      fbIgnore(el('label', { class: 'field' }, el('span', null, t('Mensaje')), message)),
      el('label', { class: 'field' }, el('span', null, t('Idioma del mensaje')),
        el('select', { id: 'exp-message-lang', onchange: (e: Event) => void setExperience({ message_lang: (e.target as HTMLSelectElement).value }) },
          el('option', { value: 'es', selected: value('message_lang', 'es') === 'es' ? '' : null }, 'Español'),
          el('option', { value: 'en', selected: value('message_lang', 'es') === 'en' ? '' : null }, 'English')))), 'organizers.experiencia.mensaje', 'Mensaje de bienvenida');

    const moment = (title: string, text: string, rows: HTMLElement[], extra?: HTMLElement) => el('li', { class: 'orgexp-moment' },
      el('h3', null, t(title)), el('p', { class: 'muted small' }, t(text)), el('ul', { class: 'orgexp-rows' }, ...rows), extra ?? null);

    const previewButton = el('button', { type: 'button', class: 'ghost', id: 'expPreviewOpen', onclick: () => void openPreview() }, icon('eye', 16), ' ', t('Ver como un asistente'));
    replace(modulesHost,
      nextBox,
      fbMark(el('section', { id: 'expModules', class: 'orgexp-home' },
        el('p', { class: 'muted' }, t('Elige qué aparece en el enlace personal de cada asistente. Sus datos, la firma y la alimentación los ven siempre.')),
        el('ol', { class: 'orgexp-moments' },
          moment(L('Antes del retiro'), L('Lo que les llega al recibir su enlace: bienvenida, preguntas, qué traer y su cama.'),
            [sectionRow('preguntas', 'preguntas'), sectionRow('materiales', 'materiales'), sectionRow('alojamiento', 'alojamiento'), sectionRow('menu', 'menu', 'menu_window')], messageBox),
          moment(L('Durante el retiro'), L('Lo que consultan allí: el horario y cómo moverse por el centro.'),
            [sectionRow('programa', 'programa', 'program_window'), sectionRow('plano', null)]),
          moment(L('Después del retiro'), L('Las respuestas que te dejaron y los materiales que quieras conservar.'), [answersRow]))),
      'organizers.experiencia.modulos', 'Qué ven tus asistentes'),
      fbMark(section(t('Vista previa'), { id: 'expPreview' },
        el('p', { class: 'muted small' }, t('Abre el enlace de un asistente de muestra para ver exactamente lo que verán. No se guarda nada de lo que hagas ahí.')),
        previewButton), 'organizers.experiencia.vista_previa', 'Vista previa'));
    modulesBound.push(needsNet(ctx, previewButton, t('La vista previa necesita conexión.')));
  }

  /** O6: enlace de Guests de solo lectura al huésped de muestra de la reserva (Booking BG11, núcleo C9). */
  async function openPreview(): Promise<void> {
    // La ventana se abre antes de esperar a la red: si no, el navegador la bloquea por no venir de un toque.
    const win = window.open('', '_blank');
    try {
      const sample = await ctx.api.invokeAny<{ guest_id: string }>('booking.portal_preview_guest', { reservation_id: reservationId });
      const link = await ctx.usage.run('organizers.experiencia.vista_previa', () => ctx.api.previewLink(reservationId, sample.guest_id, t('Vista previa')));
      if (win) win.location.href = link.url; else window.open(link.url, '_blank', 'noopener');
    } catch (error) {
      win?.close();
      toast(describeError(error));
    }
  }

  // --- Materiales -----------------------------------------------------------------------------------------------------
  const fileInput = el('input', { type: 'file', accept: 'application/pdf,image/png,image/jpeg,image/webp', hidden: '', id: 'expUploadInput', onchange: () => void upload() }) as HTMLInputElement;

  async function upload(): Promise<void> {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    try {
      let blob: Blob = file;
      let name = file.name;
      let mime = file.type;
      if (['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        const out = await compressImage(file, { thumbSide: 0 });
        blob = out.full; mime = out.mime; name = out.filename;
      } else if (file.type !== 'application/pdf') {
        toast(t('Solo se pueden subir PDF e imágenes PNG, JPG o WebP.')); return;
      }
      if (blob.size > MATERIAL_MAX_BYTES) { toast(t('El archivo pasa de 15 MB. Prueba con uno más ligero.')); return; }
      // Quien organiza lo encola (se sube al volver la red). Dirección, que propone (0703), lo sube ya: la propuesta lleva el
      // archivo verificado, porque una sugerencia no viaja con la cola de subidas.
      const fileRef = proposes(ctx.client, reservationId)
        ? await uploadNow(ctx.client, blob, { filename: name, mime })
        : { $blob: await ctx.client.stageBlob(blob, { filename: name, mime }) };
      const id = crypto.randomUUID();
      const title = file.name.replace(/\.[^.]+$/, '').slice(0, 160) || t('Documento');
      await track(() => ctx.usage.run('organizers.experiencia.material_subir', () => save(ctx.client, [{ op: 'insert', table: TABLES.materials, id,
        fields: { reservation_id: reservationId, owner_id: ctx.userId, kind: 'file', title, file_id: fileRef, published: false, window: 'always', position: nextPosition(materials) } }])));
      await read();
      paintMaterials();
      const row = materials.find((m) => m.id === id);
      if (row) editMaterial(row);
    } catch (error) {
      toast(describeError(error));
    }
  }

  function moveButtons(rows: Row[], row: Row, table: typeof TABLES.materials | typeof TABLES.questions, done: () => void): HTMLElement {
    const i = rows.indexOf(row);
    const swap = (j: number) => async () => {
      const other = rows[j];
      if (!other) return;
      await track(() => save(ctx.client, [
        { op: 'update', table, id: row.id, expectedRevision: row.revision, fields: { position: Number(other.position) || j + 1 } },
        { op: 'update', table, id: other.id, expectedRevision: other.revision, fields: { position: Number(row.position) || i + 1 } },
      ], rows));
      await read(); done();
    };
    return el('span', { class: 'orgmove' },
      el('button', { type: 'button', class: 'ghost icon', 'aria-label': t('Subir'), disabled: i === 0 ? '' : null, onclick: swap(i - 1) }, icon('chevronUp', 16)),
      el('button', { type: 'button', class: 'ghost icon', 'aria-label': t('Bajar'), disabled: i === rows.length - 1 ? '' : null, onclick: swap(i + 1) }, icon('chevronDown', 16)));
  }

  function paintMaterials(): void {
    const items = materials.map((m) => el('div', { class: 'orgitem', 'data-material': m.id },
      el('button', { type: 'button', class: 'orgitem-main', onclick: () => editMaterial(m) },
        icon(KIND_ICON[String(m.kind)] ?? 'list', 18),
        el('span', null,
          el('strong', null, String(m.title)),
          el('span', { class: 'muted small' }, ` · ${t(KINDS[String(m.kind)] ?? '')}`, m.is_logo ? ` · ${t('Logotipo')}` : '', ` · ${m.published ? label(WINDOWS, m.window) : t('Sin publicar')}`))),
      moveButtons(materials, m, TABLES.materials, paintMaterials)));
    replace(materialsHost, fbMark(section(t('Materiales'), { id: 'expMaterials' },
      el('p', { class: 'muted small' }, t('Programa en PDF, fotos, el enlace al grupo de WhatsApp o Telegram, una lista de qué traer… Tus asistentes los ven cuando los publicas.')),
      items.length ? el('div', { class: 'orgitems' }, ...items) : el('p', { class: 'muted', id: 'expMaterialsEmpty' }, t('Aún no has añadido materiales.')),
      el('div', { class: 'choices left' },
        el('button', { type: 'button', class: 'ghost', id: 'expUpload', onclick: () => fileInput.click() }, icon('upload', 16), ' ', t('Subir archivo')),
        el('button', { type: 'button', class: 'ghost', id: 'expAddLink', onclick: () => editMaterial(null, 'link') }, icon('plus', 16), ' ', t('Enlace')),
        el('button', { type: 'button', class: 'ghost', id: 'expAddText', onclick: () => editMaterial(null, 'text') }, icon('plus', 16), ' ', t('Texto')),
        el('button', { type: 'button', class: 'ghost', id: 'expLibraryMaterials', onclick: () => void fromLibrary(TABLES.materials) }, icon('history', 16), ' ', t('De otros retiros'))),
      fileInput), 'organizers.experiencia.materiales', 'Materiales'));
  }

  function editMaterial(row: Row | null, newKind: 'link' | 'text' = 'link'): void {
    const kind = row ? String(row.kind) : newKind;
    const title = el('input', { type: 'text', id: 'mat-title', maxlength: '160', required: '', value: String(row?.title ?? '') }) as HTMLInputElement;
    const description = el('textarea', { id: 'mat-description', rows: '2', maxlength: '1000' }, String(row?.description ?? '')) as HTMLTextAreaElement;
    const url = el('input', { type: 'url', id: 'mat-url', maxlength: '600', placeholder: 'https://', value: String(row?.url ?? '') }) as HTMLInputElement;
    const body = el('textarea', { id: 'mat-body', rows: '6', maxlength: '4000' }, String(row?.body ?? '')) as HTMLTextAreaElement;
    const published = el('input', { type: 'checkbox', id: 'mat-published', checked: row?.published ? '' : null }) as HTMLInputElement;
    const windowSel = el('select', { id: 'mat-window' }, ...options(WINDOWS, row?.window ?? 'always')) as HTMLSelectElement;
    const logo = el('input', { type: 'checkbox', id: 'mat-logo', checked: row?.is_logo ? '' : null }) as HTMLInputElement;
    const error = el('p', { class: 'error', role: 'alert', id: 'mat-error' });
    const fileId = row ? fileIdOf(row.file_id) : null;
    const sheet = openSheet({
      title: row ? t('Material') : kind === 'link' ? t('Nuevo enlace') : t('Nuevo texto'),
      panelAttrs: { id: 'materialSheet' },
      body: el('form', { id: 'materialForm', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        el('label', { class: 'field' }, el('span', null, t('Título')), title),
        kind === 'link' ? el('label', { class: 'field' }, el('span', null, t('Enlace')), url) : null,
        kind === 'text' ? el('label', { class: 'field' }, el('span', null, t('Texto')), body) : null,
        kind === 'file' ? el('p', null, fileId
          ? el('button', { type: 'button', class: 'ghost', id: 'mat-open', onclick: () => void ctx.client.fileUrl(fileId).then((u) => window.open(u, '_blank', 'noopener')).catch((e) => toast(describeError(e))) }, icon('eye', 16), ' ', t('Abrir'))
          : el('span', { class: 'muted small' }, t('Se subirá cuando haya conexión.'))) : null,
        el('label', { class: 'field' }, el('span', null, t('Descripción (opcional)')), description),
        el('label', { class: 'field check' }, published, el('span', null, t('Publicado: lo ven tus asistentes'))),
        el('label', { class: 'field' }, el('span', null, t('Cuándo lo ven')), windowSel),
        kind === 'file' ? el('label', { class: 'field check' }, logo, el('span', null, t('Es mi logotipo (para el cartel; no se publica)'))) : null,
        error),
      foot: el('div', { class: 'choices' },
        row ? el('button', { type: 'button', class: 'ghost danger', id: 'mat-delete', onclick: () => void remove() }, t('Quitar')) : null,
        el('button', { type: 'submit', class: 'primary', form: 'materialForm', id: 'mat-save' }, t('Guardar'))),
    });
    async function submit(): Promise<void> {
      const fields: Record<string, unknown> = {
        title: title.value.trim(), description: description.value.trim() || null, published: logo.checked ? false : published.checked,
        window: windowSel.value, ...(kind === 'link' ? { url: url.value.trim() || null } : {}), ...(kind === 'text' ? { body: body.value.trim() || null } : {}),
        ...(kind === 'file' ? { is_logo: logo.checked } : {}),
      };
      const ops: RowOperation[] = [];
      // Un logotipo por retiro: el anterior deja de serlo.
      if (logo.checked) for (const other of materials.filter((m) => m.is_logo && m.id !== row?.id)) ops.push({ op: 'update', table: TABLES.materials, id: other.id, expectedRevision: other.revision, fields: { is_logo: false } });
      ops.push(row
        ? { op: 'update', table: TABLES.materials, id: row.id, expectedRevision: row.revision, fields }
        : { op: 'insert', table: TABLES.materials, id: crypto.randomUUID(), fields: { reservation_id: reservationId, owner_id: ctx.userId, kind, position: nextPosition(materials), ...fields } });
      try {
        await ctx.usage.run('organizers.experiencia.material_guardar', () => save(ctx.client, ops, materials));
        await sheet.close(true);
        await read(); paintMaterials();
      } catch (e) {
        error.textContent = materialError(e);
      }
    }
    async function remove(): Promise<void> {
      if (!row || !(await confirmDialog({ title: t('¿Quitar este material?'), text: t('Tus asistentes dejarán de verlo.'), confirmLabel: t('Quitar'), danger: true }))) return;
      try {
        await ctx.usage.run('organizers.experiencia.material_quitar', () => save(ctx.client, [{ op: 'delete', table: TABLES.materials, id: row.id, expectedRevision: row.revision }], [row]));
        await sheet.close(true);
        await read(); paintMaterials();
      } catch (e) { error.textContent = describeError(e); }
    }
  }

  // --- Preguntas ------------------------------------------------------------------------------------------------------
  function paintQuestions(): void {
    const items = questions.map((q) => {
      const count = answers.filter((a) => a.question_id === q.id).length;
      return el('div', { class: 'orgitem', 'data-question': q.id },
        el('button', { type: 'button', class: 'orgitem-main', onclick: () => editQuestion(q) },
          icon('help', 18),
          el('span', null,
            el('strong', null, String(q.label)),
            el('span', { class: 'muted small' }, ` · ${label(TYPES, q.type)}`, q.required ? ` · ${t('Obligatoria')}` : '', ` · ${q.published ? t('Publicada') : t('Sin publicar')}`,
              ` · ${count === 1 ? t('1 respuesta') : t('{n} respuestas', { n: count })}`))),
        moveButtons(questions, q, TABLES.questions, paintQuestions));
    });
    replace(questionsHost, fbMark(section(t('Preguntas a tus asistentes'), { id: 'expQuestions' },
      el('p', { class: 'muted small' }, t('Turno de yoga, si vienen en coche, talla de camiseta… Lo verán en su enlace y tú, sus respuestas.')),
      el('p', { class: 'banner info small' }, t('No preguntes por salud, alergias ni documentos: eso ya lo pide Ikisai con el consentimiento de cada asistente.')),
      items.length ? el('div', { class: 'orgitems' }, ...items) : el('p', { class: 'muted', id: 'expQuestionsEmpty' }, t('Aún no has creado preguntas.')),
      el('div', { class: 'choices left' },
        el('button', { type: 'button', class: 'ghost', id: 'expAddQuestion', onclick: () => editQuestion(null) }, icon('plus', 16), ' ', t('Nueva pregunta')),
        el('button', { type: 'button', class: 'ghost', id: 'expLibraryQuestions', onclick: () => void fromLibrary(TABLES.questions) }, icon('history', 16), ' ', t('De otros retiros')),
        questions.length ? el('button', { type: 'button', class: 'ghost', id: 'expAnswers', onclick: () => void showAnswers() }, icon('eye', 16), ' ', t('Ver respuestas')) : null)),
      'organizers.experiencia.preguntas', 'Preguntas'));
  }

  function editQuestion(row: Row | null): void {
    const answered = row ? answers.some((a) => a.question_id === row.id) : false;
    const type = el('select', { id: 'q-type', disabled: answered ? '' : null, onchange: () => paintOptions() }, ...options(TYPES, row?.type ?? 'text')) as HTMLSelectElement;
    const text = el('input', { type: 'text', id: 'q-label', maxlength: '300', required: '', value: String(row?.label ?? ''), oninput: () => warn() }) as HTMLInputElement;
    const help = el('input', { type: 'text', id: 'q-help', maxlength: '600', value: String(row?.help ?? ''), oninput: () => warn() }) as HTMLInputElement;
    const opts = el('textarea', { id: 'q-options', rows: '4', placeholder: t('Una opción por línea'), disabled: answered ? '' : null },
      ((row?.options as ChoiceOption[] | undefined) ?? []).map((o) => o.label).join('\n')) as HTMLTextAreaElement;
    const optsField = el('label', { class: 'field' }, el('span', null, t('Opciones (una por línea, de 2 a 12)')), opts);
    const required = el('input', { type: 'checkbox', id: 'q-required', checked: row?.required ? '' : null }) as HTMLInputElement;
    const published = el('input', { type: 'checkbox', id: 'q-published', checked: row?.published ? '' : null }) as HTMLInputElement;
    const closes = el('input', { type: 'date', id: 'q-closes', value: String(row?.closes_at ?? '') }) as HTMLInputElement;
    const sensitive = el('p', { class: 'banner warn small', id: 'q-sensitive', hidden: '' }, t('Parece que preguntas por salud, alergias o documentos. Eso ya lo pide Ikisai a cada asistente con su consentimiento: mejor no lo preguntes aquí.'));
    const error = el('p', { class: 'error', role: 'alert', id: 'q-error' });
    const paintOptions = () => { optsField.hidden = !['choice', 'multi'].includes(type.value); };
    const warn = () => { sensitive.hidden = !sensitiveQuestion(`${text.value} ${help.value}`); };
    paintOptions(); warn();
    const sheet = openSheet({
      title: row ? t('Pregunta') : t('Nueva pregunta'),
      panelAttrs: { id: 'questionSheet' },
      body: el('form', { id: 'questionForm', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        el('label', { class: 'field' }, el('span', null, t('Pregunta')), text),
        sensitive,
        el('label', { class: 'field' }, el('span', null, t('Aclaración (opcional)')), help),
        el('label', { class: 'field' }, el('span', null, t('Tipo de respuesta')), type),
        answered ? el('p', { class: 'muted small' }, t('Ya hay respuestas: el tipo y las opciones no se pueden cambiar.')) : null,
        optsField,
        el('label', { class: 'field check' }, required, el('span', null, t('Obligatoria'))),
        el('label', { class: 'field' }, el('span', null, t('Se puede responder hasta el (opcional)')), closes),
        el('label', { class: 'field check' }, published, el('span', null, t('Publicada: la ven tus asistentes'))),
        error),
      foot: el('div', { class: 'choices' },
        row ? el('button', { type: 'button', class: 'ghost danger', id: 'q-delete', onclick: () => void remove() }, t('Quitar')) : null,
        el('button', { type: 'submit', class: 'primary', form: 'questionForm', id: 'q-save' }, t('Guardar'))),
    });
    async function submit(): Promise<void> {
      const previous = (row?.options as ChoiceOption[] | undefined) ?? [];
      const choice = ['choice', 'multi'].includes(type.value);
      // Las opciones conservan su clave si ya existían (las respuestas guardan la clave, no el texto).
      const list: ChoiceOption[] = choice ? opts.value.split('\n').map((s) => s.trim()).filter(Boolean).map((labelText) => {
        const same = previous.find((o) => o.label === labelText);
        return { value: same?.value ?? slug(labelText), label: labelText };
      }) : [];
      const seen = new Set<string>();
      for (const o of list) { let v = o.value; let n = 2; while (seen.has(v)) v = `${o.value}_${n++}`; o.value = v; seen.add(v); }
      const fields: Record<string, unknown> = {
        label: text.value.trim(), help: help.value.trim() || null, required: required.checked, published: published.checked, closes_at: closes.value || null,
        ...(answered ? {} : { type: type.value, options: list }),
      };
      const op: RowOperation = row
        ? { op: 'update', table: TABLES.questions, id: row.id, expectedRevision: row.revision, fields }
        : { op: 'insert', table: TABLES.questions, id: crypto.randomUUID(), fields: { reservation_id: reservationId, owner_id: ctx.userId, position: nextPosition(questions), ...fields } };
      try {
        await ctx.usage.run('organizers.experiencia.pregunta_guardar', () => save(ctx.client, [op], questions));
        await sheet.close(true);
        await read(); paintQuestions();
      } catch (e) {
        error.textContent = questionError(e);
      }
    }
    async function remove(): Promise<void> {
      if (!row || !(await confirmDialog({ title: t('¿Quitar esta pregunta?'), text: answered ? t('Ya tiene respuestas: dejarás de verlas aquí.') : t('Tus asistentes dejarán de verla.'), confirmLabel: t('Quitar'), danger: true }))) return;
      try {
        await ctx.usage.run('organizers.experiencia.pregunta_quitar', () => save(ctx.client, [{ op: 'delete', table: TABLES.questions, id: row.id, expectedRevision: row.revision }], [row]));
        await sheet.close(true);
        await read(); paintQuestions();
      } catch (e) { error.textContent = describeError(e); }
    }
  }

  /**
   * Biblioteca (decisión del usuario del 8-10-2026): los materiales, el logotipo y las preguntas que creaste en otros retiros
   * se conservan en tu cuenta y se copian a este. Las respuestas nunca se copian.
   */
  async function fromLibrary(table: typeof TABLES.materials | typeof TABLES.questions): Promise<void> {
    const isMaterial = table === TABLES.materials;
    const here = isMaterial ? materials : questions;
    const keyOf = (r: Row) => `${String(r.title ?? r.label)}|${fileIdOf(r.file_id) ?? ''}`;
    const seen = new Set(here.map(keyOf));
    const all = await libraryOf(ctx.client, table, ctx.userId, reservationId);
    const items = all.filter((r) => { const k = keyOf(r); if (seen.has(k)) return false; seen.add(k); return true; });
    const picked = new Set<string>();
    const COPY = isMaterial
      ? ['kind', 'title', 'description', 'file_id', 'url', 'body', 'is_logo', 'window']
      : ['type', 'label', 'help', 'options', 'required'];
    const sheet = openSheet({
      title: isMaterial ? t('Materiales de otros retiros') : t('Preguntas de otros retiros'),
      panelAttrs: { id: 'librarySheet' },
      body: el('div', { id: 'libraryBody' },
        items.length
          ? el('div', { class: 'orgitems' }, ...items.map((r) => el('label', { class: 'field check', 'data-library': r.id },
            el('input', { type: 'checkbox', onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) picked.add(r.id); else picked.delete(r.id); } }),
            el('span', null, el('strong', null, String(r.title ?? r.label)),
              el('span', { class: 'muted small' }, ` · ${isMaterial ? t(KINDS[String(r.kind)] ?? '') : label(TYPES, r.type)}${r.is_logo ? ` · ${t('Logotipo')}` : ''}`)))))
          : el('p', { class: 'muted' }, t('No hay nada más que traer de tus otros retiros.')),
        el('p', { class: 'muted small' }, t('Se copian sin publicar, para que los revises antes. Las respuestas no se copian.'))),
      foot: items.length ? el('div', { class: 'choices' }, el('button', { type: 'button', class: 'primary', id: 'libraryCopy', onclick: () => void copy() }, t('Traer a este retiro'))) : undefined,
    });
    async function copy(): Promise<void> {
      const chosen = items.filter((r) => picked.has(r.id));
      if (!chosen.length) { await sheet.close(true); return; }
      let position = nextPosition(here);
      // Un solo logotipo por retiro: si ya hay uno o se traen varios, se queda el primero.
      let logo = materials.some((m) => m.is_logo);
      const ops: RowOperation[] = chosen.map((r) => {
        const fields: Record<string, unknown> = Object.fromEntries(COPY.filter((k) => r[k] !== undefined).map((k) => [k, r[k]]));
        if (fields.is_logo) { if (logo) fields.is_logo = false; logo = true; }
        return { op: 'insert', table, id: crypto.randomUUID(), fields: { ...fields, reservation_id: reservationId, owner_id: ctx.userId, published: false, position: position++ } };
      });
      try {
        await ctx.usage.run('organizers.experiencia.biblioteca_traer', () => save(ctx.client, ops, here));
        await sheet.close(true);
        await read(); paintMaterials(); paintQuestions();
      } catch (e) { toast(describeError(e)); }
    }
  }

  async function showAnswers(): Promise<void> {
    let names = new Map<string, string>();
    try {
      const list = await ctx.api.guests(reservationId);
      names = new Map(list.value.items.map((g) => [g.id, g.display_name]));
    } catch { /* sin red: se muestran sin nombre */ }
    const nameOf = (id: unknown) => names.get(String(id)) ?? t('Asistente');
    const valueOf = (q: Row, a: Row | undefined) => answerText(String(q.type), a?.value, (q.options as ChoiceOption[]) ?? [], t('Sí'), t('No'));
    const guestIds = [...new Set(answers.map((a) => String(a.guest_id)))].sort((x, y) => nameOf(x).localeCompare(nameOf(y)));
    const blocks: Child[] = questions.map((q) => {
      const mine = answers.filter((a) => a.question_id === q.id);
      return el('section', { class: 'organswers', 'data-question': q.id },
        el('h4', null, String(q.label), el('span', { class: 'muted small' }, ` · ${mine.length === 1 ? t('1 respuesta') : t('{n} respuestas', { n: mine.length })}`)),
        mine.length ? fbIgnore(el('ul', { class: 'plainlist' }, ...mine.map((a) => el('li', null, el('strong', null, nameOf(a.guest_id)), ' · ', valueOf(q, a)))))
          : el('p', { class: 'muted small' }, t('Sin respuestas todavía.')));
    });
    const download = () => {
      const rows = [[t('Asistente'), ...questions.map((q) => String(q.label))],
        ...guestIds.map((g) => [nameOf(g), ...questions.map((q) => valueOf(q, answers.find((a) => a.question_id === q.id && String(a.guest_id) === g)))])];
      const blob = new Blob([toCsv(rows)], { type: 'text/csv;charset=utf-8' });
      const link = el('a', { href: URL.createObjectURL(blob), download: `respuestas-${reservationId.slice(0, 8)}.csv` }) as HTMLAnchorElement;
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    };
    openSheet({
      title: t('Respuestas'),
      panelAttrs: { id: 'answersSheet' },
      body: el('div', { id: 'answersBody' },
        el('p', { class: 'muted small' }, t('Son datos de tus asistentes: úsalos solo para organizar el retiro.')), ...blocks),
      foot: answers.length ? el('div', { class: 'choices' }, el('button', { type: 'button', class: 'primary', id: 'answersCsv', onclick: download }, icon('download', 16), ' ', t('Descargar CSV'))) : undefined,
    });
  }

  // --- Subnavegación y apartados -------------------------------------------------------------------------------------
  /** Cambiar de apartado: una entrada de historia (Atrás vuelve) sin volver a montar la ficha del retiro. */
  function go(k: ExperienceSection): void {
    if (k !== current) history.pushState(null, '', `#/retiro/${reservationId}/experiencia/${k}`);
    current = k;
    remember(k);
    showSection();
  }

  function paintNav(): void {
    const s = sections();
    replace(nav, ...SECTIONS.map(([key, text]) => {
      const st = key === 'ven' ? null : s[key as SectionKey];
      const count = key === 'alojamiento' && st?.count ? st.count : 0;
      return el('button', { type: 'button', id: `expnav-${key}`, class: key === current ? 'on' : '', 'aria-current': key === current ? 'page' : null, onclick: () => go(key) },
        t(text),
        count ? el('span', { class: 'orgtab-count', 'aria-hidden': 'true' }, String(count)) : null,
        count ? el('span', { class: 'vh' }, ` · ${t('{n} por decidir', { n: count })}`) : null,
        st?.state === 'hidden' ? el('span', { class: 'orgexp-dot', 'aria-hidden': 'true' }) : null,
        st?.state === 'hidden' ? el('span', { class: 'vh' }, ` · ${t('Tus asistentes no lo ven')}`) : null);
    }));
  }
  /** El apartado abierto, centrado en la tira (sin mover la página). */
  function centerNav(): void {
    const on = nav.querySelector<HTMLElement>('button.on');
    if (on) nav.scrollLeft = on.offsetLeft - (nav.clientWidth - on.clientWidth) / 2;
  }

  const hostOf = (k: ExperienceSection): HTMLElement => (k === 'ven' ? modulesHost : k === 'materiales' ? materialsHost : k === 'preguntas' ? questionsHost : otherHost);
  function focusTitle(): void {
    const title = hostOf(current).querySelector<HTMLElement>('h3');
    if (!title) return;
    title.tabIndex = -1;
    title.focus({ preventScroll: true });
    title.scrollIntoView({ block: 'start' });
  }

  let shown: ExperienceSection | null = null;
  function showSection(): void {
    paintNav();
    centerNav();
    const back = shown !== null && shown !== 'ven' && current === 'ven';
    shown = current;
    other?.destroy?.();
    other = null;
    modulesHost.hidden = current !== 'ven';
    materialsHost.hidden = current !== 'materiales';
    questionsHost.hidden = current !== 'preguntas';
    let title: string | null = null;
    if (current === 'programa') { other = renderProgram(ctx, reservationId); title = L('Programa'); }
    else if (current === 'menu') { other = renderMenu(ctx, reservationId); title = L('Menú'); }
    else if (current === 'alojamiento') { other = renderLodging(ctx, reservationId, () => exp, setExperience); title = L('Alojamiento'); }
    replace(otherHost, title ? el('h3', { class: 'orgexp-title' }, t(title)) : null, other);
    // Al volver a la portada desde un apartado, sus cifras se vuelven a calcular.
    if (back) void loadExtra();
    if (focusPending) { focusPending = false; focusTitle(); }
  }

  /** Desde la ruta (Atrás, «Abrir» de lo siguiente): `shell.ts` avisa sin desmontar la ficha. */
  const onSection = (e: Event) => {
    const k = (e as CustomEvent<string | null>).detail;
    if (!isSection(k)) return;
    focusPending = true;
    if (k === current && painted) { focusPending = false; focusTitle(); return; }
    current = k;
    remember(k);
    if (painted) showSection();
  };
  window.addEventListener('org-exp-section', onSection);

  function paint(): void {
    // Mientras se escribe en el mensaje o en el alojamiento no se repinta esa parte (perdería el foco).
    if (!(modulesHost.contains(document.activeElement) && typing())) paintModules();
    paintMaterials();
    paintQuestions();
    if (!painted) {
      replace(host, nav, modulesHost, materialsHost, questionsHost, otherHost, el('div', { class: 'orgsave' }, el('div', { class: 'orgsavestate', id: 'experienceSaveState' }, saves.field('experiencia').element)));
      painted = true;
      showSection();
      void loadExtra();
    } else paintNav();
  }

  async function load(): Promise<void> {
    try {
      await read();
      if (alive) paint();
    } catch (error) {
      if (alive) toast(describeError(error));
    }
  }
  const off = watch(ctx.client, [TABLES.experiences, TABLES.materials, TABLES.questions, TABLES.answers], () => { if (alive) void load(); });
  void load();

  (host as HTMLElement & { destroy?: () => void }).destroy = () => {
    alive = false;
    off();
    window.removeEventListener('org-exp-section', onSection);
    for (const release of modulesBound.splice(0)) release();
    other?.destroy?.();
    if (messageTimer) { clearTimeout(messageTimer); const text = (document.getElementById('exp-message') as HTMLTextAreaElement | null)?.value ?? ''; void setExperience({ organizer_message: text.trim() ? text : null }); }
  };
  return host;
}

function materialError(error: unknown): string {
  const e = error as { code?: string; details?: { field?: string } };
  if (e?.code === 'INVALID_FIELDS') {
    if (e.details?.field === 'title') return t('Ponle un título.');
    if (e.details?.field === 'url') return t('El enlace tiene que ser una dirección segura (https).');
    if (e.details?.field === 'body') return t('Escribe el texto.');
  }
  return describeError(error);
}

function questionError(error: unknown): string {
  const e = error as { code?: string; details?: { field?: string } };
  if (e?.code === 'INVALID_FIELDS') {
    if (e.details?.field === 'label') return t('Escribe la pregunta.');
    if (e.details?.field === 'options') return t('Pon entre 2 y 12 opciones, una por línea.');
    if (e.details?.field === 'closes_at') return t('Revisa la fecha.');
  }
  return describeError(error);
}
