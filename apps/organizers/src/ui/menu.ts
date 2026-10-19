/**
 * Menú del retiro (fase 4, Fd2 y Fd3 en Food #327 y #332): la propuesta de cocina, cuando Ikisai la comparte, por días y
 * servicios. En cada plato, «Prefiero que no» o un comentario; Food los ve en la ficha del menú y responde. Las fotos son
 * miniaturas abiertas con `portal-files` (C8). Lo que escribe en Food necesita red: sin ella, esos botones se apagan con su
 * motivo. Cocina reutiliza de aquí los nombres de los servicios y los alérgenos, la línea de alérgenos y las fotos.
 */
import { bindOnline, el, openSheet, replace, toast } from '@ikisai/ui-kit';
import { describeError, errorCode, online } from '../app/client.ts';
import { commonText, textParagraphs } from '../app/common-texts.ts';
import { i18n, L, t } from '../app/i18n.ts';
import type { Dish, MenuService, PortalMenu } from '../app/kitchen-state.ts';
import { failure, fbIgnore, loading, needsNet, staleNote } from './common.ts';
import type { ViewContext } from './shell.ts';

export type { Dish, PortalMenu };
type Service = MenuService;
interface MenuComment { id: string; menu_item_id: string | null; service_id: string | null; dish: string | null; kind: 'prefiero_que_no' | 'comentario'; message: string | null; status: string; reply: string | null; created_at: string }

export const SERVICES: Record<string, string> = { desayuno: L('Desayuno'), comida: L('Comida'), merienda: L('Merienda'), cena: L('Cena'), picnic: L('Pícnic'), otro: L('Otro') };
// Los 14 alérgenos de declaración obligatoria, con los códigos de Food (catalog.ts) y los nombres que usa Guests.
export const ALLERGENS: Record<string, string> = {
  gluten: L('gluten'), crustaceos: L('crustáceos'), huevos: L('huevo'), pescado: L('pescado'), cacahuetes: L('cacahuete'), soja: L('soja'),
  lacteos: L('lácteos'), frutos_de_cascara: L('frutos de cáscara'), apio: L('apio'), mostaza: L('mostaza'), sesamo: L('sésamo'),
  sulfitos: L('sulfitos'), altramuces: L('altramuces'), moluscos: L('moluscos'),
};
/** Nombre de un alérgeno de Food en el idioma de la pantalla (nunca el código interno). */
export const allergenName = (code: string) => (ALLERGENS[code] ? t(ALLERGENS[code]) : code.replace(/_/g, ' '));
const COMMENT_STATUS: Record<string, string> = { nuevo: L('Enviado'), visto: L('Visto por cocina'), resuelto: L('Resuelto') };
/**
 * Alérgenos declarados por cocina, siempre con su nombre. Si cocina no ha revisado la receta (`allergens_checked`), se dice:
 * una lista vacía sin revisar no significa «no tiene».
 */
