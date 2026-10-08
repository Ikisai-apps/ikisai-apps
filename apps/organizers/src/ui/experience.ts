/**
 * Pestaña «Experiencia» (fases 4 y 5, API.md §15.3): lo que ven y hacen tus asistentes en su enlace personal de Ikisai
 * Guests, en seis apartados:
 * - «Qué ven»: módulos visibles y su ventana, mensaje de bienvenida y vista previa con el huésped de muestra (O6);
 * - «Programa» (Booking), «Menú» (Food) y «Alojamiento» (Booking y la configuración propia);
 * - «Materiales» (archivos, enlaces y textos) y «Preguntas» con sus respuestas y CSV.
 * Lo propio vive en el espejo local (`app/own.ts`): se guarda solo, también sin red, y la cola lo envía al volver.
 */
import { compressImage, confirmDialog, createSaveState, el, icon, openSheet, replace, toast, type Child } from '@ikisai/ui-kit';
import type { RowOperation } from '@ikisai/sync-client';
import { answerText, MATERIAL_MAX_BYTES, sensitiveQuestion, toCsv } from '../../../../supabase/functions/_domain/organizers/mod.ts';
import { describeError } from '../app/client.ts';
import { L, t } from '../app/i18n.ts';
import { fileIdOf, libraryOf, nextPosition, rowsOf, save, TABLES, watch, type Row } from '../app/own.ts';
import { fbIgnore, fbMark, loading, section } from './common.ts';
import { renderLodging } from './lodging.ts';
import { renderMenu } from './menu.ts';
import { renderProgram } from './program.ts';
import { typing } from './offers.ts';
import type { ViewContext } from './shell.ts';

const WINDOWS: Array<[string, string]> = [['always', L('Siempre')], ['before', L('Antes del retiro')], ['during', L('Durante el retiro')], ['after', L('Después del retiro')]];
const TYPES: Array<[string, string]> = [['text', L('Texto libre')], ['choice', L('Una opción')], ['multi', L('Varias opciones')], ['yes_no', L('Sí o no')], ['number', L('Número')], ['date', L('Fecha')]];
const KINDS: Record<string, string> = { file: L('Archivo'), link: L('Enlace'), text: L('Texto') };
const KIND_ICON: Record<string, string> = { file: 'attach', link: 'copy', text: 'list' };
const label = (pairs: Array<[string, string]>, key: unknown) => t(pairs.find(([k]) => k === key)?.[1] ?? '');
const options = (pairs: Array<[string, string]>, current: unknown) => pairs.map(([v, l]) => el('option', { value: v, selected: v === current ? '' : null }, t(l)));
const slug = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'opcion';

export type ExperienceSection = 'ven' | 'programa' | 'menu' | 'alojamiento' | 'materiales' | 'preguntas';
const SECTIONS: Array<[ExperienceSection, string]> = [['ven', L('Qué ven')], ['programa', L('Programa')], ['menu', L('Menú')], ['alojamiento', L('Alojamiento')], ['materiales', L('Materiales')], ['preguntas', L('Preguntas')]];
const SECTION_KEY = 'ikisai-organizers-experience-section';

interface ChoiceOption { value: string; label: string }

