/**
 * Central · Planos del centro (tanda 36, MUELA-024 con sus adendas; tanda 37, MUELA-092; docs/central/API.md §9.7). El
 * mapa de zonas de todas las apps sale de aquí: el dibujo de cada edificio y planta (`resources.floor_plans`) y la forma
 * de cada estancia encima (`resources.spaces.plan_id` + `plan_shape`, puntos 0..1 relativos a la imagen).
 * - **Todos** ven el mapa con la pieza del kit (`createSpaceMap`), con su lista equivalente.
 * - **«Colocar», solo el owner y en el ordenador** (en el móvil, solo ver; el núcleo lo exige igualmente):
 *   - subir un dibujo por edificio y planta (SVG, PNG o JPG), sustituirlo (las formas se conservan) y quitarlo (no con
 *     estancias encima). **Del SVG se sube el limpio** (`cleanSvg`), no el original. Sin red, subir, sustituir, quitar y
 *     «Colocar solo» se apagan con su motivo;
 *   - **colocar solo:** si el SVG trae los nombres de las estancias, se colocan solas (`app/svg-plan.ts`: DOMPurify, perfil
 *     SVG, y nunca en la página). El aviso dice qué nombres del SVG no son de ninguna estancia; la que no se puede leer
 *     (un giro raro) va a «Por revisar» con el motivo;
 *   - **colocar a mano:** arrastrar y estirar, o con el teclado (flechas mueven; con Mayúsculas, estiran). Las camas y lo
 *     que hay dentro acompañan a su habitación: el mismo lote y un solo «Deshacer». Cada forma pasa por `setShape` y
 *     `onShape` de la pieza;
 *   - **«Por revisar»:** las estancias del edificio que aún no tienen forma.
 * - El plano en imagen o PDF de la Entidad no cambia: lo siguen usando los portales.
 */
import {
  bindOnline, confirmDialog, createSpaceMap, createSyncSpaceSource, el, icon, indexSpaces, openSheet, renderOfflineReason, replace, shapeCenter, spacePath,
  spaceToFields, toast, toastWithAction, validShape,
  type FloorPlan, type PlanShape, type Sheet, type SpaceMap, type SpaceRow,
} from '@ikisai/ui-kit';
import type { RowOperation, TableName } from '@ikisai/sync-client';
import { describeError } from '../app/client.ts';
import { startResources } from '../app/resources.ts';
import { activeContent, cleanSvg, foldName, generatedName, matchShapes, readSvgPlan } from '../app/svg-plan.ts';
import type { ViewMount } from './shell.ts';

const PLANS = 'resources.floor_plans' as TableName;
const SPACES = 'resources.spaces' as TableName;
const PLAN_MIME = ['image/svg+xml', 'image/png', 'image/jpeg'];
const WIDE = '(min-width: 900px)';
/** Lo que no se coloca: lo que contiene estancias (alturas, edificios y exteriores). */
const CONTAINERS = new Set(['altura', 'edificio', 'exterior']);
/** El aviso del SVG con contenido activo (el servidor lo rechaza, #694; aquí no debería llegar, porque se sube limpio). */
const ACTIVE_SVG = 'El SVG lleva contenido activo. Guárdalo limpio desde tu programa de dibujo.';
/** Cuántos nombres del SVG sin estancia se dicen; del resto, «+N más». */
const UNMATCHED_SHOWN = 10;

/** Tamaño del dibujo en sus unidades: el `viewBox` del SVG o los píxeles de la imagen. */
async function imageSize(file: Blob, svgText: string | null): Promise<{ width: number; height: number } | null> {
  if (svgText !== null) { const plan = readSvgPlan(svgText); return plan ? { width: plan.width, height: plan.height } : null; }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('imagen')); img.src = url; });
    return img.naturalWidth > 0 && img.naturalHeight > 0 ? { width: img.naturalWidth, height: img.naturalHeight } : null;
  } catch { return null; } finally { URL.revokeObjectURL(url); }
}

/** Un dibujo recién elegido aún no tiene id de archivo (en el espejo es `{ $blob }`): hasta que sube, sin archivo. */
const uploaded = (p: FloorPlan): FloorPlan => (typeof p.fileId === 'string' ? p : { ...p, fileId: null });
const pendingFile = (p: FloorPlan) => p.fileId !== null && typeof p.fileId !== 'string';

