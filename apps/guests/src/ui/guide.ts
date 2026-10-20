/**
 * «Guía del retiro» (MUELA-037 con el consolidado 071, tanda 31): Información práctica, Materiales y Preguntas en una sola
 * página. Arriba, «Te faltan N preguntas de tu organizador · Se guardan solas» y «Tu organizador ha publicado N
 * materiales nuevos», que llevan a su sección; un índice fijo (Llegar · Estancia · Materiales · Preguntas · Contacto); y
 * las secciones, con el contacto arriba durante el retiro y al final antes.
 * - **Llegar**: el lugar de Central (dirección, «Ver en el mapa» y el plano del centro dentro, en un desplegable) y los
 *   textos de llegada y aparcamiento. **Estancia**: los demás textos de Central, abiertos.
 * - **Materiales**: con «Nuevo» en lo que no se ha abierto y «Guardar para verlo sin conexión».
 * - **Preguntas** (`questionsBlock`): solo después del aviso de protección de datos y nunca con la familia junta (son
 *   datos de una persona), como antes.
 * Las rutas de siempre (`…/info`, `…/materiales`, `…/preguntas`) abren esta página en su sección.
 */
import { el, icon, replace } from '@ikisai/ui-kit';
import { commonText, contactEmail, contactPhone, INFO_KEYS } from '../app/common-texts.ts';
import type { GuestContext } from '../app/context.ts';
import { t } from '../app/i18n.ts';
import { inWindow, type Material, type Question } from '../app/portal.ts';
import { backLink, centralText, fbMark, staleNote } from './common.ts';
import { momentOf } from './home.ts';
import { markSeen, materialRow, seenMaterials } from './materials.ts';
import type { Modules } from './nav.ts';
import { verEnPlano } from './plan.ts';
import { answered, questionsBlock, type QuestionsBlock } from './questions.ts';

export type GuideSection = 'llegar' | 'estancia' | 'materiales' | 'preguntas' | 'contacto';

export interface GuideOptions {
  base: string;
  userId: string;
  during: boolean;
  modules: Modules;
  /** Sección a la que se llega (por la ruta de siempre). */
  section?: GuideSection | null;
  /** Aviso de protección de datos aceptado (las preguntas son datos de la persona). */
  privacyOk: boolean;
  /** Abre el aviso para poder responder (la ruta de Preguntas lo pide). */
  privacyHref: string;
  /** La familia junta: sin preguntas. */
  family: boolean;
}

const LLEGAR = ['info.arrival', 'info.parking'] as const;
const ESTANCIA = ['info.facilities', 'info.rules', 'info.bring'] as const;

/** Un texto de Central plegable, abierto, con su nota si solo existe en español. */
function centralCard(key: (typeof INFO_KEYS)[number]): HTMLElement | null {
  const text = commonText(key);
  if (!text) return null;
  return el('details', { class: 'card ggroup', 'data-key': key, open: '', 'data-feedback-id': 'guests.info.seccion.abrir', 'data-feedback-label': 'Sección de información' },
    el('summary', null, el('span', null, text.title ?? t(key))), centralText(text.body, text.spanishOnly));
}

/** Contacto de Ikisai (de Central). */
export function contactCard(during: boolean, title = true): HTMLElement {
  const phone = contactPhone();
  const email = contactEmail();
  return el('section', { class: 'card gcard', id: 'infoContact', 'data-feedback-id': 'guests.info.contacto', 'data-feedback-label': 'Contacto de Ikisai' },
    title ? el('h3', null, t('info.contact')) : null,
    el('div', { class: 'btnrow' },
      phone ? el('a', { class: during ? 'primary' : 'ghost', href: `tel:${phone.replace(/\s+/g, '')}`, id: 'infoCall', 'data-feedback-id': 'guests.info.contacto.llamar', 'data-feedback-label': 'Llamar a Ikisai' }, icon('help', 16), t('home.call', { phone })) : null,
      email ? el('a', { class: 'ghost', href: `mailto:${email}`, id: 'infoMail', 'data-feedback-id': 'guests.info.contacto.escribir', 'data-feedback-label': 'Escribir a Ikisai' }, t('info.write', { email })) : null));
}

