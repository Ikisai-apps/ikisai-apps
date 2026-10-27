import { el, renderCover, replace } from '@ikisai/ui-kit';
import { TABLES } from '@ikisai/domain-flow';
import { loadProjects, projectDates, projectState, type Project } from '../app/data.ts';
import { coverUrl } from '../app/documents.ts';
import { createCheckinFlow } from '../app/links.ts';
import { editorLinks } from './editor.ts';
import type { ViewMount } from './shell.ts';

/**
 * Pantalla inicial del personal (decisión de VG del 26-10): la lista de FLUJOS, uno por evento (un proyecto nace y muere
 * con un evento o entre eventos), el más actual arriba, como tarjetas apaisadas con su portada (`renderCover` del kit).
 * Tocar una tarjeta es entrar en el flujo. Cada persona ve sus proyectos (ámbitos, 0902); Dirección, todos.
 */
export const mountProjects: ViewMount = ({ main, client, navigate }) => {
  const list = el('div', { class: 'flows', role: 'list', 'aria-label': 'Flujos' });
  const isOwner = client.bootstrap()?.membership.role === 'owner';
  main.append(el('h1', { class: 'col-title' }, 'Flujos'),
    ...(isOwner ? [el('div', { class: 'orders-owner' }, editorLinks(client), el('button', { type: 'button', class: 'ghost',
      onclick: async () => { const id = await createCheckinFlow(client); if (id) navigate(`#/p/${id}`); } }, 'Nuevo flujo de llegadas'))] : []),
    list);

  async function paint(): Promise<void> {
    const projects = await loadProjects(client);
    const covers = new Map(await Promise.all(projects.map(async (p) => [p.id, await coverUrl(client, p)] as const)));
    if (!projects.length) {
      replace(list, el('p', { class: 'muted' }, 'Aún no tienes ningún flujo asignado. Pide acceso a Dirección.'));
      return;
    }
    replace(list, ...projects.map((p: Project) => el('div', { class: `flow-card${p.status === 'closed' ? ' is-closed' : ''}`, role: 'listitem' },
      renderCover({
        title: p.name,
        image: covers.get(p.id) ?? p.cover_image,
        pill: projectState(p),
        pillTone: p.status === 'active' && p.starts_on && projectState(p).startsWith('Ahora') ? 'ok' : null,
        stats: projectDates(p) || null,
        headingLevel: 2,
        onOpen: () => navigate(`#/p/${p.id}`),
        feedbackId: 'flow.flujos.tarjeta',
      }))));
  }

  const off = client.onTable(TABLES.projects, () => void paint());
  void paint();
  return off;
};
