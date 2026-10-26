import { confirmDialog, createCoverCarousel, el, icon, openSheet, replace, toast } from '@ikisai/ui-kit';
import { PROCEDURES, TABLES } from '@ikisai/domain-flow';
import { callProcedure, isOnline } from '../app/actions.ts';
import { describeError } from '../app/client.ts';
import { loadProjects, projectDates, projectState, type Project } from '../app/data.ts';
import { projectDocuments, type ProjectDocument } from '../app/documents.ts';
import { chooseBookingEvent, chooseTasksProject } from '../app/links.ts';
import type { ViewMount } from './shell.ts';

/**
 * Inicio de un flujo (canon V1 §2.2; navegación de VG del 26-10):
 * - Arriba, el carrusel de flujos (como lo ven los huéspedes): deslizar cambia de flujo.
 * - Para el owner, el modo pruebas del flujo (VG 26-10: se cobra y se cuenta igual, pero no se envían ingresos a Finance).
 * - Debajo, los documentos del flujo (guías) con miniaturas para ir directo a uno y «Ampliar» para verlo entero. Las
 *   miniaturas se precargan; el tamaño completo solo se descarga al ampliar (FLOW-DIR-001 §6). Nunca salen en la carta
 *   pública (§15.3). Hoy vienen del código (`projectDocuments`); después del sábado, de los archivos del proyecto.
 */
export const mountHome: ViewMount = ({ main, client, navigate, projectId }) => {
  const isOwner = client.bootstrap()?.membership.role === 'owner';
  let docs: ProjectDocument[] = [];
  let current = 0;
  const carouselHost = el('div', { class: 'flow-carousel' });
  const testHost = el('div', { class: 'flow-testmode' });
  const docsHost = el('section', { class: 'flow-docs', 'data-feedback-id': 'flow.inicio.guias', 'data-feedback-label': 'Guías' });
  main.append(carouselHost, testHost, docsHost);

  void loadProjects(client).then((projects) => {
    if (!projects.length) return;
    const index = Math.max(0, projects.findIndex((p) => p.id === projectId));
    const carousel = createCoverCarousel({
      label: 'Tus flujos',
      index,
      slides: projects.map((p) => ({ id: p.id, title: p.name, image: p.cover_image, state: projectState(p), meta: projectDates(p) || null })),
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
        el('label', { class: 'flow-public-switch' }, el('input', { type: 'checkbox', checked: project.serves_public, onchange: (e: Event) => void servePublic(project, (e.target as HTMLInputElement).checked) }),
          el('span', null, 'Atiende la carta pública'))),
      // Enlaces del flujo (owner): su evento de Booking y su proyecto de Tasks.
      el('div', { class: 'orders-owner flow-links' },
        el('button', { type: 'button', class: 'ghost', onclick: () => void chooseBookingEvent(client, project) }, project.booking_event_id ? 'Evento de Booking: cambiar' : 'Ligar a un evento de Booking'),
        el('button', { type: 'button', class: 'ghost', onclick: () => void chooseTasksProject(client, project) }, project.tasks_project_id ? 'Proyecto de Tasks: cambiar' : 'Elegir proyecto de Tasks')));
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
      el('button', { type: 'button', class: 'guide-open', 'aria-label': `Ampliar: ${d.title}`, onclick: () => enlarge(current) },
        el('img', { src: d.thumb, alt: d.title, decoding: 'async' })),
      el('figcaption', null, el('span', null, d.title), el('span', { class: 'muted small' }, `${current + 1} de ${docs.length}`)));
    thumbs.querySelectorAll('.guide-thumb').forEach((b, j) => b.setAttribute('aria-selected', String(j === current)));
  }

  function enlarge(i: number): void {
    const d = docs[i]!;
    openSheet({
      title: d.title,
      body: el('div', { class: 'guide-zoom' },
        el('img', { src: d.full, alt: d.title, decoding: 'async' }),
        el('a', { href: d.full, target: '_blank', rel: 'noopener' }, 'Abrir a pantalla completa')),
    });
  }

  void projectDocuments(projectId).then((list) => {
    docs = list;
    if (!docs.length) { replace(docsHost, el('p', { class: 'muted' }, 'Este flujo aún no tiene guías.')); return; }
    replace(thumbs, ...docs.map((d, i) => el('button', { type: 'button', class: 'guide-thumb', role: 'tab', 'aria-label': d.title, onclick: () => show(i) },
      el('img', { src: d.thumb, alt: '', loading: 'lazy', decoding: 'async' }))));
    replace(docsHost,
      el('h2', { class: 'col-title' }, 'Guías'),
      el('div', { class: 'guide-carousel' },
        el('button', { type: 'button', class: 'iconbtn guide-prev', 'aria-label': 'Guía anterior', onclick: () => show(current - 1) }, icon('chevronLeft', 22)),
        figure,
        el('button', { type: 'button', class: 'iconbtn guide-next', 'aria-label': 'Guía siguiente', onclick: () => show(current + 1) }, icon('chevronRight', 22))),
      thumbs);
    show(0);
  });

  const off = client.onTable(TABLES.projects, () => { void loadProjects(client).then((ps) => paintTestMode(ps.find((p) => p.id === projectId) ?? null)); });
  return off;
};