const rect = (cx: number, cy: number, w: number, h: number): PlanShape => {
  const x0 = Math.min(Math.max(cx - w / 2, 0), 1 - w); const y0 = Math.min(Math.max(cy - h / 2, 0), 1 - h);
  return { points: [[x0, y0], [x0 + w, y0], [x0 + w, y0 + h], [x0, y0 + h]] };
};
const round = (n: number) => Math.round(Math.min(1, Math.max(0, n)) * 10000) / 10000;
const boxOf = (s: PlanShape) => { const xs = s.points.map((p) => p[0]); const ys = s.points.map((p) => p[1]); return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }; };
/** Mueve una forma sin salirse del dibujo. */
function moved(s: PlanShape, dx: number, dy: number): PlanShape {
  const b = boxOf(s);
  const mx = Math.min(Math.max(dx, -b.x0), 1 - b.x1); const my = Math.min(Math.max(dy, -b.y0), 1 - b.y1);
  return { points: s.points.map(([x, y]) => [round(x + mx), round(y + my)]) };
}
/** Estira una forma desde su esquina de arriba a la izquierda (o desde la contraria a la que se arrastra). */
function stretched(s: PlanShape, anchor: [number, number], w: number, h: number): PlanShape {
  const b = boxOf(s);
  const bw = Math.max(b.x1 - b.x0, 1e-6); const bh = Math.max(b.y1 - b.y0, 1e-6);
  const nw = Math.max(0.01, Math.min(w, 1)); const nh = Math.max(0.01, Math.min(h, 1));
  return { points: s.points.map(([x, y]) => [round(anchor[0] + ((x - anchor[0]) * nw) / bw), round(anchor[1] + ((y - anchor[1]) * nh) / bh)]) };
}
/** La misma traslación y escala que lleva la caja de `from` a la de `to`, aplicada a otra forma (una cama de la habitación). */
function follow(shape: PlanShape, from: PlanShape, to: PlanShape): PlanShape {
  const a = boxOf(from); const b = boxOf(to);
  const sx = (b.x1 - b.x0) / Math.max(a.x1 - a.x0, 1e-6); const sy = (b.y1 - b.y0) / Math.max(a.y1 - a.y0, 1e-6);
  return { points: shape.points.map(([x, y]) => [round(b.x0 + (x - a.x0) * sx), round(b.y0 + (y - a.y0) * sy)]) };
}
const pointsAttr = (s: PlanShape, plan: FloorPlan) => s.points.map(([x, y]) => `${(x * plan.width).toFixed(1)},${(y * plan.height).toFixed(1)}`).join(' ');

type Placement = { planId: string | null; shape: PlanShape | null };

