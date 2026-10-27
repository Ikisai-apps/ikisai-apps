#!/usr/bin/env node
/**
 * Catálogo de funciones de una app (USO.md §2.1): recorre su código y saca cada `data-feedback-id` (con su
 * `data-feedback-label` y el tipo de control cuando se deduce) y cada `usage.run('…')` / `usage.track('…')`.
 * Escribe `{ app, release, commit, generatedAt, features: [{ id, label, kind, parent }], dynamic }`.
 * Sin dependencias: solo Node.
 *
 *   node packages/ui-kit/scripts/feature-catalog.mjs --app booking [--release v1.2.3] [--commit abc123]
 *        [--src apps/booking/src --src apps/booking/public] [--out apps/booking/dist/feature-catalog.json]
 *
 * Por defecto lee `apps/<app>/src`, `apps/<app>/public` (sin `sw.js`) y `apps/<app>/index.html`, y escribe en
 * `apps/<app>/dist/feature-catalog.json`. `release` y `commit` salen de los argumentos, de `RELEASE`/`GITHUB_SHA`, o del
 * `version.json` que haya junto a la salida.
 * Inventario de campos (src/fields/field-mark.ts): `fields` (cada `data-field-id`, `fieldAttrs`/`markField`, campo del kit con
 * `field` y pregunta de `createStepForm` con `feedbackId`) y `fieldsUninstrumented` (inputs, selects, textareas y campos del kit
 * sin declarar). Solo metadatos del código, nunca valores. Informe de todas las apps:
 *   node packages/ui-kit/scripts/feature-catalog.mjs --fields-report [--app booking] [--out informe.md]
 * Los ids construidos en tiempo de ejecución (`${…}`, concatenaciones) no se pueden catalogar: se listan en `dynamic`
 * con el archivo y la línea, para que el equipo los marque con un id fijo o con su prefijo.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const EXTENSIONS = /\.(ts|tsx|js|mjs|jsx|html)$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'test-results']);
const SKIP_FILES = /(^|[\\/])(sw|service-worker)\.(js|ts)$|\.(spec|test)\.(ts|js)$|\.d\.ts$/;
const ID = /^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){0,7}$/;

export function parseArgs(argv) {
  const out = { src: [] };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--app') { out.app = value; i++; }
    else if (key === '--release') { out.release = value; i++; }
    else if (key === '--commit') { out.commit = value; i++; }
    else if (key === '--out') { out.out = value; i++; }
    else if (key === '--src') { out.src.push(value); i++; }
    else if (key === '--root') { out.root = value; i++; }
    else if (key === '--fields-report') { out.fieldsReport = true; }
  }
  return out;
}

function walk(path, files) {
  if (!existsSync(path)) return;
  const stat = statSync(path);
  if (stat.isFile()) { if (EXTENSIONS.test(path) && !SKIP_FILES.test(path)) files.push(path); return; }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    walk(join(path, name), files);
  }
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * Tipo de control a partir de su propia etiqueta u objeto: desde el último `<tag` o `el('tag'` anterior al atributo hasta
 * el siguiente cierre (`>` o `}`), sin mirar a los vecinos.
 */
function kindNear(before, after) {
  const opener = /(?:<|el\(\s*['"])([a-z][a-z0-9-]*)(?=[\s'">,])(?![\s\S]*(?:<[a-z]|el\(\s*['"]))/.exec(before.slice(-600));
  const own = (opener ? before.slice(-600).slice(opener.index) : '') + after.slice(0, Math.max(0, after.search(/[>}]/))) ;
  const role = /role['"]?\s*[:=]\s*['"](tab|menuitem|link|switch|checkbox|option|button)['"]/.exec(own)?.[1];
  if (role) return { tab: 'tab', menuitem: 'menu', link: 'link', switch: 'toggle', checkbox: 'toggle', option: 'option', button: 'button' }[role];
  const tag = opener?.[1];
  if (!tag) return 'element';
  if (tag === 'button') return 'button';
  if (tag === 'a') return 'link';
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return 'field';
  if (tag === 'form') return 'form';
  if (/^(section|article|main|aside|nav|header|footer|dialog)$/.test(tag)) return 'section';
  if (tag === 'li' || tag === 'tr') return 'item';
  return 'element';
}

