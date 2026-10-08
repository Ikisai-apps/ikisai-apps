import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, el, icon, openSheet, replace, toast, type Sheet } from '@ikisai/ui-kit';
import {
  CONTACT_AUDIENCES, CONTACT_KEYS, TEXT_KINDS, contactEmailKey, isContactEmailKey, TEXT_KIND_LABELS, TEXT_LANG_LABELS, TEXT_MARKERS, nextVersion, parseSimpleMarkdown, renderMarkers, unknownMarkers, validateOperations,
  type MarkerSource, type TextKind, type TextLang,
} from '@ikisai/domain-central';
import { guard } from '../app/guard.ts';
import { T, describeError, type Mirror } from '../app/client.ts';
import type { ViewMount } from './shell.ts';

type Text = Mirror<{ id: string; revision: number; deleted_at: string | null; updated_at: string; key: string; lang: TextLang; title: string; body: string; version: string; kind: TextKind; position: number }>;
interface Version { version: string; title: string; body: string; createdAt: string }

/** Markdown sencillo de los textos (párrafos, saltos de línea y **negrita**) pintado sin `innerHTML`. */
export function renderSimpleMarkdown(text: string): HTMLElement {
  return el('div', { class: 'textpreview' }, ...parseSimpleMarkdown(text).map((paragraph) =>
    el('p', null, ...paragraph.flatMap((line, i) => [
      ...(i > 0 ? [el('br')] : []),
      ...line.map((part) => (part.bold ? el('strong', null, part.text) : document.createTextNode(part.text))),
    ]))));
}

/**
 * «Textos y contacto» (API.md §2.12; regla del usuario: los textos legales, avisos, declaraciones y datos de contacto se
 * editan siempre desde Central). Todos los miembros los leen; solo el owner los cambia. Cada cambio de contenido crea una
 * versión nueva y las anteriores se conservan tal como se aceptaron.
 */
