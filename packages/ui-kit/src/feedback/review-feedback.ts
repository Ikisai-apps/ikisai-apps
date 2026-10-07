/**
 * Revisor › Incidencias (FEEDBACK.md §9): «Por revisar» (`reviewStatus = 'new'`) y «Por comprobar»
 * (`display = 'pending_verify'`) de todas las apps, y la tarjeta con aprobar, descartar, unir, funciona y sigue fallando.
 */
import { el, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { toast } from '../toast.ts';
import type { FeedbackReport } from './client.ts';
import { FEEDBACK_INTENT_LABELS, type FeedbackIntent } from './constants.ts';
import { appVersion } from './context.ts';
import { reportChip, type FeedbackReportDetail } from './center.ts';
import type { ReviewHost, ReviewTab } from './review.ts';

export type ReviewReport = FeedbackReport & { reviewStatus?: string; routeRaw?: string | null };
type ReviewDetail = FeedbackReportDetail & { report: ReviewReport; context?: { steps?: { route?: string; node?: string; action?: string }[] } };

export const FB_PARAM = 'fb';

export function createFeedbackReviewTab(host: ReviewHost): ReviewTab & { goTo(r: Pick<FeedbackReport, 'code' | 'originApp'>): Promise<void>; show(code: string): Promise<void> } {
  let items: ReviewReport[] = [];
  let current: string | null = null;

  const toReview = () => items.filter((r) => r.reviewStatus === 'new');
  const toCheck = () => items.filter((r) => r.reviewStatus !== 'new' && r.display === 'pending_verify');
  /** Orden de «Siguiente»: primero por revisar, luego por comprobar. */
  const queue = () => [...toReview(), ...toCheck()];
  const firstLine = (text: string) => text.split('\n')[0]!.slice(0, 120);

  function row(r: ReviewReport): HTMLElement {
    return el('li', null, el('button', {
      type: 'button', class: `fb-review-row${r.code === current ? ' on' : ''}`, dataset: { code: r.code, app: r.originApp },
      'aria-current': r.code === current ? 'true' : null,
      onclick: () => void goTo(r),
    },
      el('span', { class: 'fb-card-head' },
        el('span', { class: 'chip small', dataset: { app: r.originApp } }, el('span', null, r.originApp)),
        el('strong', { class: 'fb-code' }, r.code),
        r.blocking ? el('span', { class: 'chip small alert' }, el('span', null, 'Me bloquea')) : null,
        r.supportersCount > 1 ? el('small', { class: 'fb-review-sup' }, `+${r.supportersCount - 1}`) : null),
      el('span', { class: 'fb-card-msg' }, firstLine(r.message))));
  }

  async function goTo(r: Pick<FeedbackReport, 'code' | 'originApp'>): Promise<void> {
    if (r.originApp && r.originApp !== host.app) { host.openApp(r.originApp, { [FB_PARAM]: r.code }); return; }
    await show(r.code);
  }

  async function show(code: string): Promise<void> {
    current = code;
    host.repaint();
    let detail: ReviewDetail;
    try { detail = await host.api<ReviewDetail>(`/feedback/${encodeURIComponent(code)}`); }
    catch { toast(`No se pudo abrir ${code}.`); current = null; return; }
    const r = detail.report;
    const { element, exact } = await host.goToNode(r.routeRaw, r.node?.id);
    paintCard(detail, element, exact);
  }

  function paintCard(detail: ReviewDetail, anchor: Element | null, exact: boolean): void {
    const r = detail.report;
    const card = host.card;
    const status = el('p', { class: 'fb-status', role: 'status' });
    const reason = el('textarea', { class: 'fb-message', rows: '2', maxlength: '500', 'aria-label': 'Motivo', hidden: true }) as HTMLTextAreaElement;
    const into = el('input', { type: 'text', class: 'fb-merge-into', placeholder: 'FB_2026_0001', 'aria-label': 'Código del reporte que se queda', hidden: true }) as HTMLInputElement;
    const next = () => { const q = queue(); const at = q.findIndex((x) => x.code === r.code); return q[at + 1] ?? (at < 0 ? q[0] : null) ?? null; };
    const act = async (path: string, json: unknown, done: string, buttons: HTMLButtonElement[]) => {
      buttons.forEach((b) => { b.disabled = true; });
      try {
        await host.api(`/feedback/${encodeURIComponent(r.id)}/${path}`, { method: 'POST', json });
        toast(done);
        const nextOne = next();
        items = items.filter((x) => x.code !== r.code);
        if (nextOne) void goTo(nextOne); else host.closeCard();
        void host.refresh();
      } catch (error) {
        buttons.forEach((b) => { b.disabled = false; });
        status.className = 'fb-status error';
        status.textContent = (error as { code?: string }).code === 'OUT_OF_SCOPE' ? 'No se encontró ese reporte.' : 'No se pudo guardar. Prueba otra vez con conexión.';
      }
    };

    const buttons: HTMLButtonElement[] = [];
    const btn = (cls: string, label: string, onclick: () => void) => { const b = el('button', { type: 'button', class: cls, onclick }, label) as HTMLButtonElement; buttons.push(b); return b; };
    const isNew = r.reviewStatus === 'new';
    const isCheck = r.display === 'pending_verify';
    const dismiss = btn('ghost fb-rv-dismiss', 'Descartar', () => {
      if (reason.hidden) { reason.hidden = false; into.hidden = true; reason.placeholder = 'Motivo (lo verá quien lo informó)'; dismiss.textContent = 'Confirmar descarte'; reason.focus(); return; }
      if (!reason.value.trim()) { reason.focus(); return; }
      void act('dismiss', { reason: reason.value.trim() }, 'Descartado.', buttons);
    });
    const merge = btn('ghost fb-rv-merge', 'Unir a…', () => {
      if (into.hidden) { into.hidden = false; reason.hidden = true; merge.textContent = 'Unir'; into.focus(); return; }
      const target = into.value.trim().toUpperCase();
      if (!/^FB_\d{4}_\d{3,}$/.test(target) || target === r.code) { status.className = 'fb-status error'; status.textContent = 'Escribe el código del otro reporte (FB_AAAA_NNNN).'; into.focus(); return; }
      void act('merge', { into: target }, `Unido a ${target}.`, buttons);
    });
    const approve = btn('primary fb-rv-approve', 'Aprobar para arreglar', () => void act('approve', {}, 'Aprobado: pasa al buzón del agente.', buttons));
    const works = btn('primary fb-rv-works', 'Funciona', async () => void act('verify', { build: (await appVersion())?.release ?? null }, 'Verificado.', buttons));
    const fails = btn('ghost fb-rv-fails', 'Sigue fallando', () => {
      if (reason.hidden) { reason.hidden = false; reason.placeholder = '¿Qué sigue pasando? (opcional)'; fails.textContent = 'Enviar: sigue fallando'; reason.focus(); return; }
      void act('reopen', reason.value.trim() ? { message: reason.value.trim() } : {}, 'Reabierto.', buttons);
    });
    const steps = detail.context?.steps ?? [];
    const following = next();
    replace(card,
      el('header', { class: 'fb-head' },
        el('div', { class: 'fb-where' },
          el('small', null, `${r.originApp} · ${FEEDBACK_INTENT_LABELS[r.intent as FeedbackIntent] ?? r.intent}${r.node ? ` · ${r.node.path.join(' › ')}` : ''}`),
          el('strong', null, r.code, ' ', reportChip(r.display), r.blocking ? el('span', { class: 'chip small alert' }, el('span', null, 'Me bloquea')) : null)),
        el('button', { type: 'button', class: 'iconbtn small fb-close', 'aria-label': 'Cerrar', onclick: () => host.closeCard() }, icon('close', 18))),
      exact ? null : el('p', { class: 'banner info fb-rv-approx' }, icon('info', 16), el('span', null, anchor ? 'El elemento ya no está aquí: se muestra su sección.' : 'El elemento no aparece en esta pantalla.')),
      el('p', { class: 'fb-detail-msg' }, r.message),
      r.supportersCount > 1 ? el('p', { class: 'fb-card-meta' }, `${r.supportersCount} personas`) : null,
      detail.attachments?.length ? el('div', { class: 'fb-images' }, ...detail.attachments.filter((a) => a.url).map((a) => el('a', { class: 'fb-thumb', href: a.url, target: '_blank', rel: 'noopener' }, el('img', { src: a.url, alt: 'Imagen adjunta', loading: 'lazy' })))) : null,
      steps.length ? el('details', { class: 'fb-rv-steps' }, el('summary', null, `Últimos pasos (${steps.length})`),
        el('ol', null, ...steps.map((s) => el('li', null, `${s.action ?? 'tocó'} ${s.node ?? ''} ${s.route ? `(${s.route})` : ''}`.trim())))) : null,
      reason, into, status,
      el('div', { class: 'fb-foot fb-rv-actions' },
        isNew ? dismiss : null, isNew ? merge : null, isNew ? approve : null,
        !isNew && isCheck ? fails : null, !isNew && isCheck ? works : null),
      el('div', { class: 'fb-rv-nav' },
        following ? el('button', { type: 'button', class: 'linkbtn fb-rv-next', onclick: () => void goTo(following) }, 'Siguiente', icon('chevronRight', 16)) : el('small', { class: 'hint' }, 'Es el último de la lista.')));
    host.showCard(anchor);
  }

  return {
    id: 'feedback',
    label: 'Incidencias',
    count: () => toReview().length + toCheck().length,
    async load() { items = (await host.api<{ items: ReviewReport[] }>('/feedback?review=true&app=all&limit=100')).items ?? []; },
    list(state) {
      const a = toReview();
      const b = toCheck();
      return [
        state === 'loading' && !items.length ? el('p', { class: 'hint' }, 'Cargando…') : null,
        state === 'error' ? el('p', { class: 'fb-status error' }, 'No se pudo cargar la lista. Comprueba la conexión.') : null,
        el('h3', { class: 'launcher-group' }, `Por revisar · ${a.length}`),
        a.length ? el('ul', { class: 'fb-review-list', 'aria-label': 'Por revisar', dataset: { block: 'review' } }, ...a.map(row)) : el('p', { class: 'hint fb-empty' }, 'Nada nuevo.'),
        el('h3', { class: 'launcher-group' }, `Por comprobar · ${b.length}`),
        b.length ? el('ul', { class: 'fb-review-list', 'aria-label': 'Por comprobar', dataset: { block: 'check' } }, ...b.map(row)) : el('p', { class: 'hint fb-empty' }, 'Nada pendiente de comprobar.'),
      ];
    },
    boot(params) { const code = params.get(FB_PARAM); if (!code) return false; params.delete(FB_PARAM); void show(code); return true; },
    closed() { current = null; },
    goTo,
    show,
  };
}