/** El lugar de Central: nombre, dirección, «Ver en el mapa» y el plano del centro dentro (desplegable). */
export function placeCard(ctx: Pick<GuestContext, 'reads'>): HTMLElement {
  const host = el('div', { id: 'infoPlace' });
  void ctx.reads.place().then((loaded) => {
    const p = loaded?.value;
    if (!p || (!p.address && !p.map_url && !p.site_plan_file_id)) return;
    const map = p.map_url && /^https:\/\//.test(p.map_url) ? p.map_url : null;
    replace(host, el('section', { class: 'card gcard', 'data-feedback-id': 'guests.info.lugar', 'data-feedback-label': 'El lugar' },
      el('h3', null, p.name ?? 'Ikisai'),
      p.address ? el('p', { id: 'infoAddress' }, icon('pin', 16), ' ', p.address) : null,
      map ? el('div', { class: 'btnrow' }, el('a', { class: 'primary', href: map, target: '_blank', rel: 'noopener', id: 'infoMap', 'data-feedback-id': 'guests.info.mapa.abrir', 'data-feedback-label': 'Ver en el mapa' }, icon('pin', 16), t('info.map'))) : null,
      verEnPlano({ place: null, whole: true, label: t('plan.center'), id: 'infoPlan', reads: ctx.reads, mark: (n) => fbMark(n, 'guests.info.plano.ver', 'Ver el plano del centro') })));
  }).catch(() => undefined);
  return host;
}

