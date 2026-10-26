import { createQuantityField, el, icon, openSheet, renderMedal, replace } from '@ikisai/ui-kit';
import {
  basketLines, basketTotal, formatEuros, groupMenu, setQuantity, SCOPE_LABELS,
  type Basket, type MenuProduct,
} from '@ikisai/domain-flow';

/**
 * Carta pública (canon V1 §3, nivel mínimo): sin sesión y sin cuenta de cliente. Tres bloques (Clásicos, Gourmet y Barra),
 * cada producto con su medallón de código, nombre, descripción, precio y «− n +» en la propia tarjeta; «Mi pedido» con
 * cantidades y total, y «Ver carta solo» con la carta completa. La cesta no se envía: se enseña en barra y **el pago se
 * hace allí** (no hay cobro por preparar la cesta). Las guías internas nunca salen aquí (§15.3).
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
  const bar = el('div', { class: 'carta-bar', id: 'cartaBar', role: 'region', 'aria-label': 'Mi pedido' });
  const page = el('div', { class: 'carta-page' },
    el('header', { class: 'carta-head' },
      el('div', { class: 'carta-brand' }, icon('sync', 22), el('span', null, 'Ikisai Flow')),
      el('h1', null, 'Carta'),
    ),
    main, bar);
  replace(root, page);
  document.title = 'Carta · Ikisai Flow';

  function change(id: string, quantity: number): void {
    basket = setQuantity(basket, id, quantity);
    saveBasket(basket);
    paintBar();
  }

  function productCard(product: MenuProduct): HTMLElement {
    const field = createQuantityField({
      label: `Cantidad de ${product.name}`, name: `q-${product.id}`, value: basket[product.id] ?? 0, decimals: 0, min: 0, max: 99, step: 1,
      onChange: (value) => change(product.id, value.value ?? 0),
    });
    fields.set(product.id, { set: (q) => field.set({ value: q, unit: field.get().unit }) });
    return el('article', { class: `carta-item scope-${product.scope}`, 'data-product': `${product.scope}:${product.code}` },
      renderMedal({ image: product.image, initials: product.code, color: SCOPE_COLOR[product.scope], size: 56, label: `${SCOPE_LABELS[product.scope]} ${product.code}` }),
      el('div', { class: 'carta-text' },
        el('h3', null, product.name),
        product.description ? el('p', { class: 'muted' }, product.description) : null,
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

  /** Carta completa de solo lectura, pintada desde el mismo catálogo: los precios no pueden diferir (§8.3). */
  function paintCarta(): void {
    replace(main,
      el('div', { class: 'carta-switch' },
        el('button', { type: 'button', class: 'primary', id: 'prepararPedido', onclick: () => { mode = 'pedido'; paint(); } }, el('span', null, 'Preparar pedido'))),
      ...groupMenu(products).map((g) => el('section', { class: 'carta-group carta-solo' },
        el('h2', null, g.label),
        el('ul', { class: 'carta-solo-list' }, ...g.products.map((p) => el('li', null,
          el('span', { class: 'carta-code' }, p.code),
          el('span', { class: 'carta-solo-name' }, p.name, p.description ? el('small', { class: 'muted' }, p.description) : null),
          el('span', { class: 'carta-price' }, formatEuros(p.priceCents)))))),
      ),
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
    const sheet = openSheet({
      title: 'Mi pedido',
      meta: 'Enséñalo en la barra: allí se paga.',
      body: el('div', { class: 'carta-summary' },
        el('ul', { class: 'carta-summary-list' }, ...lines.map((l) => el('li', null,
          el('span', { class: 'carta-code' }, l.product.code),
          el('span', null, `${l.quantity} × ${l.product.name}`),
          el('span', { class: 'carta-price' }, formatEuros(l.subtotalCents))))),
        el('p', { class: 'carta-summary-total' }, el('span', null, 'Total'), el('strong', null, formatEuros(totalCents))),
      ),
      foot: el('button', { type: 'button', class: 'ghost', onclick: () => {
        basket = {}; saveBasket(basket);
        for (const f of fields.values()) f.set(0);
        paintBar(); sheet.close();
      } }, 'Vaciar pedido'),
    });
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
