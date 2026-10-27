import { confirmDialog, createCoverCarousel, el, icon, openSheet, replace, toast } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { callProcedure, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { loadProjects, loadStock, projectDates, projectState, type Project, type StockItem } from '../app/data.ts';
import { addDocument, coverUrl, loadCodeGuides, moveDocument, projectDocuments, removeDocument, setCover, type ProjectDocument } from '../app/documents.ts';
import { assignGuestNumbers, chooseBookingEvent, chooseTasksProject } from '../app/links.ts';
import type { ViewMount } from './shell.ts';

/**
 * Inicio de un flujo (canon V1 §2.2; navegación de VG del 26-10):
 * - Arriba, el carrusel de flujos (como lo ven los huéspedes): deslizar cambia de flujo.
 * - Para el owner, el modo pruebas del flujo (VG 26-10: se cobra y se cuenta igual, pero no se envían ingresos a Finance).
 * - Debajo, los documentos del flujo (guías) con miniaturas para ir directo a uno y «Ampliar» para verlo entero. Las
 *   miniaturas se precargan; el tamaño completo solo se descarga al ampliar (FLOW-DIR-001 §6). Nunca salen en la carta
 *   pública (§15.3). Son archivos del proyecto (0907) que el owner sube, ordena y quita; la v1 sigue con las guías del
 *   código mientras no tenga documentos propios. Un PDF se abre aparte.
 */
export const mountHome: ViewMount = ({ main, client, navigate, projectId }) => {
  const isOwner = client.bootstrap()?.membership.role === 'owner';
  let docs: ProjectDocument[] = [];
  let current = 0;
  const carouselHost = el('div', { class: 'flow-carousel' });
  const testHost = el('div', { class: 'flow-testmode' });
  const docsHost = el('section', { class: 'flow-docs', 'data-feedback-id': 'flow.inicio.guias', 'data-feedback-label': 'Guías' });
  const stockHost = el('section', { class: 'flow-stock', 'data-feedback-id': 'flow.inicio.existencias', 'data-feedback-label': 'Existencias' });
  main.append(carouselHost, testHost, stockHost, docsHost);

  const covers = new Map<string, string | null>();
  void loadProjects(client).then(async (projects) => {
    if (!projects.length) return;
    await Promise.all(projects.map(async (p) => covers.set(p.id, await coverUrl(client, p))));
    const index = Math.max(0, projects.findIndex((p) => p.id === projectId));
    const carousel = createCoverCarousel({
      label: 'Tus flujos',
      index,
      slides: projects.map((p) => ({ id: p.id, title: p.name, image: covers.get(p.id) ?? p.cover_image, state: projectState(p), meta: projectDates(p) || null })),
      onChange: (slide) => { if (slide.id !== projectId) navigate(`#/p/${slide.id}`); },
      feedbackId: 'flow.inicio.flujos',
    });
    replace(carouselHost, carousel.element);
    paintTestMode(projects.find((p) => p.id === projectId) ?? null);
  });

  function paintTestMode(project: Project | null): void {
    if (!project) { replace(testHost); return; }
    if (!isOwner) {
      replace(testHost, ...(project.test_mode ? [el('p', { class: 'flow-testmode-pill' }, 'Modo pruebas: el cierre no envía ingresos a Finance')] : []));
      return;
    }
    const input = el('input', { type: 'checkbox', checked: project.test_mode, onchange: async () => {
      input.disabled = true;
      try {
        await client.commit([{ op: 'update', table: TABLES.projects, id: project.id, expectedRevision: project.revision, fields: { test_mode: input.checked } }]);
        toast(input.checked ? 'Modo pruebas activado: el cierre no enviará ingresos a Finance.' : 'Modo pruebas desactivado.');
      } catch (error) { input.checked = !input.checked; toast(describeError(error)); }
      finally { input.disabled = false; }
    } });
    replace(testHost, el('label', { class: 'flow-testmode-switch' }, input,
      el('span', null, el('strong', null, 'Modo pruebas'), el('small', { class: 'muted' }, ' · se cobra y se cuenta igual, pero el cierre no envía ingresos a Finance'))),
      // Versiones (VG 27-10): una versión congelada no cambia de configuración; la nueva nace en modo pruebas.
      el('div', { class: 'orders-owner flow-version' },
        project.frozen ? el('p', { class: 'muted small' }, `Versión ${project.template_version ?? ''} congelada: su configuración no cambia.`) : null,
        project.template_key ? el('button', { type: 'button', class: 'ghost', onclick: () => void newVersion(project) }, 'Nueva versión del flujo') : null,
        el('button', { type: 'button', class: 'ghost', onclick: () => pickFile('image/*', (file) => setCover(client, project, file, file.name || 'portada.webp').then(() => toast('Portada cambiada.'))) }, 'Cambiar portada'),
        el('button', { type: 'button', class: 'ghost', onclick: () => manageDocuments() }, 'Gestionar documentos'),
        el('label', { class: 'flow-public-switch' }, el('input', { type: 'checkbox', checked: project.serves_public, onchange: (e: Event) => void servePublic(project, (e.target as HTMLInputElement).checked) }),
          el('span', null, 'Atiende la carta pública'))),
      // Enlaces del flujo (owner): su evento de Booking y su proyecto de Tasks.
      el('div', { class: 'orders-owner flow-links' },
        el('button', { type: 'button', class: 'ghost', onclick: () => void chooseBookingEvent(client, project) }, project.booking_event_id ? 'Evento de Booking: cambiar' : 'Ligar a un evento de Booking'),
        el('button', { type: 'button', class: 'ghost', onclick: () => void chooseTasksProject(client, project) }, project.tasks_project_id ? 'Proyecto de Tasks: cambiar' : 'Elegir proyecto de Tasks'),
        // Cuentas (v2, 0910): los huéspedes del evento con su número, para cargarles a cuenta y pedir desde Guests.
        project.booking_event_id && !project.frozen ? el('button', { type: 'button', class: 'ghost', onclick: () => void assignGuestNumbers(client, project) }, 'Dar número a los huéspedes') : null));
  }

  async function newVersion(project: Project): Promise<void> {
    if (!isOnline(client)) { toast('Necesita conexión.'); return; }
    const ok = await confirmDialog({ title: 'Nueva versión del flujo', confirmLabel: 'Crear versión',
      text: 'Se copia la configuración (columnas, carta, reglas, puntos de existencias vacíos, enlaces y portada), sin pedidos, clientes, pagos ni cierres. Nace en modo pruebas y sin atender la carta pública. Recuerda dar acceso al personal en Central.' });
    if (!ok) return;
    try {
      const out = await callProcedure<{ project_id: string; name: string }>(client, PROCEDURES.newVersion, { source_project_id: project.id, project_id: crypto.randomUUID() });
      await client.sync();
      toast(`Creada «${out.name}».`);
      navigate(`#/p/${out.project_id}`);
    } catch (error) { toast(describeError(error)); }
  }

  /** Solo un flujo atiende la carta pública: se quita del que la tenía y se pone en este (en ese orden, en el mismo lote). */
  async function servePublic(project: Project, on: boolean): Promise<void> {
    try {
      const all = await loadProjects(client);
      const current = all.find((p) => p.serves_public && p.id !== project.id);
      const ops: unknown[] = [];
      if (on && current) ops.push({ op: 'update', table: TABLES.projects, id: current.id, expectedRevision: current.revision, fields: { serves_public: false } });
      ops.push({ op: 'update', table: TABLES.projects, id: project.id, expectedRevision: project.revision, fields: { serves_public: on } });
      await client.commit(ops as any);
      toast(on ? `La carta pública sale ahora de «${project.name}».` : 'Este flujo ya no atiende la carta pública.');
    } catch (error) { toast(describeError(error)); }
  }

  const figure = el('figure', { class: 'guide-figure' });
  const thumbs = el('div', { class: 'guide-thumbs', role: 'tablist', 'aria-label': 'Guías' });

  function show(i: number): void {
    if (!docs.length) return;
    current = (i + docs.length) % docs.length;
    const d = docs[current]!;
    replace(figure,
      el('button', { type: 'button', class: 'guide-open', 'aria-label': `${d.isPdf ? 'Abrir' : 'Ampliar'}: ${d.title}`, onclick: () => enlarge(current) },
        d.isPdf ? el('span', { class: 'guide-pdf' }, icon('attach', 40), el('span', null, 'PDF')) : el('img', { src: d.thumb, alt: d.title, decoding: 'async' })),
      el('figcaption', null, el('span', null, d.title), el('span', { class: 'muted small' }, `${current + 1} de ${docs.length}`)));
    thumbs.querySelectorAll('.guide-thumb').forEach((b, j) => b.setAttribute('aria-selected', String(j === current)));
  }

  function enlarge(i: number): void {
    const d = docs[i]!;
    if (d.isPdf) { window.open(d.full, '_blank', 'noopener'); return; }
    openSheet({
      title: d.title,
      body: el('div', { class: 'guide-zoom' },
        el('img', { src: d.full, alt: d.title, decoding: 'async' }),
        el('a', { href: d.full, target: '_blank', rel: 'noopener' }, 'Abrir a pantalla completa')),
    });
  }

  /** Elegir un archivo del dispositivo. */
  function pickFile(accept: string, then: (file: File) => Promise<void>): void {
    const input = el('input', { type: 'file', accept }) as HTMLInputElement;
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      if (!file) return;
      try { await then(file); } catch (error) { toast(describeError(error)); }
    });
    input.click();
  }

  /** Owner: subir, ordenar y quitar documentos; la primera vez, cargar las guías de la barra del código. */
  function manageDocuments(): void {
    if (!projectId) return;
    const list = el('ul', { class: 'flow-docs-admin' });
    const paintList = async () => {
      const rows = (await projectDocuments(client, projectId)).filter((d) => d.rowId);
      replace(list, ...(rows.length ? rows.map((d, i) => el('li', null,
        el('span', null, `${d.title}${d.isPdf ? ' (PDF)' : ''}`),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': `Subir ${d.title}`, disabled: i === 0, onclick: () => void moveDocument(client, projectId, d.rowId!, -1).then(paintList) }, icon('chevronUp', 18)),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': `Bajar ${d.title}`, disabled: i === rows.length - 1, onclick: () => void moveDocument(client, projectId, d.rowId!, 1).then(paintList) }, icon('chevronDown', 18)),
        el('button', { type: 'button', class: 'iconbtn', 'aria-label': `Quitar ${d.title}`, onclick: () => void confirmDialog({ title: `¿Quitar «${d.title}»?`, confirmLabel: 'Quitar', danger: true })
          .then((ok) => (ok ? removeDocument(client, projectId, d.rowId!).then(paintList) : undefined)) }, icon('trash', 18))))
        : [el('li', { class: 'muted' }, 'Aún no hay documentos subidos.')]));
    };
    const title = el('input', { type: 'text', maxlength: '120', placeholder: 'Título del documento', 'aria-label': 'Título' }) as HTMLInputElement;
    openSheet({
      title: 'Documentos del flujo',
      body: el('div', null, list, el('div', { class: 'flow-docs-add' }, title)),
      foot: el('div', { class: 'flow-actions' },
        el('button', { type: 'button', class: 'ghost', onclick: () => void loadCodeGuides(client, projectId).then((n) => { toast(n ? `${n} guías cargadas.` : 'Ya hay documentos: no se cargan las guías.'); void paintList(); }).catch((e) => toast(describeError(e))) }, 'Cargar las guías de la barra'),
        el('button', { type: 'button', class: 'primary', onclick: () => pickFile('image/*,application/pdf', async (file) => {
          await addDocument(client, projectId, file, title.value.trim() || file.name.replace(/\.[^.]+$/, '') || 'Documento', file.name || 'documento');
          title.value = ''; toast('Documento subido.'); await paintList();
        }) }, 'Subir documento')),
    });
    void paintList();
  }

  void projectDocuments(client, projectId).then((list) => {
    docs = list;
    if (!docs.length) { replace(docsHost, el('p', { class: 'muted' }, 'Este flujo aún no tiene guías.')); return; }
    replace(thumbs, ...docs.map((d, i) => el('button', { type: 'button', class: 'guide-thumb', role: 'tab', 'aria-label': d.title, onclick: () => show(i) },
      d.isPdf ? el('span', { class: 'guide-pdf small' }, 'PDF') : el('img', { src: d.thumb, alt: '', loading: 'lazy', decoding: 'async' }))));
    replace(docsHost,
      el('h2', { class: 'col-title' }, 'Guías'),
      el('div', { class: 'guide-carousel' },
        el('button', { type: 'button', class: 'iconbtn guide-prev', 'aria-label': 'Guía anterior', onclick: () => show(current - 1) }, icon('chevronLeft', 22)),
        figure,
        el('button', { type: 'button', class: 'iconbtn guide-next', 'aria-label': 'Guía siguiente', onclick: () => show(current + 1) }, icon('chevronRight', 22))),
      thumbs);
    show(0);
  });

  /** Existencias (paso 3): solo si el flujo tiene puntos de existencias. */
  const fmt = (n: number, unit: string) => new Intl.NumberFormat('es-ES', { maximumFractionDigits: unit === 'ud' ? 0 : 2 }).format(n);
  function place(item: StockItem, key: 'mesa' | 'nevera' | 'fresco'): HTMLElement {
    const p = item.places[key];
    if (!p) return el('td', { class: 'muted' }, '—');
    const low = p.capacity > 0 && p.level < p.capacity * p.threshold_pct / 100;
    return el('td', { class: low ? 'stock-low' : '' }, `${fmt(p.level, item.unit)} / ${fmt(p.capacity, item.unit)}`);
  }
  async function paintStock(): Promise<void> {
    if (!projectId) return;
    const items = await loadStock(client, projectId);
    if (!items.length) { replace(stockHost); return; }
    replace(stockHost, el('h2', { class: 'col-title' }, 'Existencias'),
      el('table', { class: 'closure-products stock-table' },
        el('thead', null, el('tr', null, el('th', null, 'Ingrediente'), el('th', null, 'Mesa'), el('th', null, 'Nevera'), el('th', null, 'Fresco'), el('th', null, 'Hoy'))),
        el('tbody', null, ...items.map((i) => el('tr', null, el('td', null, `${i.name} (${i.unit})`), place(i, 'mesa'), place(i, 'nevera'), place(i, 'fresco'),
          el('td', null, fmt(i.consumed_today, i.unit)))))));
  }
  void paintStock();
  const offStock = [TABLES.buffers, TABLES.units].map((t) => client.onTable(t, () => void paintStock()));

  const off = client.onTable(TABLES.projects, () => { void loadProjects(client).then((ps) => paintTestMode(ps.find((p) => p.id === projectId) ?? null)); });
  return () => { off(); offStock.forEach((f) => f()); };
};
