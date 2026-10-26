import { createQuantityField, el, icon, openSheet, renderMedal, replace, type Sheet } from '@ikisai/ui-kit';
import { myOrders, PublicApiError, readCustomer, submitOrder, type MyOrder } from './customer.ts';
import {
  basketLines, basketTotal, formatEuros, groupMenu, productAssets, setQuantity, SCOPE_LABELS,
  type Basket, type MenuProduct,
} from '@ikisai/domain-flow';

/**
 * Carta pública en la raíz de flow.ikisai.com (canon V1 §3; FLOW-DIR-001 §1 y §8): sin login. Tres bloques (Clásicos,
 * Gourmet y Barra), cada producto con su medallón de código, nombre, descripción, precio y «− n +» en la propia tarjeta;
 * «Mi pedido» con cantidades y total, y «Ver carta solo» con la carta completa. «Enviar a barra» manda la cesta y da un
 * número que el navegador conserva («Soy el 142»): **el pago se hace en barra**, enviar no es pagar. Mientras no se envía,
 * la cesta solo existe en este navegador y caja no la ve. Las guías internas nunca salen aquí (§15.3).
 */

const BASKET_KEY = 'ikisai-flow-cesta';

function readBasket(): Basket {
  try { return JSON.parse(sessionStorage.getItem(BASKET_KEY) ?? '{}') as Basket; } catch { return {}; }
}
function saveBasket(basket: Basket): void {
  try { sessionStorage.setItem(BASKET_KEY, JSON.stringify(basket)); } catch { /* sin almacenamiento: la cesta vive en memoria */ }
}

/** Colores de los medallones por ámbito (tokens del kit), para distinguir de un vistazo una «A» clásica de una «A» de barra. */
const SCOPE_COLOR = { clasico: 'var(--accent)', gourmet: 'var(--ok, #5b6b3a)', barra: 'var(--info, #2f3d57)' } as const;