/** Etiqueta junto al id: `data-feedback-label="…"`, `'data-feedback-label': '…'` o `feedbackLabel: '…'`. */
function labelNear(before, after) {
  const end = after.search(/[>}]/);
  const opener = Math.max(before.lastIndexOf('<'), before.lastIndexOf('{'));
  const own = (opener >= 0 ? before.slice(opener) : '') + ' ' + (end >= 0 ? after.slice(0, end) : after.slice(0, 200));
  return /(?:data-feedback-label|feedbackLabel)['"]?\s*[:=]\s*(['"`])([^'"`$]{1,80})\1/.exec(own)?.[2]?.trim() ?? null;
}

/**
 * Argumentos de primer nivel de una llamada que empieza en `open` (índice del `(`): respeta paréntesis, corchetes,
 * llaves, comillas y plantillas. Devuelve `null` si la llamada no se cierra.
 */
export function splitArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++;
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      if (depth === 0) { args.push(text.slice(start, i).trim()); return args; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}

const literal = (arg) => /^(['"])([^'"]*)\1$/.exec(arg ?? '')?.[2] ?? /^`([^`$]*)`$/.exec(arg ?? '')?.[1] ?? null;

/** Tipo a partir del nodo que se marca: `el('button', …)`, `listRow(…)`, `shell.header`… */
function kindOfNode(arg) {
  const tag = /^el\(\s*['"]([a-z][a-z0-9-]*)['"]/.exec(arg)?.[1];
  if (tag) return kindNear(`el('${tag}'`, '');
  if (/^listRow\(/.test(arg)) return 'item';
  if (/header|topbar/i.test(arg)) return 'section';
  return 'element';
}

/** Expresión desde `at` hasta la primera `,`, `}`, `)` o `]` de primer nivel (respeta anidación y cadenas). */
function exprAt(text, at) {
  let depth = 0;
  for (let i = at; i < Math.min(text.length, at + 600); i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { if (depth === 0) return text.slice(at, i).trim(); depth--; }
    else if (c === ',' && depth === 0) return text.slice(at, i).trim();
  }
  return '';
}

/** Literales de un ternario `c ? 'x' : 'y'` que empieza en `at` (hasta `,` o `}` de primer nivel); si no lo es, `null`. */
function ternaryLiterals(text, at) {
  const expr = exprAt(text, at);
  if (!/\?/.test(expr) || !/:/.test(expr) || expr.includes('${')) return null;
  const parts = expr.slice(expr.indexOf('?') + 1).split(/\s:\s|\s:(?=\s*['"`])/).map((x) => literal(x.trim()));
  return parts.length === 2 && parts.every((x) => x && (ID.test(x) || !x.includes('.'))) ? parts : null;
}

/**
 * Componentes del kit que marcan sus propios controles a partir de una base (`feedbackId`): el catálogo añade los hijos.
 * Mantener al día con `CONFLICT_MARKS` de `src/sync/conflict.ts`.
 */
const KIT_CHILDREN = {
  renderConflict: [['mantener_mia', 'Reintentar con lo mío', 'button'], ['tomar_servidor', 'Quedarme con lo del servidor', 'button'], ['diferencias', 'Ver diferencias', 'button'], ['combinar', 'Combinar campo a campo', 'button'], ['guardar_combinacion', 'Guardar combinación', 'button'], ['volver', 'Volver', 'button']],
};
// Con `layout: 'tray'` aparecen además `.los_dos` y `.deshacer`; no se listan aquí porque la mayoría de las apps usan las tarjetas.
KIT_CHILDREN.renderConflicts = KIT_CHILDREN.renderConflict;
// Mantener al día con `SPACE_TREE_MARKS` (src/spaces/tree.ts) y `SPACE_PICKER_MARKS` (src/spaces/picker.ts).
KIT_CHILDREN.createSpaceTree = [['buscar', 'Buscar espacio', 'input'], ['nueva_altura', 'Nueva altura', 'button'], ['ver_archivados', 'Ver archivados', 'input'], ['fila', 'Espacio', 'button'], ['desplegar', 'Desplegar o plegar', 'button'], ['mover', 'Arrastrar para mover', 'button'], ['anadir', 'Añadir dentro', 'button'], ['editar', 'Editar espacio', 'button'], ['subir', 'Subir', 'button'], ['bajar', 'Bajar', 'button'], ['guardar', 'Guardar espacio', 'button'], ['duplicar', 'Duplicar', 'button'], ['archivar', 'Archivar', 'button'], ['recuperar', 'Recuperar', 'button']];
KIT_CHILDREN.createSpacePicker = [['rapido', 'Espacio más usado', 'button'], ['buscar', 'Buscar espacio', 'input'], ['opcion', 'Resultado de la búsqueda', 'option'], ['quitar', 'Quitar espacio', 'button']];
// `SPACE_MAP_MARKS` (src/spaces/map.ts).
KIT_CHILDREN.createSpaceMap = [['vista', 'Plano o lista', 'button'], ['dibujo', 'Elegir dibujo', 'button'], ['espacio', 'Espacio en el plano', 'button'], ['fila', 'Espacio en la lista', 'button']];
// `CALENDAR_MARKS` (src/calendar/calendar.ts) y `PROPOSAL_LIST_MARKS` (src/proposals/list.ts).
KIT_CHILDREN.createCalendar = [['capa', 'Capa del calendario', 'button'], ['dia', 'Día del calendario', 'button'], ['guardar_dias', 'Guardar días elegidos', 'button'], ['cancelar_dias', 'Cancelar la elección de días', 'button']];
// `ITEM_PICKER_MARKS` (src/items/picker.ts); con `space`, su `createSpacePicker` cuelga de `.sitio`.
KIT_CHILDREN.createItemPicker = [['buscar', 'Buscar artículo', 'input'], ['opcion', 'Resultado de la búsqueda', 'option'], ['crear', 'Crear artículo', 'option'], ['crear-guardar', 'Crear y usar', 'button'], ['crear-cancelar', 'Cancelar el alta', 'button'], ['cambiar', 'Cambiar de artículo', 'button'], ['usar-existente', 'Usar el que ya existe', 'button'], ['sitio.rapido', 'Sitio más usado', 'button'], ['sitio.buscar', 'Buscar sitio', 'input'], ['sitio.opcion', 'Sitio de la búsqueda', 'option'], ['sitio.quitar', 'Quitar sitio', 'button']];
// `ITEM_CATALOG_MARKS` (src/items/catalog.ts) y `ITEM_SHEET_MARKS` (src/items/sheet.ts).
KIT_CHILDREN.createItemCatalog = [['buscar', 'Buscar en el inventario', 'input'], ['filtro', 'Filtro del inventario', 'button'], ['abrir', 'Abrir ficha', 'button'], ['accion', 'Acción de la fila', 'button'], ['nuevo', 'Nuevo artículo', 'button']];
KIT_CHILDREN.createItemSheet = [['pestana', 'Pestaña de la ficha', 'button'], ['accion', 'Acción del artículo', 'button'], ['guardar', 'Guardar datos', 'button'], ['archivar', 'Archivar o recuperar', 'button'], ['alias', 'Otro nombre', 'button'], ['unidad-nueva', 'Añadir unidad', 'button'], ['unidad-guardar', 'Guardar unidad', 'button'], ['unidad-quitar', 'Quitar unidad', 'button'], ['mas', 'Ver más movimientos', 'button']];
// `MOVEMENT_FORM_MARKS` (src/items/movement-form.ts) y `COUNT_SESSION_MARKS` (src/items/count-session.ts).
KIT_CHILDREN.createMovementForm = [['modo', 'Entrada, salida o traslado', 'button'], ['motivo', 'Motivo de la salida', 'button'], ['lote', 'Lote', 'input'], ['guardar', 'Registrar el movimiento', 'button'], ['cancelar', 'Cancelar', 'button']];
KIT_CHILDREN.createCountSession = [['linea', 'Cantidad contada', 'input'], ['restar', 'Restar uno', 'button'], ['sumar', 'Sumar uno', 'button'], ['calculado', 'Ver lo calculado', 'button'], ['filtro', 'Sitio del recuento', 'button'], ['otro', 'Contar otro artículo', 'button'], ['luego', 'Seguir luego', 'button'], ['revisar', 'Revisar y cerrar', 'button'], ['cerrar', 'Cerrar y ajustar', 'button'], ['volver', 'Volver a contar', 'button']];
// Piezas comunes (src/pieces/stages.ts y groups.ts).
KIT_CHILDREN.renderStages = [['etapa', 'Etapa del recorrido', 'button']];
KIT_CHILDREN.renderGroups = [['grupo', 'Abrir el grupo', 'button'], ['filtro', 'Filtro de grupos', 'button']];
KIT_CHILDREN.createFocus = [['hecha', 'Marcar hecha', 'button'], ['abrir', 'Abrir', 'button'], ['siguiente', 'Siguiente', 'button']];
KIT_CHILDREN.createCoverCarousel = [['anterior', 'Anterior', 'button'], ['siguiente', 'Siguiente', 'button'], ['punto', 'Ir a esta portada', 'button']];
KIT_CHILDREN.renderLead = [['hecha', 'Marcar hecha', 'button'], ['abrir', 'Abrir', 'button'], ['ver_mas', 'Ver más de la cola', 'button']];
KIT_CHILDREN.renderNow = [['hecho', 'Ver lo ya hecho', 'button']];
KIT_CHILDREN.createQueue = [['principal', 'Acción principal', 'button'], ['secundaria', 'Acción secundaria', 'button'], ['saltar', 'Saltar', 'button'], ['ficha', 'Abrir la ficha', 'button'], ['ver_todo', 'Ver todo', 'button']];
KIT_CHILDREN.createVoteDeck = [['a_favor', 'A favor', 'button'], ['en_contra', 'En contra', 'button'], ['abrir', 'Ver entera', 'button'], ['reiniciar', 'Volver a empezar', 'button']];
KIT_CHILDREN.createStepForm = [['opcion', 'Opción', 'button'], ['aceptar', 'Aceptar', 'button'], ['atras', 'Atrás', 'button']];
KIT_CHILDREN.createProposalList = [['estado', 'Estado de las propuestas', 'button'], ['tipo', 'Tipo de propuesta', 'button'], ['abrir', 'Ver propuesta', 'button'], ['aprobar', 'Aprobar propuesta', 'button'], ['descartar', 'Descartar propuesta', 'button'], ['retirar', 'Retirar propuesta', 'button'], ['proponer', 'Proponer', 'button']];

/** Nombre de la llamada que contiene la posición `at` (el `(` sin cerrar más cercano hacia atrás). */
function enclosingCall(text, at) {
  let depth = 0;
  for (let i = at - 1; i >= Math.max(0, at - 4000); i--) {
    const c = text[i];
    if (c === ')' || c === ']' || c === '}') depth++;
    else if (c === '(' || c === '[' || c === '{') {
      if (depth === 0 && c === '(') return /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(Math.max(0, i - 60), i))?.[1] ?? null;
      if (depth > 0) depth--;
    }
  }
  return null;
}

/** Extrae funciones de un texto. Exportada para las pruebas. */
export function extractFeatures(text, file = '') {
  const features = [];
  const dynamic = [];
  const attr = /(?:data-feedback-id|feedbackId)['"]?\s*[:=]\s*(?:(['"])([^'"]*)\1|(`)([^`]*)`|([^\s,}>]+))/g;
  for (const m of text.matchAll(attr)) {
    const raw = m[2] ?? m[4];
    const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 3);
    const concatenated = /^\s*\+/.test(tail);
    if (raw === undefined || (m[3] && raw.includes('${')) || concatenated || !ID.test(raw)) {
      // `cond ? 'a.b' : 'a.c'`: cada rama es una función fija (con su etiqueta si la etiqueta es otro ternario igual).
      const branches = ternaryLiterals(text, m.index + m[0].length - (m[5]?.length ?? 0));
      if (branches) {
        const labelAt = /(?:data-feedback-label|feedbackLabel)['"]?\s*[:=]\s*/.exec(text.slice(m.index, m.index + 600));
        const labels = labelAt ? ternaryLiterals(text, m.index + labelAt.index + labelAt[0].length) : null;
        const before = text.slice(0, m.index);
        branches.forEach((id, k) => features.push({ id, label: labels?.length === branches.length ? labels[k] : null, kind: kindNear(before, ''), file, line: lineOf(text, m.index) }));
        continue;
      }
      dynamic.push({ file, line: lineOf(text, m.index), expr: m[0].slice(0, 120) });
      continue;
    }
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    const call = /feedbackId/.test(m[0]) ? enclosingCall(text, m.index) : null;
    const children = call ? KIT_CHILDREN[call] : null;
    if (children) {
      features.push({ id: raw, label: labelNear(before, after) ?? ({ createSpaceTree: 'Espacios', createSpacePicker: 'Elegir espacio', createSpaceMap: 'Mapa de zonas', createCalendar: 'Calendario', createProposalList: 'Propuestas', createItemPicker: 'Elegir artículo', createItemCatalog: 'Inventario', createItemSheet: 'Ficha del artículo', createMovementForm: 'Movimiento a mano', createCountSession: 'Recuento', renderStages: 'Recorrido', renderGroups: 'Grupos', createFocus: 'Lo que toca ahora', createCoverCarousel: 'Portadas', renderLead: 'Lo primero', renderNow: 'Lo de ahora', renderSteps: 'Paso a paso', createQueue: 'Una cosa cada vez', createVoteDeck: 'Votar', createStepForm: 'Pregunta a pregunta' }[call] ?? 'Conflicto'), kind: 'section', file, line: lineOf(text, m.index) });
      for (const [suffix, label, kind] of children) features.push({ id: `${raw}.${suffix}`, label, kind, file, line: lineOf(text, m.index) });
      continue;
    }
    features.push({ id: raw, label: labelNear(before, after), kind: kindNear(before, after), file, line: lineOf(text, m.index) });
  }
  const calls = /\busage\s*\.\s*(run|track)\s*\(\s*(?:(['"])([^'"]+)\2|(`)([^`]*)`|([^,)]+))/g;
  for (const m of text.matchAll(calls)) {
    const raw = m[3] ?? m[5];
    if (raw === undefined || (m[4] && raw.includes('${')) || !ID.test(raw)) {
      dynamic.push({ file, line: lineOf(text, m.index), expr: m[0].slice(0, 120) });
      continue;
    }
    features.push({ id: raw, label: null, kind: 'operation', file, line: lineOf(text, m.index) });
  }
  // Ayudantes de las apps: `fbMark(nodo, 'id', 'etiqueta')` (Booking, Tasks, Finance).
  const marks = /\bfbMark\s*\(/g;
  for (const m of text.matchAll(marks)) {
    if (/function\s+$/.test(text.slice(Math.max(0, m.index - 12), m.index))) continue;
    const args = splitArgs(text, m.index + m[0].length - 1);
    const id = literal(args?.[1]);
    if (!args || !id || !ID.test(id)) { dynamic.push({ file, line: lineOf(text, m.index), expr: text.slice(m.index, m.index + 120).split('\n')[0] }); continue; }
    features.push({ id, label: literal(args[2]), kind: kindOfNode(args[0] ?? ''), file, line: lineOf(text, m.index) });
  }
  return { features, dynamic };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Inventario de campos (src/fields/field-mark.ts): `fields` (declarados) y `fieldsUninstrumented` (inputs sin `data-field-id`).
// Solo metadatos del código: ningún valor ni contenido.

const FIELD_KEYS = ['type', 'entity', 'prop', 'required', 'permission', 'sensitivity', 'since', 'route'];
const SENSITIVITIES = new Set(['public', 'internal', 'personal', 'sensitive']);
/** Campos del kit y el tipo que ponen solos. Mantener al día con los `fieldAttrs(options.field, { type })` de `src/fields/`. */
const KIT_FIELDS = { createDateField: 'date', createQuantityField: 'number', createSuggestField: 'text', createColorField: 'color', createLabelPicker: 'labels', createLevelStar: 'level', createSignaturePad: 'signature' };
const SKIP_INPUT_TYPES = new Set(['hidden', 'submit', 'button', 'reset', 'image']);

/** Trozo `{ … }`, `[ … ]` o `( … )` que empieza en `open` (respeta anidación y cadenas); `null` si no se cierra. */
function spanAt(text, open) {
  if (!'{[('.includes(text[open] ?? 'x')) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"' || c === "'" || c === '`') { for (i++; i < text.length && text[i] !== c; i++) if (text[i] === '\\') i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return text.slice(open, i + 1); }
  }
  return null;
}

/** Claves de primer nivel de un objeto literal: el literal (`'x'`, `true`, `false`), el texto si es otro objeto, o `undefined`. */
function objectLiterals(obj) {
  const out = {};
  if (!obj) return out;
  const inner = obj.slice(1, -1);
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '"' || c === "'" || c === '`') { for (i++; i < inner.length && inner[i] !== c; i++) if (inner[i] === '\\') i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) { parts.push(inner.slice(start, i)); start = i + 1; }
  }
  parts.push(inner.slice(start));
  for (const part of parts) {
    const m = /^\s*['"]?([A-Za-z_$][\w$-]*)['"]?\s*:\s*([\s\S]*?)\s*$/.exec(part);
    if (!m || m[1] in out) continue;
    const value = m[2];
    if (value === 'true' || value === 'false') out[m[1]] = value === 'true';
    else if (literal(value) !== null) out[m[1]] = literal(value);
    else if (value.startsWith('{')) out[m[1]] = value;
    else out[m[1]] = undefined;
  }
  return out;
}

const requiredOf = (v) => (v === true ? 'always' : v === false ? 'never' : typeof v === 'string' && v.trim() ? v.trim() : null);
const screenOf = (id) => (typeof id === 'string' && id.split('.').length > 2 ? id.split('.')[1] : null);
const isDefinition = (text, at) => /function\s+$/.test(text.slice(Math.max(0, at - 12), at));

function fieldEntry(app, spec, defaults, source, file, line) {
  const own = Object.fromEntries(Object.entries(spec).filter(([, v]) => v !== undefined && v !== null));
  const s = { ...Object.fromEntries(Object.entries(defaults).filter(([, v]) => v !== undefined && v !== null)), ...own };
  return {
    fieldId: s.id, app, screen: screenOf(s.id), route: s.route ?? null, anchorId: s.anchor ?? s.id, label: s.label ?? null,
    type: s.type ?? 'text', entity: s.entity ?? null, prop: s.prop ?? null, required: requiredOf(s.required),
    permission: s.permission ?? null, sensitivity: SENSITIVITIES.has(s.sensitivity) ? s.sensitivity : null, since: s.since ?? null,
    source, file, line,
  };
}

/** Atributos del propio nodo: la etiqueta HTML o el objeto de `el()` que contiene la posición `at`. */
function ownScope(text, at) {
  const lt = text.lastIndexOf('<', at);
  const brace = text.lastIndexOf('{', at);
  if (lt > brace) { const end = text.indexOf('>', at); return text.slice(lt, end < 0 ? at + 400 : end); }
  return brace >= 0 ? (spanAt(text, brace) ?? text.slice(brace, at + 400)) : text.slice(Math.max(0, at - 200), at + 400);
}

function attrLiterals(scope) {
  const out = {};
  for (const m of scope.matchAll(/['"]?(data-field-[a-z]+|data-feedback-id|data-feedback-label|aria-label|name|placeholder|type)['"]?\s*[:=]\s*(['"])([^'"]*)\2/g)) out[m[1]] ??= m[3];
  return out;
}

const fieldTypeOf = (tag, type) => (tag === 'input' ? type ?? 'text' : tag === 'select' ? 'select' : 'text');

/** Campos de un texto: declarados (`fields`), sin declarar (`uninstrumented`) e ids no literales (`dynamic`). Exportada para las pruebas. */
export function extractFields(text, file = '', app = null) {
  app ??= /(?:^|\/)apps\/([^/]+)\//.exec(file)?.[1] ?? null;
  const fields = [];
  const uninstrumented = [];
  const dynamic = [];
  const at = (i) => lineOf(text, i);
  const snippet = (i) => text.slice(i, i + 120).split('\n')[0];
  const missing = (i, tag, attrs, type) => uninstrumented.push({
    app, screen: screenOf(attrs['data-feedback-id']), file, line: at(i), tag, type: type ?? null,
    anchorId: attrs['data-feedback-id'] ?? null, label: attrs['data-feedback-label'] ?? attrs['aria-label'] ?? attrs.name ?? attrs.placeholder ?? null,
  });

  // 1. Atributos `data-field-id` (HTML o el()).
  for (const m of text.matchAll(/['"]?data-field-id['"]?\s*[:=]\s*(?:(['"])([^'"]*)\1|(\S+))/g)) {
    if (!m[2] || !ID.test(m[2])) { dynamic.push({ file, line: at(m.index), expr: snippet(m.index) }); continue; }
    const scope = ownScope(text, m.index);
    const a = attrLiterals(scope);
    const tag = /^<\s*([a-z]+)/.exec(scope)?.[1] ?? null;
    const spec = { id: m[2], anchor: a['data-feedback-id'], label: a['data-feedback-label'] ?? a['aria-label'] };
    for (const k of FIELD_KEYS) spec[k] = a[`data-field-${k}`];
    fields.push(fieldEntry(app, spec, { type: tag ? fieldTypeOf(tag, a.type) : null }, 'attr', file, at(m.index)));
  }

  // 2. Objetos `field: { id, … }` (campos del kit), `fieldAttrs({ … })` y `markField(nodo, { … })`.
  for (const m of text.matchAll(/\b(?:(field)\s*:\s*|(fieldAttrs)\s*\(\s*|(markField)\s*\()/g)) {
    if (isDefinition(text, m.index)) continue;
    let open = m.index + m[0].length;
    if (m[3]) {
      const args = splitArgs(text, open - 1);
      if (!args || args.length < 2) continue;
      open = text.indexOf(args[1], open + args[0].length);
    }
    while (/\s/.test(text[open] ?? '')) open++;
    if (text[open] !== '{') { if (!m[1]) dynamic.push({ file, line: at(m.index), expr: snippet(m.index) }); continue; }
    const spec = objectLiterals(spanAt(text, open));
    const creator = m[1] ? enclosingCall(text, m.index) : null;
    const kit = creator && KIT_FIELDS[creator] ? creator : null;
    // `field:` solo cuenta dentro de un campo del kit (las preguntas de createStepForm las recoge el paso 3).
    if (m[1] && !kit) continue;
    if (typeof spec.id !== 'string' || !ID.test(spec.id)) { dynamic.push({ file, line: at(m.index), expr: snippet(m.index) }); continue; }
    const options = kit ? objectLiterals(spanAt(text, text.lastIndexOf('{', m.index))) : {};
    const defaults = kit ? { type: KIT_FIELDS[kit], required: kit === 'createDateField' || kit === 'createQuantityField' || kit === 'createSuggestField' ? options.required : undefined, label: options.label ?? options.name } : {};
    fields.push(fieldEntry(app, spec, defaults, kit ? 'kit' : 'attr', file, at(m.index)));
  }

  // 3. createStepForm({ feedbackId, questions: [ … ] }): cada pregunta es `<feedbackId>.<id>` (`checkIn` → `check_in`).
  for (const m of text.matchAll(/\bcreateStepForm\s*\(/g)) {
    if (isDefinition(text, m.index)) continue;
    const open = m.index + m[0].length - 1;
    const args = splitArgs(text, open);
    const opts = args?.[0]?.startsWith('{') ? args[0] : null;
    const qAt = opts ? /questions\s*:\s*\[/.exec(opts) : null;
    if (!opts || !qAt) { dynamic.push({ file, line: at(m.index), expr: 'createStepForm: preguntas fuera de la llamada' }); continue; }
    const base = literal(/feedbackId\s*:\s*(['"`][^'"`]*['"`])/.exec(opts)?.[1]);
    const optsAt = text.indexOf(opts, open);
    const listAt = qAt.index + qAt[0].length - 1;
    const list = spanAt(opts, listAt) ?? '';
    for (let i = 1; i < list.length; i++) {
      if (list[i] !== '{') continue;
      const obj = spanAt(list, i);
      if (!obj) break;
      const where = optsAt + listAt + i;
      i += obj.length - 1;
      const q = objectLiterals(obj);
      const type = q.kind === 'text' ? q.inputType ?? 'text' : q.kind === 'choice' ? 'select' : 'multi';
      const extra = typeof q.field === 'string' ? objectLiterals(q.field) : {};
      if (!base && !extra.id) { missing(where, 'createStepForm', { 'aria-label': q.question }, type); continue; }
      if (typeof q.id !== 'string' && !extra.id) { dynamic.push({ file, line: at(where), expr: 'createStepForm: pregunta sin id literal' }); continue; }
      const id = extra.id ?? `${base}.${q.id.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`;
      if (!ID.test(id)) { dynamic.push({ file, line: at(where), expr: `createStepForm: ${id}` }); continue; }
      fields.push(fieldEntry(app, { ...extra, id }, { type, label: q.question }, 'kit', file, at(where)));
    }
  }

  // 4. Sin declarar: `el('input'|'select'|'textarea', …)`, `<input …>` y campos del kit sin `field`.
  for (const m of text.matchAll(/\bel\(\s*['"](input|select|textarea)['"]/g)) {
    const attrs = splitArgs(text, text.indexOf('(', m.index))?.[1] ?? '';
    if (/data-field-id|fieldAttrs\s*\(/.test(attrs) || enclosingCall(text, m.index) === 'markField') continue;
    const a = attrLiterals(attrs);
    const type = fieldTypeOf(m[1], a.type);
    if (m[1] === 'input' && SKIP_INPUT_TYPES.has(type)) continue;
    missing(m.index, m[1], a, type);
  }
  for (const m of text.matchAll(/<(input|select|textarea)\b/g)) {
    const end = text.indexOf('>', m.index);
    const tag = text.slice(m.index, end < 0 ? m.index + 400 : end);
    if (/data-field-id/.test(tag)) continue;
    const a = attrLiterals(tag);
    const type = fieldTypeOf(m[1], a.type);
    if (m[1] === 'input' && SKIP_INPUT_TYPES.has(type)) continue;
    missing(m.index, m[1], a, type);
  }
  for (const m of text.matchAll(new RegExp(`\\b(${Object.keys(KIT_FIELDS).join('|')})\\s*\\(`, 'g'))) {
    if (isDefinition(text, m.index)) continue;
    const opts = splitArgs(text, m.index + m[0].length - 1)?.[0] ?? '';
    if (/\bfield\s*:/.test(opts)) continue;
    const o = opts.startsWith('{') ? objectLiterals(opts) : {};
    if (m[1] === 'createLevelStar' && o.readonly === true) continue;
    missing(m.index, m[1], { 'data-feedback-id': o.feedbackId, 'aria-label': o.label ?? o.name }, KIT_FIELDS[m[1]]);
  }
  uninstrumented.sort((a, b) => a.line - b.line);
  return { fields, uninstrumented, dynamic };
}

/** Une repeticiones del mismo `fieldId` (lo declarado gana a lo nulo) y ordena. */
export function buildFields(found) {
  const byId = new Map();
  for (const f of found) {
    const prev = byId.get(f.fieldId);
    if (!prev) { byId.set(f.fieldId, { ...f }); continue; }
    for (const [k, v] of Object.entries(f)) if (prev[k] === null && v !== null) prev[k] = v;
  }
  return [...byId.values()].sort((a, b) => a.fieldId.localeCompare(b.fieldId));
}

/** Informe «Campos sin instrumentar» en Markdown, a partir de catálogos ya generados. */
export function fieldReport(catalogs) {
  const lines = ['# Campos sin instrumentar', '', 'Sale de `node packages/ui-kit/scripts/feature-catalog.mjs --fields-report`. Solo metadatos del código, ningún valor.', '',
    '| App | Declarados | Sin instrumentar | Sin entidad | Sin sensibilidad |', '|---|---:|---:|---:|---:|'];
  for (const c of catalogs) lines.push(`| ${c.app} | ${c.fields.length} | ${c.fieldsUninstrumented.length} | ${c.fields.filter((f) => !f.entity).length} | ${c.fields.filter((f) => !f.sensitivity).length} |`);
  for (const c of catalogs) {
    if (!c.fieldsUninstrumented.length) continue;
    lines.push('', `## ${c.app} (${c.fieldsUninstrumented.length})`, '');
    for (const u of c.fieldsUninstrumented) lines.push(`- \`${u.file}:${u.line}\` · ${u.tag}${u.type ? ` (${u.type})` : ''}${u.label ? ` · «${u.label}»` : ''}${u.anchorId ? ` · ${u.anchorId}` : ''}`);
  }
  return lines.join('\n') + '\n';
}

/** Une repeticiones (la etiqueta y el tipo más concretos ganan) y calcula el padre: el prefijo catalogado más largo. */
export function buildCatalog(found) {
  const byId = new Map();
  for (const f of found) {
    const prev = byId.get(f.id);
    if (!prev) { byId.set(f.id, { id: f.id, label: f.label, kind: f.kind }); continue; }
    prev.label ??= f.label;
    if ((prev.kind === 'element' || prev.kind === 'operation') && f.kind !== 'element' && f.kind !== 'operation') prev.kind = f.kind;
  }
  const features = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  for (const f of features) {
    const parts = f.id.split('.');
    f.parent = null;
    for (let n = parts.length - 1; n > 0; n--) {
      const candidate = parts.slice(0, n).join('.');
      if (byId.has(candidate)) { f.parent = candidate; break; }
    }
    f.label ??= labelFromId(f.id);
  }
  return features;
}

function labelFromId(id) {
  const last = id.split('.').pop().replace(/[-_]+/g, ' ').trim();
  return last ? last[0].toUpperCase() + last.slice(1) : id;
}

export function generateCatalog({ app, root = process.cwd(), src = [], release, commit, out, write = true }) {
  if (!app || !/^[a-z][a-z0-9_]{1,30}$/.test(app)) throw new Error('Falta --app (id de la app, p. ej. booking).');
  const appDir = join(root, 'apps', app);
  const dirs = src.length ? src.map((s) => resolve(root, s)) : [join(appDir, 'src'), join(appDir, 'public'), join(appDir, 'index.html')];
  const target = out ? resolve(root, out) : join(appDir, 'dist', 'feature-catalog.json');
  const files = [];
  for (const d of dirs) walk(d, files);
  const found = [];
  const dynamic = [];
  const fields = [];
  const fieldsUninstrumented = [];
  for (const file of files) {
    const rel = relative(root, file).replace(/\\/g, '/');
    const text = readFileSync(file, 'utf8');
    const result = extractFeatures(text, rel);
    const own = extractFields(text, rel, app);
    found.push(...result.features);
    dynamic.push(...result.dynamic, ...own.dynamic);
    fields.push(...own.fields);
    fieldsUninstrumented.push(...own.uninstrumented);
    // Cada campo declarado es también una función (su ancla), de tipo `field`.
    for (const f of own.fields) found.push({ id: f.anchorId, label: f.label, kind: 'field', file: f.file, line: f.line });
  }
  let version = {};
  const versionFile = join(dirname(target), 'version.json');
  if (existsSync(versionFile)) { try { version = JSON.parse(readFileSync(versionFile, 'utf8')); } catch { version = {}; } }
  const catalog = {
    app,
    release: release ?? process.env.RELEASE ?? version.release ?? null,
    commit: commit ?? process.env.GITHUB_SHA ?? version.commit ?? null,
    generatedAt: new Date().toISOString(),
    features: buildCatalog(found),
    dynamic,
    fields: buildFields(fields),
    fieldsUninstrumented,
  };
  if (write) {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  }
  return { catalog, target, files: files.length };
}

const invoked = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
if (invoked) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.fieldsReport) {
      const root = args.root ?? process.cwd();
      const apps = args.app ? [args.app] : readdirSync(join(root, 'apps')).filter((a) => /^[a-z][a-z0-9_]{1,30}$/.test(a) && existsSync(join(root, 'apps', a, 'src'))).sort();
      const report = fieldReport(apps.map((app) => generateCatalog({ app, root, write: false }).catalog));
      if (args.out) { mkdirSync(dirname(resolve(root, args.out)), { recursive: true }); writeFileSync(resolve(root, args.out), report, 'utf8'); } else process.stdout.write(report);
      process.exit(0);
    }
    const { catalog, target, files } = generateCatalog({ ...args, root: args.root ?? process.cwd() });
    console.log(`feature-catalog: ${catalog.features.length} funciones de ${files} archivos → ${relative(process.cwd(), target)}${catalog.dynamic.length ? ` (${catalog.dynamic.length} ids dinámicos sin catalogar)` : ''}; ${catalog.fields.length} campos declarados y ${catalog.fieldsUninstrumented.length} sin instrumentar`);
  } catch (error) {
    console.error(`feature-catalog: ${error.message}`);
    process.exit(1);
  }
}