export const mountPlans: ViewMount = ({ main, client }) => {
  let alive = true;
  const r = startResources(client);
  const spaces = createSyncSpaceSource(r);
  const media = matchMedia(WIDE);
  const canPlace = () => r.bootstrap()?.membership.role === 'owner';
  let rows: SpaceRow[] = [];
  let plans: FloorPlan[] = [];
  let editing: string | null = null;
  let viewer: SpaceMap | null = null;
  const binds: Array<() => void> = [];
  const editorBinds: Array<() => void> = [];
  /** El dibujo recién subido desde este dispositivo, para verlo ya mientras sube (`blob:`), por id de plano. */
  const localUrls = new Map<string, string>();
  /** Por qué una estancia está en «Por revisar» aunque el SVG la nombre (un giro que no se puede leer), por id. */
  const reviewWhy = new Map<string, string>();
  /** Los nombres del último «Colocar solo» que no son de ninguna estancia, por plano. */
  const unmatchedOf = new Map<string, string[]>();

  const viewerHost = el('div', { id: 'plansMap' });
  const tools = el('section', { id: 'planTools', 'aria-label': 'Dibujos y colocar', 'data-feedback-id': 'central.planos.dibujos', 'data-feedback-label': 'Dibujos y colocar' });
  const editor = el('section', { id: 'placeEditor', hidden: true, 'aria-label': 'Colocar', 'data-feedback-id': 'central.planos.colocar', 'data-feedback-label': 'Colocar' });
  replace(main,
    el('a', { href: '#/entidad', class: 'backlink', 'data-feedback-id': 'central.planos.volver', 'data-feedback-label': 'Volver a la entidad' }, '← Entidad'),
    el('div', { class: 'pagehead', 'data-feedback-id': 'central.planos.cabecera', 'data-feedback-label': 'Cabecera de Planos' }, el('div', null, el('h2', null, 'Planos del centro'),
      el('p', null, 'El dibujo de cada edificio y planta, con sus estancias encima: es el mapa de zonas que ven las apps. El plano en imagen o PDF de la Entidad sigue siendo el de los portales.'))),
    tools, editor, viewerHost);

  const index = () => indexSpaces(rows);
  const planName = (p: FloorPlan) => [rows.find((s) => s.id === p.buildingId)?.name ?? 'Edificio', p.floor].filter(Boolean).join(' · ');
  const inside = (p: FloorPlan) => { const idx = index(); return rows.filter((s) => s.active && !CONTAINERS.has(s.kind) && (s.id === p.buildingId || spacePath(idx, s.id).startsWith(`${spacePath(idx, p.buildingId)} › `))); };
  const placedOn = (p: FloorPlan) => rows.filter((s) => s.planId === p.id && validShape(s.planShape));
  const toReview = (p: FloorPlan) => inside(p).filter((s) => !(s.planId === p.id && validShape(s.planShape)));
  /** Lo que hay dentro de una estancia (sus camas) y está en el mismo dibujo. */
  const within = (s: SpaceRow, planId: string) => rows.filter((x) => {
    if (x.id === s.id || x.planId !== planId || !validShape(x.planShape)) return false;
    for (let up = x.parentId, guard = 0; up && guard < 20; up = rows.find((y) => y.id === up)?.parentId ?? null, guard++) if (up === s.id) return true;
    return false;
  });

  // --- El mapa (todos) ------------------------------------------------------------------------------------------
  function buildViewer(): void {
    viewer?.destroy();
    viewer = createSpaceMap({
      source: spaces, label: 'Mapa de zonas', feedbackId: 'central.planos.mapa',
      plans: {
        list: async () => (await spaces.plans.list()).map(uploaded),
        subscribe: (listener) => spaces.plans.subscribe!((next) => listener(next.map(uploaded))),
      },
      planUrl: (fileId) => r.fileUrl(fileId),
      // «Colocar» guarda aquí lo que la pieza avisa: la forma, en su dibujo.
      onShape: (space, planId, shape) => save(space.id, planId, shape),
    });
    replace(viewerHost, viewer.element);
  }

  // --- Guardar: un lote por gesto, con su «Deshacer» -------------------------------------------------------------
  /** Lo que falta por guardar, por estancia; sale en **un** lote (la habitación con sus camas va junta). */
  const batch = new Map<string, Placement>();
  /** Cómo estaba cada estancia antes del gesto, para «Deshacer» todo junto. */
  const before = new Map<string, Placement>();
  let undoLabel: string | null = null;
  let batchTimer: ReturnType<typeof setTimeout> | null = null;

  /** Apunta cómo estaba la estancia antes de cambiarla (solo la primera vez en el gesto). */
  function remember(id: string): void {
    const row = rows.find((s) => s.id === id);
    if (row && !before.has(id)) before.set(id, { planId: row.planId ?? null, shape: row.planShape ? { points: row.planShape.points.map(([x, y]) => [x, y]) } : null });
  }
  function save(id: string, planId: string | null, shape: PlanShape | null): void {
    batch.set(id, { planId, shape });
    if (batchTimer) clearTimeout(batchTimer);
    batchTimer = setTimeout(() => void flush(), 350);
  }
  async function flush(): Promise<void> {
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    if (!batch.size) { before.clear(); undoLabel = null; return; }
    const entries = [...batch]; batch.clear();
    const undo = undoLabel ? new Map([...before].filter(([id]) => entries.some(([e]) => e === id))) : null;
    const label = undoLabel;
    before.clear(); undoLabel = null;
    try {
      const ops: RowOperation[] = [];
      for (const [id, p] of entries) ops.push({ op: 'update', table: SPACES, id, expectedRevision: Number((await r.get(SPACES, id))?.revision ?? 0), fields: spaceToFields({ planId: p.planId, planShape: p.shape }) });
      await r.commit(ops);
      if (undo?.size && label && alive) toastWithAction(label, { label: 'Deshacer', onClick: () => restore(undo) });
    } catch (e) { toast(describeError(e)); }
  }
  /** «Deshacer»: todas las del gesto vuelven a donde estaban, en un lote. */
  function restore(undo: Map<string, Placement>): void {
    for (const [id, p] of undo) {
      const row = rows.find((s) => s.id === id);
      if (row) { row.planId = p.planId; row.planShape = p.shape; }
      if (p.planId && p.shape) viewer?.setShape(id, p.planId, p.shape); else save(id, p.planId, p.shape);
    }
    if (batchTimer) clearTimeout(batchTimer);
    void flush();
    paintEditor();
  }
  /** Una forma nueva o cambiada: por la pieza (`setShape` → `onShape`), que también la enseña ya en el mapa. */
  function setShape(id: string, planId: string, shape: PlanShape): void {
    const row = rows.find((s) => s.id === id);
    if (row) { row.planId = planId; row.planShape = shape; }
    viewer?.setShape(id, planId, shape);
  }
  /** Mover o estirar a mano: la estancia y lo que tiene dentro, con la misma traslación y escala, y con «Deshacer». */
  function reshape(s: SpaceRow, plan: FloorPlan, from: PlanShape, to: PlanShape, inner: Array<[SpaceRow, PlanShape]>, how: 'movida' | 'estirada'): void {
    remember(s.id);
    for (const [x] of inner) remember(x.id);
    setShape(s.id, plan.id, to);
    for (const [x, start] of inner) setShape(x.id, plan.id, follow(start, from, to));
    const n = inner.length;
    const along = !n ? '' : inner.every(([x]) => x.kind === 'cama') ? (n === 1 ? ' con su cama' : ` con sus ${n} camas`) : ' con lo que tiene dentro';
    undoLabel = `${how === 'movida' ? 'Movida' : 'Estirada'} «${s.name}»${along}.`;
  }

  // --- Dibujos (owner, ordenador) ---------------------------------------------------------------------------------
  function paintTools(): void {
    for (const b of binds.splice(0)) b();
    if (!canPlace()) { replace(tools); return; }
    if (!media.matches) {
      replace(tools, el('p', { class: 'note', id: 'placeOnDesktop' }, icon('info', 16), ' Para subir dibujos y colocar las estancias, abre Planos en el ordenador. Aquí se ve el mapa.'));
      return;
    }
    const sorted = [...plans].sort((a, b) => planName(a).localeCompare(planName(b), 'es') || a.position - b.position);
    // Sin red, todo lo que escribe dibujos se apaga con un solo motivo.
    const why = renderOfflineReason({ reason: 'Subir, sustituir y quitar dibujos necesita conexión.', retry: () => void r.sync().catch(() => undefined) });
    why.id = 'planOffline';
    const upload = el('button', { type: 'button', class: 'primary', id: 'newPlan', 'data-feedback-id': 'central.planos.dibujos.subir', 'data-feedback-label': 'Subir un dibujo', onclick: () => openUpload(null) }, icon('upload', 16), 'Subir un dibujo');
    const online: HTMLElement[] = [upload];
    replace(tools,
      el('div', { class: 'blockhead' }, el('h3', null, 'Dibujos'), upload),
      why,
      sorted.length ? el('ul', { class: 'list', id: 'planList' }, ...sorted.map((p) => {
        const placed = placedOn(p).length;
        const review = toReview(p).length;
        const busyId = `planBusy-${p.id}`;
        const remove = el('button', { type: 'button', class: 'ghost small', 'aria-label': `Quitar el dibujo de ${planName(p)}`, disabled: placed > 0 || undefined, 'aria-describedby': placed ? busyId : undefined,
          'data-feedback-id': 'central.planos.dibujos.quitar', 'data-feedback-label': 'Quitar el dibujo', onclick: () => void removePlan(p) }, icon('trash', 16), 'Quitar');
        const replaceBtn = el('button', { type: 'button', class: 'ghost small', 'aria-label': `Sustituir el dibujo de ${planName(p)}`, 'data-feedback-id': 'central.planos.dibujos.sustituir', 'data-feedback-label': 'Sustituir el dibujo', onclick: () => openUpload(p) }, 'Sustituir');
        online.push(replaceBtn);
        if (!placed) online.push(remove);
        return el('li', { class: 'agentrow ctl-planrow', 'data-plan': p.id },
          el('div', null, el('strong', null, planName(p)),
            el('div', { class: 'muted small' }, [`${placed} ${placed === 1 ? 'colocada' : 'colocadas'}`, review ? `${review} por revisar` : 'todo colocado', pendingFile(p) ? 'dibujo pendiente de subir' : p.fileId ? null : 'sin dibujo'].filter(Boolean).join(' · ')),
            placed ? el('div', { class: 'muted small', id: busyId }, 'Tiene estancias encima: para quitarlo, quítalas antes del plano.') : null),
          el('span', { class: 'ctl-planactions' },
            el('button', { type: 'button', class: 'softbtn small', 'aria-label': `Colocar en ${planName(p)}`, 'data-feedback-id': 'central.planos.dibujos.colocar', 'data-feedback-label': 'Colocar', onclick: () => openEditor(p.id) }, 'Colocar'),
            replaceBtn,
            remove));
      })) : el('p', { class: 'hint' }, 'Aún no hay dibujos. Sube uno por edificio y planta (SVG, PNG o JPG).'));
    for (const b of online) binds.push(bindOnline(b, { client: r, line: why }));
  }

  /** Subir un dibujo nuevo, o sustituir uno (`plan`): las formas se conservan porque son relativas a la imagen. */
  function openUpload(plan: FloorPlan | null): void {
    let sheet: Sheet | null = null;
    const error = el('p', { class: 'formerror', role: 'alert' });
    const buildings = rows.filter((s) => s.active && (s.kind === 'edificio' || s.kind === 'exterior')).sort((a, b) => a.name.localeCompare(b.name, 'es'));
    const building = el('select', { id: 'planBuilding', 'aria-label': 'Edificio' }, ...buildings.map((b) => el('option', { value: b.id }, spacePath(index(), b.id)))) as HTMLSelectElement;
    const floor = el('input', { id: 'planFloor', type: 'text', maxlength: '40', placeholder: 'Planta baja', autocomplete: 'off' }) as HTMLInputElement;
    const file = el('input', { id: 'planFile', type: 'file', accept: PLAN_MIME.join(',') }) as HTMLInputElement;
    const submit = el('button', { type: 'button', class: 'primary', id: 'planSubmit', 'data-feedback-id': 'central.planos.subir.guardar', 'data-feedback-label': 'Guardar el dibujo', onclick: async () => {
      error.textContent = '';
      const f = file.files?.[0];
      if (!f) { error.textContent = 'Elige el dibujo: SVG, PNG o JPG.'; return; }
      const mime = f.type || (f.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '');
      if (!PLAN_MIME.includes(mime)) { error.textContent = 'El dibujo debe ser SVG, PNG o JPG.'; return; }
      if (f.size > 10 * 1024 * 1024) { error.textContent = 'El dibujo pasa de 10 MB.'; return; }
      // Del SVG se sube el limpio (DOMPurify), nunca el original: el servidor rechaza el que lleve contenido activo.
      const raw = mime === 'image/svg+xml' ? await f.text() : null;
      const svgText = raw === null ? null : cleanSvg(raw);
      if (raw !== null && svgText === null) { error.textContent = activeContent(raw) ? ACTIVE_SVG : 'No se ha podido leer el dibujo. Prueba con otro archivo.'; return; }
      const blob: Blob = svgText !== null ? new Blob([svgText], { type: 'image/svg+xml' }) : f;
      const size = await imageSize(blob, svgText);
      if (!size) { error.textContent = 'No se ha podido leer el dibujo. Prueba con otro archivo.'; return; }
      if (!plan && !building.value) { error.textContent = 'Elige el edificio.'; return; }
      submit.disabled = true;
      try {
        const sha = await r.stageBlob(blob, { filename: `plano.${mime === 'image/svg+xml' ? 'svg' : mime.split('/')[1]}`, mime });
        const id = plan?.id ?? crypto.randomUUID();
        const old = localUrls.get(id);
        if (old) URL.revokeObjectURL(old);
        localUrls.set(id, URL.createObjectURL(blob));
        if (plan) {
          const current = await r.get(PLANS, plan.id);
          await r.commit([{ op: 'update', table: PLANS, id, expectedRevision: Number(current?.revision ?? 0), fields: { file_id: { $blob: sha }, width: size.width, height: size.height } }]);
        } else {
          await r.commit([{ op: 'insert', table: PLANS, id, fields: { building_id: building.value, floor: floor.value.trim() || null, position: plans.length, file_id: { $blob: sha }, width: size.width, height: size.height } }]);
        }
        void sheet?.close(true);
        toast(plan ? 'Dibujo sustituido: las estancias siguen en su sitio.' : 'Dibujo subido.');
        // Si el SVG trae los nombres, se colocan solas las que aún no tienen forma.
        if (svgText !== null) setTimeout(() => autoPlace(id, svgText, !!plan), 0);
        openEditor(id);
      } catch (e) { error.textContent = describeError(e); } finally { submit.disabled = false; }
    } }, plan ? 'Sustituir' : 'Subir');
    const unbind = bindOnline(submit, { client: r, reason: 'El dibujo se sube con conexión.' });
    sheet = openSheet({
      title: plan ? `Sustituir el dibujo · ${planName(plan)}` : 'Subir un dibujo',
      body: el('div', { 'data-feedback-id': 'central.planos.subir.formulario', 'data-feedback-label': 'Dibujo' },
        plan ? el('p', { class: 'muted' }, 'Las estancias colocadas se conservan: su forma es relativa a la imagen. Si el dibujo nuevo cambia mucho, recolócalas.')
          : el('label', { class: 'field', 'data-feedback-id': 'central.planos.subir.edificio', 'data-feedback-label': 'Edificio' }, el('span', null, 'Edificio'), building),
        plan ? null : el('label', { class: 'field', 'data-feedback-id': 'central.planos.subir.planta', 'data-feedback-label': 'Planta' }, el('span', null, 'Planta (opcional)'), floor),
        el('label', { class: 'field', 'data-feedback-id': 'central.planos.subir.archivo', 'data-feedback-label': 'Archivo del dibujo' }, el('span', null, 'Dibujo (SVG, PNG o JPG, hasta 10 MB)'), file),
        el('p', { class: 'hint' }, 'Si es un SVG con los nombres de las estancias, se colocan solas.'),
        error),
      panelAttrs: { 'data-feedback-id': 'central.planos.subir', 'data-feedback-label': 'Subir un dibujo' },
      closeAttrs: { 'data-feedback-id': 'central.planos.subir.cerrar', 'data-feedback-label': 'Cerrar' },
      foot: [submit],
      onClose: () => unbind(),
    });
  }

  async function removePlan(p: FloorPlan): Promise<void> {
    if (placedOn(p).length) { toast('Tiene estancias encima: quítalas antes del plano.'); return; }
    if (!(await confirmDialog({ title: `¿Quitar el dibujo de ${planName(p)}?`, text: 'Las estancias no se tocan. Se puede volver a subir.', confirmLabel: 'Quitar', danger: true }))) return;
    try {
      const current = await r.get(PLANS, p.id);
      await r.commit([{ op: 'delete', table: PLANS, id: p.id, expectedRevision: Number(current?.revision ?? 0) }]);
      if (editing === p.id) closeEditor();
      toast('Dibujo quitado.');
    } catch (e) { toast(describeError(e)); }
  }

  /**
   * «Colocar solo»: las estancias del edificio que el SVG nombra. Sustituyendo, solo las que no tenían forma. Las que
   * nombra pero no se pueden leer van a «Por revisar» con el motivo; el aviso dice qué nombres no son de ninguna estancia.
   */
  function autoPlace(planId: string, svgText: string, onlyMissing: boolean): void {
    const plan = plans.find((p) => p.id === planId) ?? { id: planId, buildingId: '', floor: null, position: 0, fileId: null, width: 1, height: 1 } as FloorPlan;
    const read = readSvgPlan(svgText);
    if (!read) { toast('Este dibujo no se puede leer: colócalas a mano.'); return; }
    const candidates = (plan.buildingId ? inside(plan) : rows.filter((s) => s.active && !CONTAINERS.has(s.kind)))
      .filter((s) => !onlyMissing || !(s.planId && validShape(s.planShape)));
    const { placed, skipped } = matchShapes(read, candidates);
    for (const { space, points } of placed) { reviewWhy.delete(space.id); setShape(space.id, planId, { points }); }
    for (const { space, reason } of skipped) reviewWhy.set(space.id, reason);
    // Lo que no coincide con ninguna estancia de Recursos (no solo con las candidatas), sin los nombres del programa.
    const known = new Set(rows.flatMap((s) => [s.name, s.publicName, s.code]).filter((k): k is string => !!k).map(foldName));
    const unknown = [...new Set(read.shapes.map((s) => s.name).filter((n) => !generatedName(n) && !known.has(foldName(n))))];
    unmatchedOf.set(planId, unknown);
    const left = plan.buildingId ? toReview(plan).length : 0;
    const head = placed.length ? `${placed.length} ${placed.length === 1 ? 'estancia colocada sola' : 'estancias colocadas solas'}${left ? `; ${left} por revisar` : ''}.`
      : skipped.length ? `Ninguna se ha colocado sola; ${skipped.length} por revisar.` : 'El dibujo no trae nombres de estancias: colócalas a mano.';
    toast(unknown.length ? `${head} ${unmatchedText(unknown)}` : head, unknown.length ? 9000 : 3200);
    paintEditor();
  }
  const unmatchedText = (names: string[]) => `Sin estancia con ese nombre: ${names.slice(0, UNMATCHED_SHOWN).map((n) => `«${n}»`).join(', ')}${names.length > UNMATCHED_SHOWN ? ` y +${names.length - UNMATCHED_SHOWN} más` : ''}.`;

  // --- Colocar a mano ---------------------------------------------------------------------------------------------
  let selected: string | null = null;
  function openEditor(planId: string): void { editing = planId; selected = null; editor.hidden = false; paintEditor(); editor.scrollIntoView({ block: 'start' }); }
  function closeEditor(): void { for (const b of editorBinds.splice(0)) b(); editing = null; selected = null; editor.hidden = true; replace(editor); }

  function paintEditor(): void {
    if (!editing || !alive) return;
    const plan = plans.find((p) => p.id === editing);
    if (!plan || !canPlace() || !media.matches) { closeEditor(); return; }
    for (const b of editorBinds.splice(0)) b();
    // Repintar no quita el foco: si estaba en una estancia (o en un botón con su id), vuelve a ella.
    const focused = editor.contains(document.activeElement) ? (document.activeElement as HTMLElement | SVGElement | null) : null;
    const focusKey = focused?.getAttribute('data-space-id') ? `[data-space-id="${CSS.escape(focused.getAttribute('data-space-id')!)}"]` : focused?.id ? `#${CSS.escape(focused.id)}` : null;
    const w = plan.width; const h = plan.height;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('class', 'ctl-placesvg');
    svg.setAttribute('role', 'group');
    svg.setAttribute('aria-label', `Colocar en ${planName(plan)}`);
    const paper = document.createElementNS(NS, 'rect');
    paper.setAttribute('width', String(w)); paper.setAttribute('height', String(h)); paper.setAttribute('class', 'ctl-placepaper');
    svg.append(paper);
    if (plan.fileId) {
      const image = document.createElementNS(NS, 'image');
      image.setAttribute('width', String(w)); image.setAttribute('height', String(h)); image.setAttribute('preserveAspectRatio', 'none');
      // El SVG va como imagen: nunca se mete en la página. Recién subido, desde este dispositivo.
      const local = localUrls.get(plan.id);
      if (local) image.setAttribute('href', local);
      else if (typeof plan.fileId === 'string') void r.fileUrl(plan.fileId).then((u) => image.setAttribute('href', u)).catch(() => undefined);
      svg.append(image);
    }
    const placed = placedOn(plan);
    const labels: SVGTextElement[] = [];
    const handles: SVGRectElement[] = [];
    for (const s of placed) {
      const shape = s.planShape as PlanShape;
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', pointsAttr(shape, plan));
      poly.setAttribute('class', `ctl-placeshape${selected === s.id ? ' on' : ''}${s.kind === 'cama' ? ' bed' : ''}`);
      poly.setAttribute('tabindex', '0');
      poly.setAttribute('role', 'button');
      poly.setAttribute('data-space-id', s.id);
      poly.setAttribute('aria-label', `${s.name}: con las flechas se mueve; con Mayúsculas y las flechas, se estira`);
      poly.setAttribute('aria-pressed', String(selected === s.id));
      poly.addEventListener('pointerdown', (e) => startDrag(e, s, 'move', plan, svg));
      poly.addEventListener('keydown', (e) => onKey(e, s, plan));
      poly.addEventListener('focus', () => { if (selected !== s.id) { selected = s.id; paintEditor(); svg.ownerDocument.querySelector<SVGElement>(`#placeEditor [data-space-id="${CSS.escape(s.id)}"]`)?.focus(); } });
      svg.append(poly);
      const c = shapeCenter(shape);
      const label = document.createElementNS(NS, 'text');
      const fontSize = Math.max(Math.min(c.w * w, c.h * h) * 0.22, Math.max(w, h) * 0.012);
      label.setAttribute('x', String(c.x * w)); label.setAttribute('y', String(c.y * h)); label.setAttribute('class', 'ctl-placelabel');
      label.setAttribute('font-size', String(fontSize));
      // El halo del rótulo sobre el dibujo, el de la pieza del kit: proporcional a la letra, porque el dibujo escala.
      label.setAttribute('stroke-width', String(fontSize * 0.2));
      label.setAttribute('aria-hidden', 'true');
      label.setAttribute('data-label-for', s.id);
      label.textContent = s.kind === 'cama' ? (s.code ?? s.name) : s.name;
      labels.push(label);
      if (selected === s.id) {
        const b = boxOf(shape);
        for (const [hx, hy, ax, ay] of [[b.x0, b.y0, b.x1, b.y1], [b.x1, b.y0, b.x0, b.y1], [b.x1, b.y1, b.x0, b.y0], [b.x0, b.y1, b.x1, b.y0]] as const) {
          const handle = document.createElementNS(NS, 'rect');
          const size = Math.max(w, h) * 0.014;
          handle.setAttribute('x', String(hx * w - size / 2)); handle.setAttribute('y', String(hy * h - size / 2));
          handle.setAttribute('width', String(size)); handle.setAttribute('height', String(size)); handle.setAttribute('class', 'ctl-placehandle');
          handle.setAttribute('aria-hidden', 'true');
          handle.addEventListener('pointerdown', (e) => startDrag(e, s, [ax, ay], plan, svg));
          handles.push(handle);
        }
      }
    }
    // Los rótulos, encima de todas las formas (el de una habitación no queda bajo sus camas), y las esquinas para estirar,
    // encima de todo: si no, la estancia de al lado las tapaba.
    svg.append(...labels, ...handles);
    const review = toReview(plan);
    const current = selected ? rows.find((s) => s.id === selected) ?? null : null;
    const unknown = unmatchedOf.get(plan.id) ?? [];
    const autoBtn = el('button', { type: 'button', class: 'ghost', id: 'autoPlace', 'data-feedback-id': 'central.planos.colocar.solo', 'data-feedback-label': 'Colocar solo', onclick: () => void autoFromFile(plan) }, 'Colocar solo (SVG con nombres)');
    replace(editor,
      el('div', { class: 'blockhead' }, el('h3', null, `Colocar · ${planName(plan)}`),
        el('button', { type: 'button', class: 'linkbtn', id: 'closePlace', 'data-feedback-id': 'central.planos.colocar.cerrar', 'data-feedback-label': 'Cerrar Colocar', onclick: () => closeEditor() }, 'Cerrar')),
      el('p', { class: 'hint' }, 'Arrastra una estancia para moverla y sus esquinas para estirarla; sus camas la acompañan. Con el teclado: Tab hasta la estancia, las flechas la mueven y, con Mayúsculas, la estiran. Se guarda solo.'),
      el('div', { class: 'ctl-place' },
        el('div', { class: 'ctl-placestage' }, svg),
        el('div', { class: 'ctl-placeside' },
          el('div', { class: 'toolbar' }, autoBtn,
            current ? el('button', { type: 'button', class: 'ghost', id: 'unplace', 'data-feedback-id': 'central.planos.colocar.quitar', 'data-feedback-label': 'Quitar del plano', onclick: () => unplace(current) }, `Quitar «${current.name}» del plano`) : null),
          unknown.length ? el('p', { class: 'hint', id: 'placeUnmatched' }, icon('info', 16), ` ${unmatchedText(unknown)} Renómbralos en el dibujo o en Recursos y vuelve a «Colocar solo».`) : null,
          el('h4', { class: 'sectionlabel', id: 'placeReviewHead' }, `Por revisar · ${review.length}`),
          review.length ? el('ul', { class: 'list', id: 'placeReview' }, ...review.map((s) => el('li', { class: 'agentrow', 'data-space': s.id },
            el('span', null, el('strong', null, s.name), el('span', { class: 'muted small' }, ` · ${s.parentId ? spacePath(index(), s.parentId) : ''}`),
              reviewWhy.has(s.id) ? el('span', { class: 'muted small ctl-placewhy', id: `placeWhy-${s.id}` }, `No se ha colocado sola: ${reviewWhy.get(s.id)}.`) : null),
            el('button', { type: 'button', class: 'ghost small', 'aria-label': `Poner ${s.name} en el plano`, 'aria-describedby': reviewWhy.has(s.id) ? `placeWhy-${s.id}` : undefined,
              'data-feedback-id': 'central.planos.colocar.poner', 'data-feedback-label': 'Poner en el plano', onclick: () => putOn(s, plan) }, 'Poner'))))
            : el('p', { class: 'hint' }, 'Todas las estancias de este edificio tienen su sitio.'),
          el('h4', { class: 'sectionlabel' }, `En el plano · ${placed.length}`),
          placed.length ? el('ul', { class: 'list', id: 'placePlaced' }, ...placed.map((s) => el('li', null,
            el('button', { type: 'button', class: `linkbtn${selected === s.id ? ' on' : ''}`, 'data-space': s.id, 'data-feedback-id': 'central.planos.colocar.elegir', 'data-feedback-label': 'Elegir estancia', onclick: () => { selected = s.id; paintEditor(); } }, s.name)))) : null)));
    // «Colocar solo» lee el dibujo del servidor: sin red, apagado con su motivo.
    editorBinds.push(bindOnline(autoBtn, { client: r, reason: 'Colocar solo lee el dibujo con conexión.' }));
    if (focusKey) editor.querySelector<HTMLElement | SVGElement>(focusKey)?.focus({ preventScroll: true });
  }

  /** Una estancia sin forma va al centro del dibujo, como un rectángulo; las camas, más pequeñas y dentro de su habitación. */
  function putOn(s: SpaceRow, plan: FloorPlan): void {
    const parent = s.parentId ? rows.find((x) => x.id === s.parentId && x.planId === plan.id && validShape(x.planShape)) : null;
    const shape = parent ? (() => { const c = shapeCenter(parent.planShape as PlanShape); return rect(c.x, c.y, Math.max(c.w / 4, 0.015), Math.max(c.h / 4, 0.015)); })()
      : s.kind === 'cama' ? rect(0.5, 0.5, 0.03, 0.03) : rect(0.5, 0.5, 0.12, 0.1);
    selected = s.id;
    reviewWhy.delete(s.id);
    setShape(s.id, plan.id, shape);
    paintEditor();
    editor.querySelector<SVGElement>(`[data-space-id="${CSS.escape(s.id)}"]`)?.focus();
  }

  function unplace(s: SpaceRow): void {
    s.planId = null; s.planShape = null;
    selected = null;
    batch.delete(s.id); before.delete(s.id);
    void Promise.resolve(spaces.update(s.id, { planId: null, planShape: null })).then(() => buildViewer()).catch((e: unknown) => toast(describeError(e)));
    paintEditor();
  }

  function onKey(e: KeyboardEvent, s: SpaceRow, plan: FloorPlan): void {
    const step = e.altKey ? 0.002 : 0.01;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key] as [number, number] | undefined;
    if (!d) return;
    e.preventDefault();
    const shape = s.planShape as PlanShape;
    const b = boxOf(shape);
    const next = e.shiftKey ? stretched(shape, [b.x0, b.y0], b.x1 - b.x0 + d[0], b.y1 - b.y0 + d[1]) : moved(shape, d[0], d[1]);
    const inner = within(s, plan.id).map((x) => [x, x.planShape as PlanShape] as [SpaceRow, PlanShape]);
    reshape(s, plan, shape, next, inner, e.shiftKey ? 'estirada' : 'movida');
    // Con el teclado, sin «Deshacer» para lo suelto (la flecha contraria lo deshace); con sus camas, sí.
    if (!inner.length) undoLabel = null;
    paintEditor();
    editor.querySelector<SVGElement>(`[data-space-id="${CSS.escape(s.id)}"]`)?.focus();
  }

  /** Arrastrar: mover la forma, o estirarla desde la esquina contraria (`anchor`). Las camas de dentro la acompañan. */
  function startDrag(e: PointerEvent, s: SpaceRow, how: 'move' | readonly [number, number], plan: FloorPlan, svg: SVGSVGElement): void {
    e.preventDefault();
    selected = s.id;
    const box = svg.getBoundingClientRect();
    const start = s.planShape as PlanShape;
    const inner = within(s, plan.id).map((x) => [x, x.planShape as PlanShape] as [SpaceRow, PlanShape]);
    const x0 = e.clientX; const y0 = e.clientY;
    const target = e.target as Element;
    target.setPointerCapture?.(e.pointerId);
    let next: PlanShape = start;
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - x0) / box.width; const dy = (ev.clientY - y0) / box.height;
      if (how === 'move') next = moved(start, dx, dy);
      else {
        const b = boxOf(start);
        const corner: [number, number] = [how[0] === b.x0 ? b.x1 : b.x0, how[1] === b.y0 ? b.y1 : b.y0];
        const nx = corner[0] + dx; const ny = corner[1] + dy;
        next = stretched(start, [how[0], how[1]], Math.abs(nx - how[0]), Math.abs(ny - how[1]));
        const nb = boxOf(next);
        // Hacia el otro lado del ancla: se refleja la posición, no la forma.
        next = moved(next, nx < how[0] ? how[0] - (nb.x1 - nb.x0) - nb.x0 : 0, ny < how[1] ? how[1] - (nb.y1 - nb.y0) - nb.y0 : 0);
      }
      // Mientras se arrastra, solo se pinta (la estancia y sus camas); se guarda al soltar.
      svg.querySelector(`[data-space-id="${CSS.escape(s.id)}"]`)?.setAttribute('points', pointsAttr(next, plan));
      for (const [x, from] of inner) svg.querySelector(`[data-space-id="${CSS.escape(x.id)}"]`)?.setAttribute('points', pointsAttr(follow(from, start, next), plan));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (next !== start && validShape(next)) reshape(s, plan, start, next, inner, how === 'move' ? 'movida' : 'estirada');
      paintEditor();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  /** «Colocar solo» sobre un dibujo ya subido: se lee el archivo (si es SVG) y se colocan las que faltan. */
  async function autoFromFile(plan: FloorPlan): Promise<void> {
    if (!plan.fileId) { toast('Este plano no tiene dibujo: sube uno.'); return; }
    try {
      const local = localUrls.get(plan.id);
      if (!local && typeof plan.fileId !== 'string') { toast('El dibujo aún está subiendo: prueba en un momento.'); return; }
      const res = await fetch(local ?? await r.fileUrl(plan.fileId as string));
      const text = await res.text();
      if (!/<svg[\s>]/i.test(text)) { toast('Este dibujo no es un SVG con nombres: colócalas a mano.'); return; }
      autoPlace(plan.id, text, true);
    } catch { toast('No se ha podido leer el dibujo: prueba con conexión o colócalas a mano.'); }
  }

  // --- Datos ------------------------------------------------------------------------------------------------------
  const repaint = () => { if (!alive) return; paintTools(); paintEditor(); };
  const offRows = spaces.subscribe((next) => { rows = next.map((s) => ({ ...s })); repaint(); });
  const offPlans = spaces.plans.subscribe?.((next) => { plans = next; repaint(); }) ?? null;
  // Si el servidor rechaza el SVG (no debería: se sube limpio), se dice una vez y por qué.
  let warnedActive = false;
  const offStatus = r.onStatus((s) => {
    if (s.lastError?.code === 'UNSUPPORTED_MEDIA') { if (!warnedActive) toast(ACTIVE_SVG, 9000); warnedActive = true; } else warnedActive = false;
    repaint();
  });
  const onMedia = () => repaint();
  media.addEventListener('change', onMedia);
  void Promise.all([spaces.list(), spaces.plans.list()]).then(([s, p]) => { rows = s.map((x) => ({ ...x })); plans = p; repaint(); });
  buildViewer();
  return () => {
    alive = false;
    void flush();
    for (const b of binds.splice(0)) b();
    for (const b of editorBinds.splice(0)) b();
    offRows(); offPlans?.(); offStatus(); media.removeEventListener('change', onMedia);
    viewer?.destroy(); spaces.destroy();
    for (const u of localUrls.values()) URL.revokeObjectURL(u);
  };
};