export function mountGuide(main: HTMLElement, ctx: GuestContext, options: GuideOptions): () => void {
  let alive = true;
  let materials: Material[] = [];
  let questions: Question[] = [];
  let staleAt: string | null = ctx.staleAt();
  let block: QuestionsBlock | null = null;
  const preview = ctx.readOnly();
  const mods = options.modules;
  const showQuestions = mods.questions && !options.family;
  /** «Nuevo» de esta visita: lo visto ahora quita el «Nuevo» en la siguiente (las notas, al haber estado en pantalla). */
  const seenAtStart = seenMaterials(options.userId);
  let observer: IntersectionObserver | null = null;

  const pendingQuestions = () => questions.filter((q) => q.open && !answered(q)).length;
  const newMaterials = () => (preview ? [] : materials.filter((m) => !seenAtStart.has(m.id)));

  async function load(): Promise<void> {
    const [mats, qs] = await Promise.all([
      mods.materials ? ctx.reads.materials(ctx.grant.reservation_id).catch(() => null) : null,
      showQuestions && options.privacyOk ? ctx.reads.questions(ctx.grant.reservation_id, ctx.grant.guest_id).catch(() => null) : null,
    ]);
    if (!alive) return;
    const moment = momentOf(ctx.guest());
    materials = (mats?.value.items ?? []).filter((m) => inWindow(m.window, moment));
    questions = qs?.value.items ?? [];
    staleAt = [mats?.stale ? mats.at : null, qs?.stale ? qs.at : null, ctx.staleAt()].find(Boolean) ?? null;
    await paint();
    if (options.section) {
      const target = main.querySelector<HTMLElement>(`#w-${options.section}`);
      target?.scrollIntoView({ block: 'start' });
      target?.focus({ preventScroll: true });
    }
  }

  const go = (id: GuideSection) => (event: Event) => {
    event.preventDefault();
    const target = main.querySelector<HTMLElement>(`#w-${id}`);
    target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    target?.focus({ preventScroll: true });
  };

  async function paint(): Promise<void> {
    block?.destroy();
    block = null;
    observer?.disconnect();
    const pending = pendingQuestions();
    const news = newMaterials();
    const rows = await Promise.all(materials.map((item) => materialRow(item, {
      ctx, userId: options.userId, isNew: !preview && !seenAtStart.has(item.id),
      onSeen: () => { if (!preview) markSeen(options.userId, item.id); },
    })));
    if (!alive) return;
    const sec = (id: GuideSection, title: string, ...body: Array<HTMLElement | null>) =>
      el('section', { class: 'gsec', id: `w-${id}`, tabindex: '-1', 'aria-labelledby': `w-${id}-h` }, el('h3', { class: 'gsec-head', id: `w-${id}-h` }, title), ...body);
    const texts = (keys: readonly (typeof INFO_KEYS)[number][]) => keys.map(centralCard).filter((x): x is HTMLElement => Boolean(x));
    const llegar = sec('llegar', t('guide.arrive'), placeCard(ctx), ...texts(LLEGAR));
    const stayTexts = texts(ESTANCIA);
    const estancia = sec('estancia', t('guide.stay'), ...(stayTexts.length ? stayTexts : [el('p', { class: 'card gcard muted', id: 'infoSoon' }, t('info.soon'))]));
    const materialsSec = mods.materials ? sec('materiales', t('materials.title'),
      rows.some(Boolean) ? el('div', { id: 'materialsList' }, ...rows) : el('p', { class: 'card gcard muted', id: 'materialsEmpty' }, t('materials.empty'))) : null;
    if (showQuestions && options.privacyOk && questions.length) block = questionsBlock(ctx, questions, () => void paintTop());
    const questionsSec = showQuestions ? sec('preguntas', t('questions.title'),
      !options.privacyOk
        ? el('p', { class: 'card gcard' }, t('guide.privacyFirst'), ' ', el('a', { href: options.privacyHref, 'data-feedback-id': 'guests.preguntas.aviso.abrir', 'data-feedback-label': 'Abrir el aviso de protección de datos' }, t('guide.privacyOpen')))
        : block ? block.element : el('p', { class: 'card gcard muted', id: 'questionsEmpty' }, t('questions.empty'))) : null;
    const contact = sec('contacto', t('info.contact'), contactCard(options.during, false));
    const index = el('nav', { class: 'gindex', 'aria-label': t('guide.onThisPage'), 'data-feedback-id': 'guests.info.indice', 'data-feedback-label': 'Índice de la guía' },
      el('a', { href: '#w-llegar', onclick: go('llegar') }, t('guide.arrive')),
      el('a', { href: '#w-estancia', onclick: go('estancia') }, t('guide.stayShort')),
      materialsSec ? el('a', { href: '#w-materiales', onclick: go('materiales') }, t('guide.materials'), news.length ? ` · ${t('guide.newCount', { count: news.length })}` : '') : null,
      questionsSec ? el('a', { href: '#w-preguntas', onclick: go('preguntas') }, t('guide.questions'), pending ? ` · ${pending}` : '') : null,
      el('a', { href: '#w-contacto', onclick: go('contacto') }, t('guide.contact')));
    replace(main,
      backLink(options.base),
      staleAt ? staleNote(staleAt) : null,
      el('div', { class: 'pagehead' }, el('h2', null, t('guide.title')), el('p', { class: 'muted' }, t('info.intro'))),
      el('div', { id: 'guideTop' }),
      index,
      el('div', { id: 'infoSections' }, ...(options.during ? [contact, llegar, estancia, materialsSec, questionsSec] : [llegar, estancia, materialsSec, questionsSec, contact])));
    paintTop();
    // Una nota de texto cuenta como vista cuando ha estado en pantalla un segundo («Nuevo» se va en la visita siguiente).
    if (!preview && typeof IntersectionObserver === 'function') {
      const timers = new Map<Element, ReturnType<typeof setTimeout>>();
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.material!;
          if (entry.isIntersecting) timers.set(entry.target, setTimeout(() => markSeen(options.userId, id), 1000));
          else clearTimeout(timers.get(entry.target));
        }
      }, { threshold: 0.5 });
      for (const note of main.querySelectorAll<HTMLElement>('section.gmaterial[data-material]:not([data-file])')) observer.observe(note);
    }
  }

  /** Los avisos de arriba (cambian al responder). */
  function paintTop(): void {
    const top = main.querySelector('#guideTop');
    if (!top) return;
    const pending = showQuestions && options.privacyOk ? pendingQuestions() : 0;
    const news = newMaterials().length;
    replace(top,
      pending ? el('a', { class: 'gtodo', href: '#w-preguntas', onclick: go('preguntas'), 'data-feedback-id': 'guests.preguntas.aviso.ir', 'data-feedback-label': 'Ir a las preguntas' },
        el('span', { class: 'gbadge' }, String(pending)),
        el('span', null, el('strong', null, t('guide.questionsLeft', { count: pending })), el('span', { class: 'small' }, t('guide.saveThemselves'))), icon('chevronRight', 16)) : null,
      news ? el('a', { class: 'gtodo gtodo-news', href: '#w-materiales', onclick: go('materiales'), 'data-feedback-id': 'guests.materiales.aviso.ir', 'data-feedback-label': 'Ir a los materiales nuevos' },
        el('span', { class: 'gnew' }, t('materials.new')),
        el('span', null, el('strong', null, t('guide.newMaterials', { count: news })), el('span', { class: 'small' }, t('guide.notOpened'))), icon('chevronRight', 16)) : null);
    // El índice lleva los mismos recuentos.
    const qLink = main.querySelector('.gindex a[href="#w-preguntas"]');
    if (qLink) qLink.textContent = `${t('guide.questions')}${pending ? ` · ${pending}` : ''}`;
  }

  void paint().then(load);
  return () => { alive = false; block?.destroy(); observer?.disconnect(); };
}