export async function loadMenu(fetcher: typeof fetch = fetch): Promise<MenuProduct[]> {
  const res = await fetcher('/api/v1/public/menu', { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`menu ${res.status}`);
  const data = await res.json() as { products?: MenuProduct[] };
  return Array.isArray(data.products) ? data.products : [];
}

export function mountCarta(root: HTMLElement): () => void {
  let products: MenuProduct[] = [];
  let basket = readBasket();
  let mode: 'pedido' | 'carta' = 'pedido';
  const fields = new Map<string, { set(q: number): void }>();

  const main = el('main', { class: 'carta', id: 'carta', tabindex: '-1' });
  const mineButton = el('button', { type: 'button', class: 'ghost carta-mine', id: 'misPedidos', onclick: () => void openMine() });
  const paintMine = () => {
    const c = readCustomer();
    mineButton.hidden = !c;
    replace(mineButton, c?.number ? `Soy el ${c.number}` : 'Mis pedidos');
  };
  paintMine();
  const bar = el('div', { class: 'carta-bar', id: 'cartaBar', role: 'region', 'aria-label': 'Mi pedido' });
  const page = el('div', { class: 'carta-page' },
    el('header', { class: 'carta-head' },
      el('div', { class: 'carta-brand' }, icon('sync', 22), el('span', null, 'Ikisai Flow')),
      el('h1', null, 'Carta'),
      mineButton,
    ),
    main, bar);
  replace(root, page);
  document.title = 'Carta · Ikisai Flow';

  function change(id: string, quantity: number): void {
    basket = setQuantity(basket, id, quantity);
    saveBasket(basket);
    paintBar();
  }

  /** Miniatura si el producto tiene imágenes (se carga después: la carta funciona sin ellas) y zoom al tocarla; si no, medallón. */
  function productPicture(product: MenuProduct): HTMLElement {
    const medal = renderMedal({ initials: product.code, color: SCOPE_COLOR[product.scope], size: 56, label: `${SCOPE_LABELS[product.scope]} ${product.code}` });
    const assets = productAssets(product.imageKey);
    if (!assets) return medal;
    const img = el('img', { src: assets.thumb, alt: '', loading: 'lazy', decoding: 'async', width: '120', height: '80' });
    img.addEventListener('error', () => button.replaceWith(medal));
    const button = el('button', { type: 'button', class: 'carta-thumb', 'aria-label': `Ver ${product.name} en grande`, onclick: () => openSheet({
      title: product.name, body: el('div', { class: 'carta-zoom' }, el('img', { src: assets.zoom, alt: product.name, decoding: 'async' }), product.description ? el('p', { class: 'muted' }, product.description) : null),
    }) }, img, el('span', { class: 'carta-thumb-code' }, product.code));
    return button;
  }

  function productCard(product: MenuProduct): HTMLElement {
    const field = createQuantityField({
      label: `Cantidad de ${product.name}`, name: `q-${product.id}`, value: basket[product.id] ?? 0, decimals: 0, min: 0, max: 99, step: 1,
      onChange: (value) => change(product.id, value.value ?? 0),
    });
    fields.set(product.id, { set: (q) => field.set({ value: q, unit: field.get().unit }) });
    return el('article', { class: `carta-item scope-${product.scope}`, 'data-product': `${product.scope}:${product.code}` },
      productPicture(product),
      el('div', { class: 'carta-text' },
        el('h3', null, product.name),
        product.description ? el('p', { class: 'muted' }, product.description) : null,
        product.allergens?.length ? el('p', { class: 'carta-allergens' }, `Alérgenos: ${product.allergens.join(', ')}${product.allergensChecked ? '' : ' (sin confirmar con la etiqueta: pregunta en barra)'}`) : null,
        el('strong', { class: 'carta-price' }, formatEuros(product.priceCents)),
      ),
      el('div', { class: 'carta-qty' }, field.element),
    );
  }

  function paintPedido(): void {
    fields.clear();
    const groups = groupMenu(products);
    replace(main,
      el('div', { class: 'carta-switch' },
        el('button', { type: 'button', class: 'ghost', id: 'verCarta', onclick: () => { mode = 'carta'; paint(); } }, icon('eye', 18), el('span', null, 'Ver carta solo'))),
      ...(groups.length ? groups.map((g) => el('section', { class: 'carta-group', 'aria-labelledby': `g-${g.scope}` },
        el('h2', { id: `g-${g.scope}` }, g.label),
        el('div', { class: 'carta-list' }, ...g.products.map(productCard)),
      )) : [el('p', { class: 'muted' }, 'La carta no está disponible ahora mismo.')]),
    );
  }

  /**
   * «Ver carta solo» (§3.1): la carta general de VG. Debajo, plegados, los precios vigentes del catálogo, que son los que
   * se cobran si algún día la imagen se queda atrás (§8.3).
   */
  function paintCarta(): void {
    replace(main,
      el('div', { class: 'carta-switch' },
        el('button', { type: 'button', class: 'primary', id: 'prepararPedido', onclick: () => { mode = 'pedido'; paint(); } }, el('span', null, 'Preparar pedido'))),
      el('img', { class: 'carta-general', src: '/guias/carta-general.webp', alt: 'Carta general: Barra (bebidas y extras) y Montaditos (clásicos y gourmet)', decoding: 'async' }),
      el('details', { class: 'carta-precios' }, el('summary', null, 'Precios vigentes'),
      ...groupMenu(products).map((g) => el('section', { class: 'carta-group carta-solo' },
        el('h2', null, g.label),
        el('ul', { class: 'carta-solo-list' }, ...g.products.map((p) => el('li', null,
          el('span', { class: 'carta-code' }, p.code),
          el('span', { class: 'carta-solo-name' }, p.name, p.description ? el('small', { class: 'muted' }, p.description) : null),
          el('span', { class: 'carta-price' }, formatEuros(p.priceCents)))))),
      )),
    );
  }

  function paintBar(): void {
    const lines = basketLines(basket, products);
    const { units, totalCents } = basketTotal(lines);
    bar.hidden = mode !== 'pedido';
    replace(bar,
      el('button', { type: 'button', class: 'carta-total', id: 'miPedido', disabled: units === 0, onclick: openSummary },
        el('span', null, units ? `Mi pedido · ${units} ${units === 1 ? 'producto' : 'productos'}` : 'Mi pedido está vacío'),
        el('strong', { id: 'cartaTotal' }, formatEuros(totalCents))));
  }

  function openSummary(): void {
    const lines = basketLines(basket, products);
    const { totalCents } = basketTotal(lines);
    const status = el('p', { class: 'carta-send-status', role: 'status', 'aria-live': 'polite' });
    const send = el('button', { type: 'button', class: 'primary', id: 'enviarPedido' }, 'Enviar a barra');
    send.addEventListener('click', async () => {
      if (send.disabled) return;
      send.disabled = true;
      replace(status, 'Enviando…');
      try {
        const out = await submitOrder(lines.map((l) => ({ productId: l.product.id, quantity: l.quantity })));
        basket = {}; saveBasket(basket);
        for (const f of fields.values()) f.set(0);
        paintBar(); paintMine();
        sheet.close();
        showSent(out.number);
      } catch (error) {
        send.disabled = false;
        replace(status, error instanceof PublicApiError ? error.message : 'No se ha podido enviar. Enséñalo en la barra.');
      }
    });
    const sheet: Sheet = openSheet({
      title: 'Mi pedido',
      meta: 'Envíalo a la barra y paga allí.',
      body: el('div', { class: 'carta-summary' },
        el('ul', { class: 'carta-summary-list' }, ...lines.map((l) => el('li', null,
          el('span', { class: 'carta-code' }, l.product.code),
          el('span', null, `${l.quantity} × ${l.product.name}`),
          el('span', { class: 'carta-price' }, formatEuros(l.subtotalCents))))),
        el('p', { class: 'carta-summary-total' }, el('span', null, 'Total'), el('strong', null, formatEuros(totalCents))),
        status,
      ),
      foot: el('div', { class: 'flow-actions' }, send, el('button', { type: 'button', class: 'ghost', onclick: () => {
        basket = {}; saveBasket(basket);
        for (const f of fields.values()) f.set(0);
        paintBar(); sheet.close();
      } }, 'Vaciar pedido')),
    });
  }

  /** Solo con la respuesta del servidor: el pedido está en barra y este es tu número. */
  function showSent(number: number | null): void {
    openSheet({
      title: 'Pedido enviado',
      body: el('div', { class: 'carta-sent' },
        el('p', { class: 'carta-number' }, el('small', null, 'Di en la barra'), el('strong', { id: 'numeroCliente' }, number ? `Soy el ${number}` : 'Tu pedido')),
        el('p', null, 'Paga en la barra: allí lo revisan contigo y lo cobran. Hasta entonces no se prepara.')),
    });
  }

  const MINE_STATE: Record<MyOrder['status'], string> = { open: 'Por cobrar en barra', paid: 'Cobrado', delivered: 'Entregado' };

  async function openMine(): Promise<void> {
    const body = el('div', { class: 'carta-mine-list' }, el('p', { class: 'muted' }, 'Cargando…'));
    const c = readCustomer();
    openSheet({ title: c?.number ? `Soy el ${c.number}` : 'Mis pedidos', meta: 'Tus pedidos desde este dispositivo.', body });
    try {
      const out = await myOrders();
      if (!out || !out.orders.length) { replace(body, el('p', { class: 'muted' }, 'Aún no has enviado pedidos desde este dispositivo.')); paintMine(); return; }
      replace(body, ...out.orders.map((o) => el('section', { class: 'carta-mine-order' },
        el('h3', null, `${MINE_STATE[o.status]}${o.status === 'paid' && o.preparing ? ' · preparando' : o.status === 'paid' ? ' · listo para recoger' : ''}`),
        el('ul', { class: 'carta-summary-list' }, ...o.lines.map((l) => el('li', null,
          el('span', { class: 'carta-code' }, l.code),
          el('span', null, `${l.quantity} × ${l.name}`),
          el('small', { class: 'muted' }, o.status === 'open' ? '' : [l.prepared ? `${l.preparedQty} de ${l.quantity} preparados` : '', `${l.deliveredQty} de ${l.quantity} entregados`].filter(Boolean).join(' · '))))))));
    } catch (error) {
      replace(body, el('p', { class: 'formerror', role: 'alert' }, error instanceof PublicApiError ? error.message : 'No se ha podido cargar.'));
    }
  }

  function paint(): void {
    if (mode === 'pedido') paintPedido(); else paintCarta();
    paintBar();
    window.scrollTo({ top: 0 });
  }

  replace(main, el('p', { class: 'muted' }, 'Cargando la carta…'));
  let alive = true;
  loadMenu().then((items) => {
    if (!alive) return;
    products = items;
    // Fuera de la cesta lo que ya no está en la carta (agotado o retirado).
    basket = Object.fromEntries(Object.entries(basket).filter(([id]) => products.some((p) => p.id === id)));
    saveBasket(basket);
    paint();
  }).catch(() => {
    if (!alive) return;
    replace(main, el('p', { class: 'formerror', role: 'alert' }, 'No se ha podido cargar la carta. Comprueba la conexión y vuelve a intentarlo.'),
      el('button', { type: 'button', class: 'primary', onclick: () => location.reload() }, 'Reintentar'));
  });

  return () => { alive = false; replace(root, el('div')); };
}
