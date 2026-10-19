/**
 * Ficha de una reserva (tanda 27, MUELA-020 y 067 §3): portada, foco con lo que toca, el recorrido común de cinco etapas
 * y las pestañas por área. Ningún bloque desaparece ni cambia de id: cada uno tiene su pestaña, y «Todo» enseña la
 * ficha entera como hasta ahora (se recuerda en el dispositivo). Lo de dentro de cada bloque lo pinta su módulo.
 */
import { createFocus, el, renderAreaTabs, renderCover, renderStages, replace, type Focus, type FocusItem, type MedalOptions } from '@ikisai/ui-kit';
import { JOURNEY, PHASE_LABELS, daysText, journeyLabel, nextText, type BlockId, type Experience, type JourneyStage, type Step } from '@ikisai/domain-booking';
import { PHASE_COLORS } from '../app/experience.ts';

export type TabKey = 'resumen' | 'comercial' | 'operacion' | 'huespedes' | 'dinero' | 'todo';

const TAB_LABELS: Record<TabKey, string> = { resumen: 'Resumen', comercial: 'Comercial', operacion: 'Operación', huespedes: 'Huéspedes', dinero: 'Dinero', todo: 'Todo' };

/** Mapa bloque → pestaña: los 17 bloques de hoy (más el Extracto) tienen sitio. */
export const TAB_OF: Record<BlockId | 'financeExtract', Exclude<TabKey, 'todo'>> = {
  blockSummary: 'resumen', blockOpenRetreat: 'resumen', blockProgram: 'resumen',
  blockDates: 'comercial', blockProposal: 'comercial', blockPortal: 'comercial', blockPortalRequests: 'comercial',
  blockOperation: 'operacion', blockLodging: 'operacion', blockStaff: 'operacion', blockChecklist: 'operacion', blockMeals: 'operacion',
  blockSes: 'huespedes', blockGuests: 'huespedes',
  financeExtract: 'dinero', blockFinance: 'dinero', blockCosts: 'dinero',
};

const REMEMBER_KEY = 'booking.ficha.todo';
const remembered = (): boolean => { try { return localStorage.getItem(REMEMBER_KEY) === '1'; } catch { return false; } };
const remember = (all: boolean) => { try { if (all) localStorage.setItem(REMEMBER_KEY, '1'); else localStorage.removeItem(REMEMBER_KEY); } catch { /* sin almacenamiento */ } };

export interface FichaLayoutOptions {
  writable: boolean;
  seesMoney: boolean;
  seesAll: boolean;
  logo: string | null;
  faces: MedalOptions[];
  signed: string | null;
  nights: number | null;
  /** «Confirmar la reserva» y los pasos sin bloque. */
  onStep(step: Step): void;
}