export const mountTexts: ViewMount = ({ main, client, isAdmin, usage }) => {
  let texts: Text[] = [];
  let source: MarkerSource = {};
  const host = el('div', { id: 'textList', 'data-feedback-id': 'central.textos.lista', 'data-feedback-label': 'Textos' });
  replace(main,
    el('a', { href: '#/', class: 'backlink', 'data-feedback-id': 'central.textos.volver', 'data-feedback-label': 'Volver a Inicio' }, '← Inicio'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.textos.cabecera', 'data-feedback-label': 'Cabecera de Textos y contacto' }, el('div', null,
      el('h2', null, 'Textos y contacto'),
      el('p', null, 'Lo que leen las personas en los portales y en los documentos: avisos legales, declaraciones, mensajes y datos de contacto.'))),
    host,
    isAdmin ? el('button', { class: 'fab', type: 'button', id: 'newText', 'data-feedback-id': 'central.textos.nuevo', 'data-feedback-label': 'Nuevo texto', onclick: () => openEditor(null) }, icon('plus'), 'Nuevo texto') : null);

  function card(t: Text, en: Text | null): HTMLElement {
    const rendered = renderMarkers(t.body, source);
    return el('article', { class: 'textcard', 'data-text': t.key, 'data-feedback-id': 'central.textos.texto', 'data-feedback-label': 'Texto' },
      el('div', { class: 'blockhead' },
        el('div', null, el('h3', null, t.title), el('code', { class: 'muted small', 'data-feedback-ignore': '' }, t.key)),
        el('span', { class: 'chips' }, el('span', { class: 'chip' }, `ES ${t.version}`),
          en ? el('span', { class: 'chip', 'data-lang': 'en' }, `EN ${en.version}`) : el('span', { class: 'chip muted', 'data-lang': 'en' }, 'EN usa el español'),
          t._pending || en?._pending ? el('span', { class: 'chip pending' }, 'Pendiente de sincronizar') : null)),
      t.kind === 'contacto' ? el('p', { class: 'textvalue', 'data-feedback-ignore': '' }, rendered)
        : el('details', { class: 'textbody', 'data-feedback-id': 'central.textos.texto.contenido', 'data-feedback-label': 'Contenido del texto' },
          el('summary', null, 'Ver el texto'), renderSimpleMarkdown(rendered)),
      el('div', { class: 'zone' },
        el('button', { class: 'linkbtn', type: 'button', 'data-lang-action': 'es', 'data-feedback-id': 'central.textos.texto.abrir', 'data-feedback-label': isAdmin ? 'Editar texto' : 'Ver texto', onclick: () => openEditor(t) },
          icon(isAdmin ? 'edit' : 'eye', 16), isAdmin ? 'Editar' : 'Versiones'),
        en || isAdmin ? el('button', { class: 'linkbtn', type: 'button', 'data-lang-action': 'en', 'data-feedback-id': 'central.textos.texto.ingles', 'data-feedback-label': 'Texto en inglés',
          onclick: () => (en ? openEditor(en) : openEditor(null, t)) }, icon('edit', 16), en ? 'Inglés' : 'Traducir al inglés') : null));
  }

  function paint(): void {
    const alive = texts.filter((t) => !t.deleted_at);
    if (!alive.length) {
      replace(host, el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay textos'), isAdmin ? 'Crea el aviso de protección de datos, la declaración de quien organiza y el contacto.' : ''));
      return;
    }
    const english = (key: string) => alive.find((t) => t.key === key && t.lang === 'en') ?? null;
    const group = (kind: string, label: string, rows: Text[]) => rows.length
      ? el('section', { class: 'textgroup', 'data-kind': kind }, el('div', { class: 'sectionlabel' }, label), ...rows.sort((a, b) => (a.position - b.position) || a.key.localeCompare(b.key)).map((t) => card(t, english(t.key))))
      : null;
    replace(host, ...TEXT_KINDS.flatMap((kind) => {
      const rows = alive.filter((t) => t.kind === kind && t.lang === 'es');
      if (kind !== 'contacto') return [group(kind, TEXT_KIND_LABELS[kind], rows)];
      // Los correos por público van aparte: cada portal y cada documento usa el suyo (el de facturas es el de la Entidad).
      return [group(kind, TEXT_KIND_LABELS[kind], rows.filter((t) => !isContactEmailKey(t.key))),
        group('correos', 'Correos por público', rows.filter((t) => isContactEmailKey(t.key)))];
    }));
  }

  /** `base`: al traducir, el texto en español del que parte la versión inglesa (misma clave y tipo). */
  function openEditor(t: Text | null, base: Text | null = null): void {
    let sheet: Sheet | null = null;
    const readOnly = !isAdmin;
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
    const lang: TextLang = t?.lang ?? (base ? 'en' : 'es');
    const key = el('input', { id: 'tx-key', type: 'text', maxlength: '60', value: t?.key ?? base?.key ?? '', placeholder: 'portal.privacy', disabled: t !== null || base !== null || readOnly }) as HTMLInputElement;
    // Una traducción tiene el mismo tipo que su texto en español; solo se elige al crear el español.
    const kind = el('select', { id: 'tx-kind', disabled: readOnly || lang !== 'es' }, ...TEXT_KINDS.map((k) => el('option', { value: k, selected: (t?.kind ?? base?.kind ?? 'legal') === k }, TEXT_KIND_LABELS[k]))) as HTMLSelectElement;
    const title = el('input', { id: 'tx-title', type: 'text', maxlength: '160', value: t?.title ?? base?.title ?? '', disabled: readOnly }) as HTMLInputElement;
    const body = el('textarea', { id: 'tx-body', rows: '10', maxlength: '8000', disabled: readOnly }) as HTMLTextAreaElement;
    body.value = t?.body ?? base?.body ?? '';
    const preview = el('div', { id: 'tx-preview', class: 'textpreviewbox', 'data-feedback-id': 'central.textos.editar.vista_previa', 'data-feedback-label': 'Vista previa' });
    const versionNote = el('p', { class: 'note', id: 'tx-version' });
    const markerWarn = el('p', { class: 'formerror', id: 'tx-markers' });
    const history = el('div', { id: 'tx-history', 'data-feedback-id': 'central.textos.editar.versiones', 'data-feedback-label': 'Versiones anteriores' });
    const changed = () => (t ? (title.value.trim() !== t.title || body.value !== t.body || kind.value !== t.kind) : true);
    const refresh = () => {
      replace(preview, renderSimpleMarkdown(renderMarkers(body.value, source)));
      const unknown = unknownMarkers(body.value);
      markerWarn.textContent = unknown.length ? `Marcadores que no existen: ${unknown.join(', ')}. Se mostrarán tal cual.` : '';
      versionNote.hidden = readOnly;
      versionNote.textContent = t
        ? (changed() ? `Al guardar se crea la versión ${nextVersion(t.version)}; las aceptaciones anteriores conservan su versión (${t.version} y anteriores).` : `Versión actual: ${t.version}.`)
        : 'Al guardar se crea la versión v1.';
      guard.dirtyEditor = !readOnly && (t ? changed() : title.value.trim() !== '' || body.value.trim() !== '');
      sheet?.setFootHidden(readOnly || (t !== null && !changed()));
    };
    const insertMarker = (marker: string) => {
      const start = body.selectionStart ?? body.value.length;
      body.setRangeText(marker, start, body.selectionEnd ?? start, 'end');
      body.focus();
      refresh();
    };
    const save = el('button', { class: 'primary', type: 'submit', id: 'saveText', form: 'textForm', 'data-feedback-id': 'central.textos.editar.guardar', 'data-feedback-label': 'Guardar texto' }, 'Guardar') as HTMLButtonElement;
    const form = el('form', { novalidate: true, id: 'textForm', oninput: refresh, onchange: refresh, onsubmit: async (event: Event) => {
      event.preventDefault();
      if (readOnly) return;
      error.textContent = '';
      const fields: Record<string, unknown> = { title: title.value.trim(), body: body.value, kind: kind.value };
      const operations: RowOperation[] = t
        ? [{ op: 'update', table: T.texts, id: t.id, expectedRevision: t.revision, fields: Object.fromEntries(Object.entries(fields).filter(([k, v]) => t[k] !== v)) }]
        : [{ op: 'insert', table: T.texts, id: crypto.randomUUID(), fields: { ...fields, key: key.value.trim(), lang, position: base?.position ?? Date.now() / 1000 } }];
      const issue = validateOperations(operations, client.bootstrap()?.membership ?? { role: 'reader' }, () => t ?? undefined);
      if (issue) { error.textContent = issue.message; error.scrollIntoView({ block: 'nearest' }); return; }
      save.disabled = true;
      try {
        await usage.run('central.textos.guardar', () => client.commit(operations));
        toast(!navigator.onLine ? 'Texto guardado en este dispositivo. Se sincronizará cuando haya red.' : 'Texto guardado.');
        guard.dirtyEditor = false;
        await sheet?.close(true);
      } catch (e) { error.textContent = describeError(e); } finally { save.disabled = false; }
    } },
    base ? el('p', { class: 'note', id: 'tx-translate' }, `Traducción al inglés de «${base.title}». Parte del texto en español: tradúcelo y guarda. Hasta entonces, los portales en inglés muestran el español.`) : null,
    t || base ? null : el('label', { class: 'field', 'data-feedback-id': 'central.textos.editar.clave', 'data-feedback-label': 'Clave' }, el('span', null, 'Clave'), key,
      el('span', { class: 'muted small' }, 'La usan las apps para encontrar el texto (p. ej. «portal.privacy»). No se puede cambiar después.')),
    el('div', { class: 'fieldrow' },
      el('label', { class: 'field', 'data-feedback-id': 'central.textos.editar.tipo', 'data-feedback-label': 'Tipo' }, el('span', null, 'Tipo'), kind),
      el('label', { class: 'field', 'data-feedback-id': 'central.textos.editar.titulo', 'data-feedback-label': 'Título' }, el('span', null, 'Título'), title)),
    el('label', { class: 'field', 'data-feedback-id': 'central.textos.editar.cuerpo', 'data-feedback-label': 'Texto' }, el('span', null, 'Texto'), body,
      el('span', { class: 'muted small' }, 'Párrafos separados por una línea en blanco; **negrita** entre dobles asteriscos.')),
    readOnly ? null : el('div', { class: 'markers', 'data-feedback-id': 'central.textos.editar.marcadores', 'data-feedback-label': 'Marcadores' },
      el('span', { class: 'muted small' }, 'Insertar:'),
      ...TEXT_MARKERS.map((m) => el('button', { type: 'button', class: 'chip markerbtn', title: m.marker, onclick: () => insertMarker(m.marker) }, m.label))),
    markerWarn,
    el('div', { class: 'sectionlabel' }, 'Vista previa'),
    preview,
    versionNote,
    error,
    history,
    !readOnly && t ? el('div', { class: 'zone' }, el('button', { class: 'danger', type: 'button', id: 'deleteText', 'data-feedback-id': 'central.textos.editar.papelera', 'data-feedback-label': 'Enviar a papelera', onclick: async () => {
      const translation = t.lang === 'es' ? texts.find((x) => x.key === t.key && x.lang === 'en' && !x.deleted_at) : undefined;
      const message = t.lang === 'es'
        ? `Las apps que lo usan dejarán de encontrarlo${translation ? ', también en inglés' : ''}. Sus versiones se conservan.`
        : 'Los portales en inglés volverán a mostrar el texto en español. Sus versiones se conservan.';
      if (!(await confirmDialog({ title: t.lang === 'es' ? '¿Enviar el texto a la papelera?' : '¿Quitar la traducción al inglés?', text: message, confirmLabel: 'Enviar a papelera', danger: true }))) return;
      try {
        await client.commit([
          ...(translation ? [{ op: 'delete' as const, table: T.texts, id: translation.id, expectedRevision: translation.revision }] : []),
          { op: 'delete', table: T.texts, id: t.id, expectedRevision: t.revision },
        ]);
        guard.dirtyEditor = false; await sheet?.close(true); toast('Texto enviado a la papelera.');
      }
      catch (e) { error.textContent = describeError(e); }
    } }, icon('trash', 18), 'Enviar a papelera')) : null) as HTMLFormElement;
    refresh();

    if (t && navigator.onLine) {
      void client.api<{ items: Version[] }>('/read/central.text_history', { method: 'POST', json: { key: t.key, lang: t.lang } }).then((out) => {
        const older = out.items.filter((v) => v.version !== t.version);
        replace(history, older.length ? el('details', null, el('summary', null, `Versiones anteriores (${older.length})`),
          ...older.map((v) => el('details', { class: 'textversion', 'data-version': v.version },
            el('summary', null, `${v.version} · ${new Date(v.createdAt).toLocaleDateString('es-ES')}`), renderSimpleMarkdown(v.body)))) : null);
      }).catch(() => { /* sin red o sin historial: no se muestra */ });
    }

    sheet = openSheet({
      title: t ? t.title : base ? `${base.title} (inglés)` : 'Nuevo texto', meta: t ? `${t.key} · ${TEXT_LANG_LABELS[t.lang]} · ${t.version}` : base ? `${base.key} · ${TEXT_LANG_LABELS.en}` : undefined, body: form,
      panelAttrs: { 'data-feedback-id': 'central.textos.editar', 'data-feedback-label': 'Editar texto' },
      closeAttrs: { 'data-feedback-id': 'central.textos.editar.cerrar_hoja', 'data-feedback-label': 'Cerrar' },
      foot: readOnly ? undefined : [el('button', { class: 'ghost', type: 'button', 'data-feedback-id': 'central.textos.editar.cancelar', 'data-feedback-label': 'Cancelar', onclick: () => void sheet?.close() }, t ? 'Cerrar' : 'Cancelar'), save],
      footHidden: readOnly || t !== null,
      initialFocus: readOnly ? undefined : (t || base ? body : key),
      beforeClose: async () => !guard.dirtyEditor || confirmDialog({ title: 'Hay cambios sin guardar', text: '¿Descartarlos?', confirmLabel: 'Descartar', danger: true }),
      onClose: () => { guard.dirtyEditor = false; sheet = null; },
    });
  }

  async function load(): Promise<void> {
    texts = (await client.list(T.texts, { includeDeleted: true })) as unknown as Text[];
    const entity = (await client.list(T.entity)).find((e) => !e.deleted_at) as MarkerSource['entity'] | undefined;
    const alive = texts.filter((t) => !t.deleted_at);
    const es = (k: string) => alive.find((t) => t.key === k && t.lang === 'es')?.body ?? null;
    source = { entity: entity ?? null, phone: es(CONTACT_KEYS.phone), emails: Object.fromEntries(CONTACT_AUDIENCES.map((a) => [a, es(contactEmailKey(a)) ?? (a === 'organizers' ? es('contact.email') : null)])) };
    paint();
  }
  void load();
  const offs = [client.onTable(T.texts, () => void load()), client.onTable(T.entity, () => void load())];
  return () => offs.forEach((off) => off());
};
