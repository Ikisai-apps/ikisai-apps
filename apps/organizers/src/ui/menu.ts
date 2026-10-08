/**
 * Menú del retiro (fase 4, Fd2 y Fd3 en Food #327 y #332): la propuesta de cocina, cuando Ikisai la comparte, por días y
 * servicios. En cada plato, «Prefiero que no» o un comentario; Food los ve en la ficha del menú y responde. Las fotos son
 * miniaturas abiertas con `portal-files` (C8).
 */
import { el, openSheet, replace, toast } from '@ikisai/ui-kit';
import { describeError, errorCode, online } from '../app/client.ts';
import { commonText, textParagraphs } from '../app/common-texts.ts';
import { i18n, L, t } from '../app/i18n.ts';
import { failure, fbIgnore, loading, staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

interface Dish { menu_item_id: string; name: string; description: string | null; category: string | null; diet_tags: string[] | null; allergens: string[] | null; photo_thumb_file_id: string | null }
interface Service { service_id: string; menu_id: string; date: string; type: string; time: string | null; dishes: Dish[] }
export interface PortalMenu { available: boolean; status: 'provisional' | 'confirmado'; services: Service[] }
interface MenuComment { id: string; menu_item_id: string | null; service_id: string | null; dish: string | null; kind: 'prefiero_que_no' | 'comentario'; message: string | null; status: string; reply: string | null; created_at: string }

const SERVICES: Record<string, string> = { desayuno: L('Desayuno'), comida: L('Comida'), merienda: L('Merienda'), cena: L('Cena'), picnic: L('Pícnic'), otro: L('Otro') };
const COMMENT_STATUS: Record<string, string> = { nuevo: L('Enviado'), visto: L('Visto por cocina'), resuelto: L('Resuelto') };
const dayTitle = (day: string) => new Intl.DateTimeFormat(i18n.tag(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

export function renderMenu(ctx: ViewContext, reservationId: string): HTMLElement {
  const host = el('div', { id: 'menu' }, loading());
  let alive = true;
  const photos = new Map<string, string>();

  async function load(): Promise<void> {
    try {
      const [menu, comments] = await Promise.all([
        ctx.api.readAny<PortalMenu>('food.portal_menu', { reservation_id: reservationId }),
        ctx.api.readAny<{ items: MenuComment[] }>('food.portal_my_menu_comments', { reservation_id: reservationId }).then((x) => x.value.items).catch(() => [] as MenuComment[]),
      ]);
      if (alive) paint(menu.value, comments, menu.stale ? menu.at : null);
    } catch (error) {
      if (alive) replace(host, failure(error, () => void load()));
    }
  }

  function photo(fileId: string, name: string): HTMLElement {
    const img = el('img', { class: 'orgdish-photo', alt: name, loading: 'lazy', hidden: '' }) as HTMLImageElement;
    const cached = photos.get(fileId);
    if (cached) { img.src = cached; img.hidden = false; } else {
      ctx.api.portalFile(fileId).then((f) => { photos.set(fileId, f.url); img.src = f.url; img.hidden = false; }).catch(() => undefined);
    }
    return img;
  }

  function paint(menu: PortalMenu, comments: MenuComment[], staleAt: string | null): void {
    const note = commonText('portal.menu_note');
    if (!menu.available) {
      replace(host, staleAt ? staleNote(staleAt) : null, el('p', { class: 'muted', id: 'menuPending' }, t('Cocina aún no ha compartido el menú de tu retiro. Lo verás aquí en cuanto lo haga.')));
      return;
    }
    const days = [...new Set(menu.services.map((s) => s.date))].sort();
    const mine = (dish: Dish) => comments.filter((c) => c.menu_item_id === dish.menu_item_id);
    replace(host,
      staleAt ? staleNote(staleAt) : null,
      el('p', { class: 'chips' }, el('span', { class: `chip ${menu.status === 'confirmado' ? 'ok' : 'warn'}`, id: 'menuStatus' }, menu.status === 'confirmado' ? t('Confirmado') : t('Provisional'))),
      note.body ? el('div', { class: 'banner info small', id: 'menuNote' }, ...textParagraphs(note.body)) : null,
      ...days.map((day) => el('section', { class: 'orgday', 'data-day': day },
        el('h4', null, dayTitle(day)),
        ...menu.services.filter((s) => s.date === day).map((s) => el('div', { class: 'orgservice', 'data-service': s.service_id },
          el('h5', null, t(SERVICES[s.type] ?? s.type), s.time ? el('span', { class: 'muted small' }, ` · ${s.time.slice(0, 5)}`) : null),
          ...s.dishes.map((d) => el('div', { class: 'orgdish', 'data-dish': d.menu_item_id },
            d.photo_thumb_file_id ? photo(d.photo_thumb_file_id, d.name) : null,
            el('div', { class: 'orgdish-main' },
              el('strong', null, d.name),
              d.description ? el('span', { class: 'muted small' }, d.description) : null,
              d.allergens?.length ? el('span', { class: 'muted small' }, `${t('Alérgenos')}: ${d.allergens.join(', ')}`) : null,
              ...mine(d).map((c) => fbIgnore(el('span', { class: 'orgcomment small' },
                c.kind === 'prefiero_que_no' ? t('Has pedido: prefiero que no') : `${t('Tu comentario')}: ${c.message ?? ''}`,
                ` · ${t(COMMENT_STATUS[c.status] ?? c.status)}`, c.reply ? ` · ${t('Cocina')}: ${c.reply}` : '')))),
            el('div', { class: 'orgdish-actions' },
              el('button', { type: 'button', class: 'ghost small', 'data-action': 'prefer-not', onclick: () => void send(s, d, 'prefiero_que_no', null) }, t('Prefiero que no')),
              el('button', { type: 'button', class: 'ghost small', 'data-action': 'comment', onclick: () => comment(s, d) }, t('Comentar'))))))))),
      el('button', { type: 'button', class: 'ghost', id: 'menuGeneral', onclick: () => comment(null, null) }, t('Comentario general sobre el menú')));
  }

  async function send(service: Service | null, dish: Dish | null, kind: 'prefiero_que_no' | 'comentario', message: string | null): Promise<boolean> {
    if (!online()) { toast(describeError({ code: 'OFFLINE' })); return false; }
    try {
      await ctx.usage.run('organizers.menu.comentar', () => ctx.api.invokeAny('food.portal_menu_comment', {
        reservation_id: reservationId, ...(dish ? { menu_item_id: dish.menu_item_id } : {}), ...(service ? { service_id: service.service_id } : {}), kind, ...(message ? { message } : {}),
      }));
      toast(t('Enviado a cocina.'));
      await load();
      return true;
    } catch (e) {
      toast(errorCode(e) === 'MENU_CLOSED' ? t('Este menú ya está cerrado. Si necesitas un cambio, habla con Ikisai.') : describeError(e));
      return false;
    }
  }

  function comment(service: Service | null, dish: Dish | null): void {
    const text = el('textarea', { id: 'menu-comment', rows: '4', maxlength: '1000', required: '' }) as HTMLTextAreaElement;
    const sheet = openSheet({
      title: dish ? t('Comentar «{plato}»', { plato: dish.name }) : t('Comentario sobre el menú'),
      panelAttrs: { id: 'menuCommentSheet' },
      body: el('form', { id: 'menuCommentForm', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        el('label', { class: 'field' }, el('span', null, t('Tu comentario para cocina')), text),
        el('p', { class: 'muted small' }, t('Las alergias e intolerancias de cada asistente no van aquí: van en su ficha.'))),
      foot: el('div', { class: 'choices' }, el('button', { type: 'submit', class: 'primary', form: 'menuCommentForm', id: 'menu-comment-send' }, t('Enviar'))),
    });
    async function submit(): Promise<void> {
      if (!text.value.trim()) return;
      if (await send(service, dish, 'comentario', text.value.trim())) await sheet.close(true);
    }
  }

  void load();
  (host as HTMLElement & { destroy?: () => void }).destroy = () => { alive = false; };
  return host;
}
