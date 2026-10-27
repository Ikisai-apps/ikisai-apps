import type { RowOperation } from '@ikisai/sync-client';
import { confirmDialog, el, icon, openSheet, renderStats, replace, toast, type Sheet } from '@ikisai/ui-kit';
import {
  CONTACT_AUDIENCES, CONTACT_AUDIENCE_LABELS, CONTACT_KEYS, PORTAL_TEXTS, TEXT_KINDS, TEXT_PORTAL_LABELS, contactEmailKey, isContactEmailKey, portalTextKeys, textPlaces,
  TEXT_KIND_LABELS, TEXT_BLOCKS, TEXT_LANG_LABELS, TEXT_MARKERS, nextVersion, parseSimpleMarkdown, renderMarkers, unknownMarkers, validateOperations,
  type MarkerSource, type PortalTextSlot, type TextKind, type TextLang, type TextPortal,
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

const LONG = 260;

/**
 * «Textos y contacto» (API.md §2.12; regla del usuario: los textos legales, avisos, declaraciones y datos de contacto se
 * editan siempre desde Central). Todos los miembros los leen; solo el owner los cambia. Cada cambio de contenido crea una
 * versión nueva y las anteriores se conservan tal como se aceptaron.
 * MUELA-017: tablero por destino (Huéspedes, Quien organiza, Correos por público y Sin uso) con cuatro cifras arriba;
 * cada ficha enseña el texto tal cual lo lee la persona. «Así lo ve tu huésped / quien organiza» dibuja el portal en un
 * teléfono, pantalla a pantalla: tocar un texto abre el editor de siempre, y lo que falta sale en su sitio con «Crear aquí».
 */
export const mountTexts: ViewMount = ({ main, client, isAdmin, usage }) => {
  let texts: Text[] = [];
  let source: MarkerSource = {};
  let phone: TextPortal | 'resto' | null = null;
  let phoneLang: TextLang = 'es';
  const host = el('div', { id: 'textList', 'data-feedback-id': 'central.textos.lista', 'data-feedback-label': 'Textos' });
  replace(main,
    el('a', { href: '#/', class: 'backlink', 'data-feedback-id': 'central.textos.volver', 'data-feedback-label': 'Volver a Inicio' }, '‹ Inicio'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.textos.cabecera', 'data-feedback-label': 'Cabecera de Textos y contacto' }, el('div', null,
      el('h2', null, 'Textos y contacto'),
      el('p', null, 'Lo que leen las personas en los portales y en los documentos: avisos legales, declaraciones, mensajes y datos de contacto.')),
      isAdmin ? el('button', { class: 'primary', type: 'button', id: 'newText', 'data-feedback-id': 'central.textos.nuevo', 'data-feedback-label': 'Nuevo texto', onclick: () => openEditor(null) }, icon('plus', 18), 'Nuevo texto') : null),
    host);

  const alive = () => texts.filter((t) => !t.deleted_at);
  const spanish = (key: string) => alive().find((t) => t.key === key && t.lang === 'es') ?? null;
  const english = (key: string) => alive().find((t) => t.key === key && t.lang === 'en') ?? null;
  const placesText = (key: string) => textPlaces(key).map((p) => `${TEXT_PORTAL_LABELS[p.portal]} › ${p.screen}`).join(' · ');

  /** El texto tal cual lo lee la persona (marcadores ya puestos); si es largo, su principio y «Ver todo». */
  function bodyOf(t: Text): HTMLElement {
    const rendered = renderMarkers(t.body, source);
    if (t.kind === 'contacto') return el('p', { class: 'textvalue', 'data-feedback-ignore': '' }, rendered);
    if (rendered.length <= LONG) return el('div', { class: 'ctl-textshow' }, renderSimpleMarkdown(rendered));
    return el('details', { class: 'textbody ctl-textshow', 'data-feedback-id': 'central.textos.texto.contenido', 'data-feedback-label': 'Contenido del texto' },
      el('summary', null, el('span', { class: 'ctl-textstart' }, `${rendered.slice(0, LONG).trimEnd()}…`), el('span', { class: 'linkbtn' }, `Ver todo «${t.title}»`)),
      renderSimpleMarkdown(rendered));
  }

  function card(t: Text, en: Text | null): HTMLElement {
    const where = placesText(t.key);
    return el('article', { class: 'textcard', 'data-text': t.key, 'data-feedback-id': 'central.textos.texto', 'data-feedback-label': 'Texto' },
      el('div', { class: 'blockhead' },
        el('div', null, el('h3', null, t.title), el('code', { class: 'muted small', 'data-feedback-ignore': '' }, t.key)),
        el('span', { class: 'chips' }, el('span', { class: 'chip' }, `ES ${t.version}`),
          en ? el('span', { class: 'chip', 'data-lang': 'en' }, `EN ${en.version}`) : el('span', { class: 'chip muted', 'data-lang': 'en' }, 'EN usa el español'),
          t._pending || en?._pending ? el('span', { class: 'chip pending' }, 'Pendiente de sincronizar') : null)),
      el('p', { class: 'hint ctl-where' }, icon('eye', 14), where ? `Se lee en ${where}` : isContactEmailKey(t.key) ? 'Correo de su público' : 'Ninguna app lo lee'),
      bodyOf(t),
      el('div', { class: 'zone' },
        el('button', { class: 'linkbtn', type: 'button', 'data-lang-action': 'es', 'data-feedback-id': 'central.textos.texto.abrir', 'data-feedback-label': isAdmin ? 'Editar texto' : 'Ver texto', onclick: () => openEditor(t) },
          icon(isAdmin ? 'edit' : 'eye', 16), isAdmin ? 'Editar' : 'Versiones'),
        en || isAdmin ? el('button', { class: 'linkbtn', type: 'button', 'data-lang-action': 'en', 'data-feedback-id': 'central.textos.texto.ingles', 'data-feedback-label': 'Texto en inglés',
          onclick: () => (en ? openEditor(en) : openEditor(null, t)) }, icon('edit', 16), en ? 'Inglés' : 'Traducir al inglés') : null));
  }

  /** Un texto que un portal pide y aún no existe: sale en su sitio con «Crear aquí» (clave, tipo y título puestos). */
  function missing(slot: PortalTextSlot, where: string): HTMLElement {
    return el('article', { class: 'textcard ctl-missing', 'data-missing': slot.key, 'data-feedback-id': 'central.textos.falta', 'data-feedback-label': 'Texto que falta' },
      el('div', { class: 'blockhead' }, el('div', null, el('h3', null, slot.title), el('code', { class: 'muted small' }, slot.key)), el('span', { class: 'chip warn' }, 'Falta')),
      el('p', { class: 'hint' }, `Lo pide ${where}. Hasta que exista, el portal enseña su texto de reserva.`),
      isAdmin ? el('div', { class: 'zone' }, el('button', { class: 'linkbtn', type: 'button', 'data-feedback-id': 'central.textos.falta.crear', 'data-feedback-label': 'Crear aquí', onclick: () => openEditor(null, null, slot) }, icon('plus', 16), 'Crear aquí')) : null);
  }

  function paintBoard(): void {
    const es = alive().filter((t) => t.lang === 'es');
    if (!es.length && !isAdmin) {
      replace(host, el('div', { class: 'empty' }, el('strong', null, 'Todavía no hay textos'), ''));
      return;
    }
    const wanted = portalTextKeys();
    const missingKeys = wanted.filter((k) => !spanish(k));
    const unread = es.filter((t) => !wanted.includes(t.key) && !isContactEmailKey(t.key));
    const withEn = es.filter((t) => english(t.key));
    const column = (id: string, title: string, children: (HTMLElement | null)[]) => el('section', { class: 'textgroup ctl-textcol', 'data-kind': id, 'data-feedback-id': 'central.textos.columna', 'data-feedback-label': 'Columna de destino' },
      el('div', { class: 'sectionlabel' }, title, el('span', { class: 'count' }, ` · ${children.filter(Boolean).length}`)), ...children);
    // Cada texto sale una sola vez, en el primer destino donde se lee; su línea «Se lee en…» dice todos los sitios.
    const seen = new Set<string>();
    const portalColumn = (portal: TextPortal) => {
      const items: HTMLElement[] = [];
      for (const screen of PORTAL_TEXTS[portal]) for (const slot of screen.slots) {
        if (seen.has(slot.key)) continue;
        seen.add(slot.key);
        const t = spanish(slot.key);
        items.push(t ? card(t, english(t.key)) : missing(slot, `${TEXT_PORTAL_LABELS[portal]} › ${screen.screen}`));
      }
      return column(portal, TEXT_PORTAL_LABELS[portal], items);
    };
    const emails = es.filter((t) => isContactEmailKey(t.key) && !wanted.includes(t.key));
    replace(host,
      renderStats([
        { value: es.length, label: 'textos' },
        { value: withEn.length, label: 'con inglés', tone: withEn.length === es.length && es.length ? 'ok' : null },
        { value: missingKeys.length, label: 'que faltan', tone: missingKeys.length ? 'warn' : 'ok' },
        { value: unread.length, label: 'que nadie lee', tone: unread.length ? 'warn' : null },
      ], { label: 'Textos en cifras' }),
      el('div', { class: 'ctl-textlooks', 'data-feedback-id': 'central.textos.asi_lo_ve', 'data-feedback-label': 'Así lo ve' },
        el('button', { class: 'ghost', type: 'button', id: 'lookGuests', 'data-feedback-id': 'central.textos.asi_lo_ve.huesped', 'data-feedback-label': 'Así lo ve tu huésped', onclick: () => { phone = 'guests'; paint(); } }, icon('guest', 18), 'Así lo ve tu huésped'),
        el('button', { class: 'ghost', type: 'button', id: 'lookOrganizers', 'data-feedback-id': 'central.textos.asi_lo_ve.organiza', 'data-feedback-label': 'Así lo ve quien organiza', onclick: () => { phone = 'organizers'; paint(); } }, icon('organizer', 18), 'Así lo ve quien organiza')),
      el('div', { class: 'ctl-textboard' },
        portalColumn('guests'),
        portalColumn('organizers'),
        // Los correos por público van aparte: cada portal y cada documento usa el suyo (el de facturas es el de la Entidad).
        emails.length || isAdmin ? column('correos', 'Correos por público', [
          ...CONTACT_AUDIENCES.map((a) => { const t = spanish(contactEmailKey(a)); return t && !wanted.includes(t.key) ? card(t, english(t.key)) : null; }),
          ...(isAdmin ? CONTACT_AUDIENCES.filter((a) => !spanish(contactEmailKey(a)) && !wanted.includes(contactEmailKey(a))).map((a) => missing({ key: contactEmailKey(a), kind: 'contacto', title: `Correo: ${CONTACT_AUDIENCE_LABELS[a]}` }, `el contacto de ${CONTACT_AUDIENCE_LABELS[a].toLowerCase()}`)) : []),
        ]) : null,
        column('sin_uso', 'Sin uso', unread.sort((a, b) => (a.position - b.position) || a.key.localeCompare(b.key)).map((t) => card(t, english(t.key))))));
  }

  /** «Así lo ve…»: el portal dibujado en un teléfono, pantalla a pantalla, con el texto tal cual y en el idioma elegido. */
  function paintPhone(): void {
    const tabs: Array<[TextPortal | 'resto', string]> = [['guests', 'Huéspedes'], ['organizers', 'Quien organiza'], ['resto', 'Contacto y sin usar']];
    const wanted = portalTextKeys();
    const shown = (key: string) => (phoneLang === 'en' ? english(key) ?? spanish(key) : spanish(key));
    const block = (slot: PortalTextSlot, screen: string): HTMLElement => {
      const t = shown(slot.key);
      if (!t) return el('div', { class: 'ctl-phoneblock missing' }, el('strong', null, slot.title), el('span', { class: 'hint' }, 'Falta este texto: el portal enseña su reserva.'),
        isAdmin ? el('button', { type: 'button', class: 'linkbtn', 'data-feedback-id': 'central.textos.telefono.crear', 'data-feedback-label': 'Crear aquí', onclick: () => openEditor(null, null, slot) }, icon('plus', 16), 'Crear aquí') : null);
      const fallback = phoneLang === 'en' && !english(slot.key) && slot.kind !== 'contacto';
      return el('button', { type: 'button', class: 'ctl-phoneblock', 'data-text': t.key, 'aria-label': `${t.title}, en ${screen}. ${isAdmin ? 'Editar' : 'Ver versiones'}`, 'data-feedback-id': 'central.textos.telefono.bloque', 'data-feedback-label': 'Texto en el portal', onclick: () => openEditor(t) },
        el('strong', null, t.title), fallback ? el('span', { class: 'chip muted' }, 'En inglés sale el español') : null,
        t.kind === 'contacto' ? el('span', { 'data-feedback-ignore': '' }, renderMarkers(t.body, source)) : renderSimpleMarkdown(renderMarkers(t.body, source)));
    };
    const screens = phone === 'resto'
      ? [{ screen: 'Correos por público', items: CONTACT_AUDIENCES.map((a) => ({ key: contactEmailKey(a), kind: 'contacto' as TextKind, title: `Correo: ${CONTACT_AUDIENCE_LABELS[a]}` })).filter((s) => !wanted.includes(s.key)) },
        { screen: 'Sin uso', items: alive().filter((t) => t.lang === 'es' && !wanted.includes(t.key) && !isContactEmailKey(t.key)).map((t) => ({ key: t.key, kind: t.kind, title: t.title })) }]
      : PORTAL_TEXTS[phone as TextPortal].map((s) => ({ screen: s.screen, items: s.slots }));
    replace(host,
      el('button', { type: 'button', class: 'linkbtn', id: 'phoneBack', 'data-feedback-id': 'central.textos.telefono.volver', 'data-feedback-label': 'Volver al tablero', onclick: () => { phone = null; paint(); } }, icon('chevronLeft', 16), 'Tablero de textos'),
      el('div', { class: 'chips ctl-chipscroll', role: 'group', 'aria-label': 'Portal' }, ...tabs.map(([k, l]) => el('button', { type: 'button', class: 'filterchip', 'aria-pressed': String(phone === k), onclick: () => { phone = k; paint(); } }, l))),
      el('div', { class: 'segmented ctl-langs', role: 'group', 'aria-label': 'Idioma' },
        ...(['es', 'en'] as const).map((l) => el('button', { type: 'button', class: phoneLang === l ? 'active' : '', 'aria-pressed': String(phoneLang === l), onclick: () => { phoneLang = l; paint(); } }, l === 'es' ? 'Español' : 'English'))),
      el('div', { class: 'ctl-phone', role: 'region', 'aria-label': phone === 'resto' ? 'Contacto y sin usar' : `Así lo ve ${phone === 'guests' ? 'tu huésped' : 'quien organiza'}`, 'data-feedback-id': 'central.textos.telefono', 'data-feedback-label': 'Teléfono' },
        el('div', { class: 'ctl-phonebar' }, phone === 'guests' ? 'Ikisai · tu estancia' : phone === 'organizers' ? 'Ikisai · tu retiro' : 'Ikisai · contacto'),
        ...screens.map((s) => el('section', { class: 'ctl-phonescreen' }, el('h3', null, s.screen), ...(s.items.length ? s.items.map((slot) => block(slot, s.screen)) : [el('p', { class: 'hint' }, 'Nada aquí.')])))));
    host.querySelector<HTMLElement>('#phoneBack')?.focus({ preventScroll: true });
  }

  function paint(): void { if (phone) paintPhone(); else paintBoard(); }

  /** `base`: al traducir, el texto en español del que parte la versión inglesa (misma clave y tipo). */
  /** `preset`: al «Crear aquí», la clave, el tipo y el título que pide el portal. */
  function openEditor(t: Text | null, base: Text | null = null, preset: PortalTextSlot | null = null): void {
    let sheet: Sheet | null = null;
    const readOnly = !isAdmin;
    const error = el('p', { class: 'formerror', role: 'alert', 'aria-live': 'assertive' });
    const lang: TextLang = t?.lang ?? (base ? 'en' : 'es');
    const key = el('input', { id: 'tx-key', 'data-field-id': 'central.textos.key', 'data-field-entity': 'central.texts', 'data-field-prop': 'key', type: 'text', maxlength: '60', value: t?.key ?? base?.key ?? preset?.key ?? '', placeholder: 'portal.privacy', disabled: t !== null || base !== null || preset !== null || readOnly }) as HTMLInputElement;
    // Una traducción tiene el mismo tipo que su texto en español; solo se elige al crear el español.
    const kind = el('select', { id: 'tx-kind', 'data-field-id': 'central.textos.kind', 'data-field-entity': 'central.texts', 'data-field-prop': 'kind', disabled: readOnly || lang !== 'es' }, ...TEXT_KINDS.map((k) => el('option', { value: k, selected: (t?.kind ?? base?.kind ?? preset?.kind ?? 'legal') === k }, TEXT_KIND_LABELS[k]))) as HTMLSelectElement;
    const title = el('input', { id: 'tx-title', 'data-field-id': 'central.textos.title', 'data-field-entity': 'central.texts', 'data-field-prop': 'title', type: 'text', maxlength: '160', value: t?.title ?? base?.title ?? preset?.title ?? '', disabled: readOnly }) as HTMLInputElement;
    const body = el('textarea', { id: 'tx-body', 'data-field-id': 'central.textos.body', 'data-field-entity': 'central.texts', 'data-field-prop': 'body', rows: '10', maxlength: '8000', disabled: readOnly }) as HTMLTextAreaElement;
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
      guard.dirtyEditor = !readOnly && (t ? changed() : title.value.trim() !== (preset?.title ?? base?.title ?? '') || body.value.trim() !== (base?.body ?? '').trim());
      sheet?.setFootHidden(readOnly || (t !== null && !changed()));
    };
    /** Rodea la selección (o el cursor) con las marcas de un bloque condicional. */
    const wrapBlock = (open: string, close: string) => {
      const start = body.selectionStart ?? body.value.length;
      const end = body.selectionEnd ?? start;
      body.setRangeText(open + body.value.slice(start, end) + close, start, end, 'end');
      body.setSelectionRange(start + open.length, start + open.length + (end - start));
      body.focus();
      refresh();
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
      el('span', { class: 'muted small' }, preset ? `Es la clave que lee ${placesText(preset.key) || 'su público'}.` : 'La usan las apps para encontrar el texto (p. ej. «portal.privacy»). No se puede cambiar después.')),
    el('div', { class: 'fieldrow' },
      el('label', { class: 'field', 'data-feedback-id': 'central.textos.editar.tipo', 'data-feedback-label': 'Tipo' }, el('span', null, 'Tipo'), kind),
      el('label', { class: 'field', 'data-feedback-id': 'central.textos.editar.titulo', 'data-feedback-label': 'Título' }, el('span', null, 'Título'), title)),
    el('label', { class: 'field', 'data-feedback-id': 'central.textos.editar.cuerpo', 'data-feedback-label': 'Texto' }, el('span', null, 'Texto'), body,
      el('span', { class: 'muted small' }, 'Párrafos separados por una línea en blanco; **negrita** entre dobles asteriscos.')),
    readOnly ? null : el('div', { class: 'markers', 'data-feedback-id': 'central.textos.editar.marcadores', 'data-feedback-label': 'Marcadores' },
      el('span', { class: 'muted small' }, 'Insertar:'),
      ...TEXT_MARKERS.map((m) => el('button', { type: 'button', class: 'chip markerbtn', title: m.marker, onclick: () => insertMarker(m.marker) }, m.label)),
      ...TEXT_BLOCKS.map((b) => el('button', { type: 'button', class: 'chip markerbtn blockbtn', title: `${b.open}…${b.close}`, onclick: () => wrapBlock(b.open, b.close) }, b.label)),
      ...TEXT_BLOCKS.map((b) => el('span', { class: 'muted small blockhelp' }, b.help))),
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