export function renderExperience(ctx: ViewContext, reservationId: string): HTMLElement {
  const saves = createSaveState({ savedMs: 4000 });
  const modulesHost = el('div', { id: 'expModulesHost' });
  const materialsHost = el('div', { id: 'expMaterialsHost' });
  const questionsHost = el('div', { id: 'expQuestionsHost' });
  const otherHost = el('div', { id: 'expOtherHost' });
  const nav = el('nav', { class: 'orgsubnav', 'aria-label': t('Apartados de la experiencia') });
  let current: ExperienceSection = (() => { try { return (sessionStorage.getItem(SECTION_KEY) as ExperienceSection) || 'ven'; } catch { return 'ven'; } })();
  if (!SECTIONS.some(([k]) => k === current)) current = 'ven';
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

  async function read(): Promise<void> {
    const [e, m, q, a] = await Promise.all([
      rowsOf(ctx.client, TABLES.experiences, reservationId), rowsOf(ctx.client, TABLES.materials, reservationId),
      rowsOf(ctx.client, TABLES.questions, reservationId), rowsOf(ctx.client, TABLES.answers, reservationId),
    ]);
    exp = e[0] ?? null; materials = m; questions = q; answers = a;
  }

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

  // --- Qué ven tus asistentes ----------------------------------------------------------------------------------------
  function paintModules(): void {
    const value = (key: string, fallback: unknown) => (exp && exp[key] !== undefined && exp[key] !== null ? exp[key] : fallback);
    const windowSelect = (key: string) => el('select', { id: `exp-${key}`, 'aria-label': t('Cuándo lo ven'),
      onchange: (e: Event) => void setExperience({ [key]: (e.target as HTMLSelectElement).value }) }, ...options(WINDOWS, value(key, 'always')));
    const moduleRow = (key: string, title: string, help: string, windowKey?: string) => {
      const on = value(key, false) === true;
      return el('div', { class: 'orgmodule', 'data-module': key },
        el('label', { class: 'field check' },
          el('input', { type: 'checkbox', id: `exp-${key}`, checked: on ? '' : null, onchange: (e: Event) => { void setExperience({ [key]: (e.target as HTMLInputElement).checked }).then(paintModules); } }),
          el('span', null, el('strong', null, t(title)), el('span', { class: 'muted small' }, ` · ${t(help)}`))),
        on && windowKey ? el('label', { class: 'field orgmodule-window' }, el('span', null, t('Cuándo lo ven')), windowSelect(windowKey)) : null);
    };
    const message = el('textarea', { id: 'exp-message', rows: '3', maxlength: '1000', placeholder: t('Os esperamos en Ikisai…'),
      oninput: (e: Event) => {
        const text = (e.target as HTMLTextAreaElement).value;
        if (messageTimer) clearTimeout(messageTimer);
        saves.set('experiencia', 'pending');
        messageTimer = setTimeout(() => { messageTimer = null; void setExperience({ organizer_message: text.trim() ? text : null }); }, 800);
      } }, String(value('organizer_message', ''))) as HTMLTextAreaElement;

    replace(modulesHost,
      fbMark(section(t('Qué ven tus asistentes'), { id: 'expModules' },
        el('p', { class: 'muted' }, t('Elige qué aparece en el enlace personal de cada asistente. Sus datos, la firma y la alimentación los ven siempre.')),
        moduleRow('materials_visible', L('Materiales'), L('lo que publiques abajo')),
        moduleRow('questions_visible', L('Preguntas'), L('las preguntas que publiques abajo')),
        moduleRow('program_visible', L('Programa'), L('el horario del retiro'), 'program_window'),
        moduleRow('menu_visible', L('Menú'), L('la propuesta de la cocina de Ikisai'), 'menu_window'),
        moduleRow('map_visible', L('Plano de Ikisai'), L('cómo llegar y moverse por el centro')),
        moduleRow('lodging_visible', L('Alojamiento'), L('su habitación en Ikisai'))), 'organizers.experiencia.modulos', 'Qué ven tus asistentes'),
      fbMark(section(t('Vista previa'), { id: 'expPreview' },
        el('p', { class: 'muted small' }, t('Abre el enlace de un asistente de muestra para ver exactamente lo que verán. No se guarda nada de lo que hagas ahí.')),
        el('button', { type: 'button', class: 'ghost', id: 'expPreviewOpen', onclick: () => void openPreview() }, icon('eye', 16), ' ', t('Ver como un asistente'))), 'organizers.experiencia.vista_previa', 'Vista previa'),
      fbMark(section(t('Mensaje de bienvenida'), { id: 'expMessage' },
        el('p', { class: 'muted small' }, t('Lo verán al abrir su enlace. Opcional.')),
        fbIgnore(el('label', { class: 'field' }, el('span', null, t('Mensaje')), message)),
        el('label', { class: 'field' }, el('span', null, t('Idioma del mensaje')),
          el('select', { id: 'exp-message-lang', onchange: (e: Event) => void setExperience({ message_lang: (e.target as HTMLSelectElement).value }) },
            el('option', { value: 'es', selected: value('message_lang', 'es') === 'es' ? '' : null }, 'Español'),
            el('option', { value: 'en', selected: value('message_lang', 'es') === 'en' ? '' : null }, 'English')))), 'organizers.experiencia.mensaje', 'Mensaje de bienvenida'));
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
      const sha = await ctx.client.stageBlob(blob, { filename: name, mime });
      const id = crypto.randomUUID();
      const title = file.name.replace(/\.[^.]+$/, '').slice(0, 160) || t('Documento');
      await track(() => ctx.usage.run('organizers.experiencia.material_subir', () => save(ctx.client, [{ op: 'insert', table: TABLES.materials, id,
        fields: { reservation_id: reservationId, owner_id: ctx.userId, kind: 'file', title, file_id: { $blob: sha }, published: false, window: 'always', position: nextPosition(materials) } }])));
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
        await ctx.usage.run('organizers.experiencia.material_quitar', () => save(ctx.client, [{ op: 'delete', table: TABLES.materials, id: row.id, expectedRevision: row.revision }]));
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
        await ctx.usage.run('organizers.experiencia.pregunta_quitar', () => save(ctx.client, [{ op: 'delete', table: TABLES.questions, id: row.id, expectedRevision: row.revision }]));
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

  function paintNav(): void {
    replace(nav, ...SECTIONS.map(([key, text]) => el('button', { type: 'button', id: `expnav-${key}`, class: key === current ? 'on' : '', 'aria-pressed': key === current ? 'true' : 'false',
      onclick: () => { current = key; try { sessionStorage.setItem(SECTION_KEY, key); } catch { /* */ } showSection(); } }, t(text))));
  }

  function showSection(): void {
    paintNav();
    other?.destroy?.();
    other = null;
    modulesHost.hidden = current !== 'ven';
    materialsHost.hidden = current !== 'materiales';
    questionsHost.hidden = current !== 'preguntas';
    if (current === 'programa') other = renderProgram(ctx, reservationId);
    else if (current === 'menu') other = renderMenu(ctx, reservationId);
    else if (current === 'alojamiento') other = renderLodging(ctx, reservationId, () => exp, setExperience);
    replace(otherHost, other);
  }

  function paint(): void {
    if (!painted) {
      replace(host, nav, modulesHost, materialsHost, questionsHost, otherHost, el('div', { class: 'orgsave' }, el('div', { class: 'orgsavestate', id: 'experienceSaveState' }, saves.field('experiencia').element)));
      painted = true;
      showSection();
    }
    // Mientras se escribe en el mensaje o en el alojamiento no se repinta esa parte (perdería el foco).
    if (!(modulesHost.contains(document.activeElement) && typing())) paintModules();
    paintMaterials();
    paintQuestions();
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