/** Montaje que vive mientras la ficha está abierta: conserva la pestaña y el foco entre repintados. */
export function createFichaLayout() {
  let tab: TabKey | null = null;
  let focus: Focus | null = null;
  let act: (item: FocusItem) => void = () => undefined;
  const host = el('div', { class: 'bk-ficha' });

  function tabsFor(o: FichaLayoutOptions): TabKey[] {
    return ['resumen', ...(o.writable ? ['comercial' as const] : []), 'operacion', 'huespedes', ...(o.seesMoney ? ['dinero' as const] : []), 'todo'];
  }

  function defaultTab(x: Experience | null, o: FichaLayoutOptions): TabKey {
    if (remembered()) return 'todo';
    if (x?.next?.block) return TAB_OF[x.next.block];
    switch (x?.phase) {
      case 'comercial': return o.writable ? 'comercial' : 'resumen';
      case 'preparacion': case 'curso': return 'operacion';
      case 'cierre': return o.seesMoney ? 'dinero' : 'operacion';
      default: return 'resumen';
    }
  }

  /** Lleva a un bloque: abre su pestaña, lo enseña y le pasa el foco. */
  function goTo(block: string): void {
    const target = TAB_OF[block as BlockId];
    if (target && tab !== 'todo') { tab = target; applyTab(); }
    const node = host.querySelector<HTMLElement>(`#${block}`);
    if (!node) return;
    node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    const head = node.querySelector<HTMLElement>('h3');
    if (head) { head.tabIndex = -1; head.focus({ preventScroll: true }); }
  }

  function applyTab(): void {
    for (const panel of host.querySelectorAll<HTMLElement>('[data-tab-panel]')) panel.hidden = tab !== 'todo' && panel.dataset.tabPanel !== tab;
    for (const button of host.querySelectorAll<HTMLElement>('#reservationTabs [data-tab]')) {
      const on = button.dataset.tab === tab;
      button.classList.toggle('active', on);
      button.setAttribute('aria-pressed', String(on));
    }
  }

  /**
   * Pinta la ficha. `blocks` son los bloques de hoy ya construidos (null si no tocan); `requested` es el bloque al que
   * se llega desde Inicio o Reservas («Siguiente»).
   */
  function render(title: string, x: Experience | null, blocks: Array<HTMLElement | null>, o: FichaLayoutOptions, requested: BlockId | null): HTMLElement {
    const tabs = tabsFor(o);
    if (requested && tab !== 'todo') tab = TAB_OF[requested];
    if (!tab || !tabs.includes(tab)) tab = defaultTab(x, o);

    // Portada: logo (o el color de la fase) y la fase; las cifras con su nombre; hasta 5 caras y «+n».
    const cover = x ? renderCover({
      title, image: o.logo, color: PHASE_COLORS[x.phase], compact: true,
      pill: PHASE_LABELS[x.phase], pillTone: x.rush ? 'warn' : null,
      stats: [x.people, o.nights !== null ? `${o.nights} ${o.nights === 1 ? 'noche' : 'noches'}` : null, daysText(x.daysLeft, x.phase), o.signed].filter(Boolean).join(' · ') || null,
      faces: o.faces,
    }) : null;
    cover?.setAttribute('id', 'reservationCover');

    // Foco: lo que toca primero en grande, «Siguiente ›» rota por lo pendiente. El lector no ve acciones.
    const items: FocusItem[] = (x?.steps ?? []).map((s, i) => ({ id: s.key, title: s.text, kicker: i === 0 ? 'Lo siguiente' : null, tone: s.tone }));
    act = (item) => { const step = x?.steps.find((s) => s.key === item.id); if (step) (step.block ? goTo(step.block) : o.onStep(step)); };
    if (!focus) focus = createFocus({ label: 'Lo que toca', items, onOpen: o.writable ? (item) => act(item) : undefined, emptyTitle: o.seesAll ? 'Todo listo' : 'Nada pendiente', emptyText: x ? nextText({ next: null, phase: x.phase }, o.seesAll) : '', feedbackId: 'booking.reserva.foco' });
    else focus.setItems(items);
    focus.element.id = 'reservationFocus';
    const phaseAction = o.writable && x?.next ? el('button', { type: 'button', class: 'primary', id: 'phaseAction', 'data-feedback-id': 'booking.reserva.foco.accion', 'data-feedback-label': 'Hacer lo siguiente',
      onclick: () => { const s = x.next!; if (s.block) goTo(s.block); else o.onStep(s); } }, x.next.text) : null;

    // Recorrido común de cinco etapas; «!» en la de ahora si tiene algo pendiente. Tocar una etapa abre su pestaña.
    const stageTab: Record<JourneyStage, TabKey> = { captacion: o.writable ? 'comercial' : 'resumen', senal: o.seesMoney ? 'dinero' : o.writable ? 'comercial' : 'resumen', preparacion: 'operacion', estancia: 'huespedes', cierre: o.seesMoney ? 'dinero' : 'operacion' };
    const journey = renderStages({
      label: 'Recorrido de la reserva', stages: JOURNEY.map((key) => ({ key, label: journeyLabel(key, o.seesMoney) })), current: x?.journey ?? null,
      bad: x?.journey && x.next ? [x.journey] : [], stopText: 'Cancelada o perdida', feedbackId: 'booking.reserva.recorrido',
      onPick: (key) => { tab = stageTab[key as JourneyStage]; applyTab(); },
    });
    journey.id = 'reservationJourney';

    // Pestañas con su estado: cuántas cosas pendientes tiene cada una.
    const pendingIn = (key: TabKey) => (x?.steps ?? []).filter((s) => s.block && TAB_OF[s.block] === key).length;
    const strip = renderAreaTabs({
      label: 'Áreas de la reserva', attrs: { id: 'reservationTabs' },
      items: tabs.map((key) => ({ label: TAB_LABELS[key], active: key === tab, count: key === 'todo' ? 0 : pendingIn(key), countText: `${pendingIn(key)} pendientes`, attrs: { 'data-tab': key, 'data-feedback-id': 'booking.reserva.pestanas.pestana', 'data-feedback-label': 'Pestaña' } })),
    });
    strip.addEventListener('click', (e) => {
      const key = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab as TabKey | undefined;
      if (!key) return;
      tab = key;
      remember(key === 'todo');
      applyTab();
    });

    const panels = tabs.filter((k) => k !== 'todo').map((key) => el('div', { class: 'cardgrid ficha-grid', dataset: { tabPanel: key }, role: 'region', 'aria-label': TAB_LABELS[key] },
      blocks.filter((b): b is HTMLElement => b !== null && TAB_OF[b.id as BlockId] === key)));
    // Lo que no tiene pestaña conocida no se pierde: va al Resumen.
    const homeless = blocks.filter((b): b is HTMLElement => b !== null && !TAB_OF[b.id as BlockId]);
    if (homeless.length) panels[0]!.append(...homeless);

    replace(host, cover, el('div', { class: 'bk-focus' }, focus.element, phaseAction), journey, strip, ...panels);
    applyTab();
    return host;
  }

  return { render, goTo, destroy: () => { focus = null; } };
}