export function allergensLine(d: Dish): HTMLElement | null {
  const names = (d.allergens ?? []).map(allergenName);
  const unchecked = d.allergens_checked !== true;
  if (!names.length && !unchecked) return null;
  return el('span', { class: 'small orgdish-allergens' }, `${t('Alérgenos')}: ${names.join(', ')}`,
    unchecked ? el('span', { class: 'orgdish-unchecked' }, `${names.length ? ' · ' : ''}${t('sin revisar por cocina')}`) : null);
}
export const dayTitle = (day: string) => new Intl.DateTimeFormat(i18n.tag(), { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(new Date(`${day}T12:00:00Z`));

/** Miniaturas de los platos (URL firmadas cortas): se guardan unos minutos para no pedirlas en cada pantalla. */
const PHOTO_TTL = 10 * 60_000;
const photoUrls = new Map<string, { at: number; url: Promise<string | null> }>();
export function dishPhoto(ctx: Pick<ViewContext, 'api'>, fileId: string): Promise<string | null> {
  const hit = photoUrls.get(fileId);
  if (hit && Date.now() - hit.at < PHOTO_TTL) return hit.url;
  const url = ctx.api.portalFile(fileId).then((f) => f.url).catch(() => { photoUrls.delete(fileId); return null; });
  photoUrls.set(fileId, { at: Date.now(), url });
  return url;
}
/** Al cerrar la sesión se olvidan las fotos de los platos. */
export function clearDishPhotos(): void { photoUrls.clear(); }

export function renderMenu(ctx: ViewContext, reservationId: string): HTMLElement {
  const host = el('div', { id: 'menu' }, loading());
  let alive = true;
  /** Botones que escriben en Food, atados a la red: se sueltan al repintar y al salir. */
  let bound: Array<() => void> = [];
  const release = () => { for (const off of bound) off(); bound = []; };
  const net = <T extends HTMLElement>(button: T): T => { bound.push(needsNet(ctx, button)); return button; };

  async function load(): Promise<void> {
    try {
      const [menu, comments] = await Promise.all([
        ctx.api.readAny<PortalMenu>('food.portal_menu', { reservation_id: reservationId }),
        ctx.api.readAny<{ items: MenuComment[] }>('food.portal_my_menu_comments', { reservation_id: reservationId }).then((x) => x.value.items).catch(() => [] as MenuComment[]),
      ]);
      if (alive) paint(menu.value, comments, menu.stale ? menu.at : null);
    } catch (error) {
      if (alive) { release(); replace(host, failure(error, () => void load())); }
    }
  }

  function photo(fileId: string, name: string): HTMLElement {
    const img = el('img', { class: 'orgdish-photo', alt: name, loading: 'lazy', hidden: '' }) as HTMLImageElement;
    void dishPhoto(ctx, fileId).then((url) => { if (url) { img.src = url; img.hidden = false; } });
    img.addEventListener('error', () => { img.hidden = true; }, { once: true });
    return img;
  }

  function paint(menu: PortalMenu, comments: MenuComment[], staleAt: string | null): void {
    release();
    const note = commonText('portal.menu_note');
    if (!menu.available) {
      replace(host, staleAt ? staleNote(staleAt) : null, el('p', { class: 'muted', id: 'menuPending' }, t('Cocina aún no ha compartido el menú de tu retiro. Lo verás aquí en cuanto lo haga.')));
      return;
    }
    const days = [...new Set(menu.services.map((s) => s.date))].sort();
    const mine = (dish: Dish) => comments.filter((c) => c.menu_item_id === dish.menu_item_id);
    const content = [
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
              allergensLine(d),
              ...mine(d).map((c) => fbIgnore(el('span', { class: 'orgcomment small' },
                c.kind === 'prefiero_que_no' ? t('Has pedido: prefiero que no') : `${t('Tu comentario')}: ${c.message ?? ''}`,
                ` · ${t(COMMENT_STATUS[c.status] ?? c.status)}`, c.reply ? ` · ${t('Cocina')}: ${c.reply}` : '')))),
            el('div', { class: 'orgdish-actions' },
              el('button', { type: 'button', class: 'ghost small', 'data-action': 'prefer-not', onclick: () => void send(s, d, 'prefiero_que_no', null) }, t('Prefiero que no')),
              el('button', { type: 'button', class: 'ghost small', 'data-action': 'comment', onclick: () => comment(s, d) }, t('Comentar'))))))))),
      el('button', { type: 'button', class: 'ghost', id: 'menuGeneral', onclick: () => comment(null, null) }, t('Comentario general sobre el menú')),
    ];
    // El motivo de cada plato va en una sola línea oculta (la leen los lectores de pantalla); el del comentario general, a la vista.
    const reasons = el('div', { class: 'vh' });
    replace(host, ...content, reasons);
    for (const b of host.querySelectorAll<HTMLElement>('[data-action="prefer-not"], [data-action="comment"]')) bound.push(bindOnline(b, { client: ctx.client, reasonHost: reasons }));
    net(host.querySelector<HTMLElement>('#menuGeneral')!);
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
    const sendButton = el('button', { type: 'submit', class: 'primary', form: 'menuCommentForm', id: 'menu-comment-send' }, t('Enviar'));
    const off = needsNet(ctx, sendButton);
    const sheet = openSheet({
      title: dish ? t('Comentar «{plato}»', { plato: dish.name }) : t('Comentario sobre el menú'),
      panelAttrs: { id: 'menuCommentSheet' },
      body: el('form', { id: 'menuCommentForm', onsubmit: (e: Event) => { e.preventDefault(); void submit(); } },
        el('label', { class: 'field' }, el('span', null, t('Tu comentario para cocina')), text),
        el('p', { class: 'muted small' }, t('Las alergias e intolerancias de cada asistente no van aquí: van en su ficha.'))),
      foot: el('div', { class: 'choices' }, sendButton),
      onClose: () => off(),
    });
    async function submit(): Promise<void> {
      if (!text.value.trim()) return;
      if (await send(service, dish, 'comentario', text.value.trim())) await sheet.close(true);
    }
  }

  void load();
  (host as HTMLElement & { destroy?: () => void }).destroy = () => { alive = false; release(); };
  return host;
}
