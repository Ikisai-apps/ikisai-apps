/**
 * Página completa imprimible (A4): cabecera con marca, título y fechas, secciones (días) con grupos (servicios) y
 * tarjetas con imagen (platos), pie, marca «BORRADOR» y botón «Imprimir / Guardar PDF». En pantalla se ve como papel;
 * en impresión desaparecen navegación y botones, hay saltos de página por sección y ninguna tarjeta se parte.
 * Pensada para la vista del organizador de Food (canon §28–29) y la ficha imprimible de factura de Invoices.
 */
import { el, replace, type Child } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';

export interface PrintChip {
  text: string;
  /** `ok` (dieta), `alert` (alérgeno), `plain` (por defecto). */
  kind?: 'ok' | 'alert' | 'plain';
}

export interface PrintItem {
  title: string;
  /** Descripción pública; nada interno. */
  text?: Child;
  /** URL o `data:` de la imagen (foto de 1600 px o miniatura). */
  image?: string | null;
  imageAlt?: string;
  chips?: PrintChip[];
  /** Línea pequeña bajo el título (categoría, hora). */
  meta?: Child;
}

export interface PrintGroup {
  /** Servicio: «Desayuno», «Comida 14:00». */
  title: string;
  subtitle?: string;
  items: PrintItem[];
  /** Texto cuando el grupo no tiene elementos. */
  empty?: string;
}

export interface PrintSection {
  /** Día: «Viernes 10 de octubre». */
  title: string;
  subtitle?: string;
  groups?: PrintGroup[];
  items?: PrintItem[];
  /** Empieza en página nueva al imprimir; por defecto sí a partir de la segunda sección. */
  breakBefore?: boolean;
}

export interface PrintPageSpec {
  brand: { appName: string; markIcon?: IconName; line?: string };
  title: string;
  subtitle?: string;
  /** Datos de cabecera: fechas, personas, código. */
  meta?: Child[];
  /** Marca «BORRADOR» (o el texto que se pase). */
  draft?: boolean | string;
  intro?: Child;
  sections: PrintSection[];
  /** Bloque final (información dietética general, aviso legal). */
  notes?: Child;
  footer?: Child;
  /** Texto de impresión en el pie de cada página: por defecto «Ikisai <app> · <título>». */
  runningFoot?: string;
  /** Columnas de tarjetas en A4; por defecto 2. */
  columns?: 1 | 2 | 3;
}

function chip(c: PrintChip): HTMLElement {
  return el('span', { class: `chip ${c.kind === 'ok' ? 'ok' : c.kind === 'alert' ? 'alert' : ''}` }, el('span', null, c.text));
}

function item(it: PrintItem): HTMLElement {
  return el('article', { class: `pp-item${it.image ? ' with-image' : ''}` },
    it.image ? el('figure', { class: 'pp-figure' }, el('img', { src: it.image, alt: it.imageAlt ?? '', loading: 'eager', decoding: 'sync' })) : null,
    el('div', { class: 'pp-body' },
      el('h4', { class: 'pp-item-title' }, it.title),
      it.meta ? el('p', { class: 'pp-meta' }, it.meta) : null,
      it.text ? el('p', { class: 'pp-text' }, it.text) : null,
      it.chips?.length ? el('div', { class: 'chips pp-chips' }, ...it.chips.map(chip)) : null,
    ),
  );
}

function group(g: PrintGroup, columns: number): HTMLElement {
  return el('section', { class: 'pp-group' },
    el('h3', { class: 'pp-group-title' }, g.title, g.subtitle ? el('small', null, g.subtitle) : null),
    g.items.length ? el('div', { class: 'pp-items', style: `--pp-cols:${columns}` }, ...g.items.map(item)) : el('p', { class: 'pp-empty' }, g.empty ?? 'Sin platos.'),
  );
}

/** La página en sí (sin botones): se puede montar dentro del `main` de la app. */
export function renderPrintPage(spec: PrintPageSpec): HTMLElement {
  const columns = spec.columns ?? 2;
  const draft = spec.draft ? (typeof spec.draft === 'string' ? spec.draft : 'BORRADOR') : null;
  return el('article', { class: 'print-page', dataset: { draft: draft ? 'true' : 'false' }, 'aria-label': spec.title },
    draft ? el('div', { class: 'pp-draft', 'aria-hidden': 'true' }, draft) : null,
    el('header', { class: 'pp-head' },
      el('div', { class: 'brand' },
        el('div', { class: 'mark', 'aria-hidden': 'true' }, icon(spec.brand.markIcon ?? 'mark', 20)),
        el('div', null, el('strong', { class: 'pp-brand' }, `Ikisai ${spec.brand.appName}`), spec.brand.line ? el('small', { class: 'pp-brand-line' }, spec.brand.line) : null),
      ),
      draft ? el('span', { class: 'chip alert pp-draft-chip' }, el('span', null, draft)) : null,
    ),
    el('div', { class: 'pp-title' },
      el('h1', null, spec.title),
      spec.subtitle ? el('p', { class: 'pp-subtitle' }, spec.subtitle) : null,
      spec.meta?.length ? el('div', { class: 'pp-metarow' }, ...spec.meta.map((m) => el('span', null, m))) : null,
    ),
    spec.intro ? el('p', { class: 'pp-intro' }, spec.intro) : null,
    ...spec.sections.map((s, i) => el('section', { class: `pp-section${(s.breakBefore ?? i > 0) ? ' page' : ''}` },
      el('h2', { class: 'pp-section-title' }, s.title, s.subtitle ? el('small', null, s.subtitle) : null),
      ...(s.groups ?? []).map((g) => group(g, columns)),
      s.items?.length ? el('div', { class: 'pp-items', style: `--pp-cols:${columns}` }, ...s.items.map(item)) : null,
    )),
    spec.notes ? el('section', { class: 'pp-notes' }, spec.notes) : null,
    el('footer', { class: 'pp-foot' }, spec.footer ?? `Ikisai ${spec.brand.appName}`, el('span', { class: 'pp-running' }, spec.runningFoot ?? `${spec.title}`)),
  );
}

/**
 * Espera a que las imágenes del nodo estén decodificadas (así el PDF no sale con huecos) y abre el diálogo de impresión.
 * Mientras dura, `<html class="printing">` hace que solo se imprima la página (`.print-page`), aunque el documento tenga
 * cabecera, navegación u otras vistas.
 */
export async function printElement(root: HTMLElement, timeoutMs = 4000): Promise<void> {
  const images = Array.from(root.querySelectorAll('img'));
  await Promise.race([
    Promise.all(images.map((img) => (img.complete && img.naturalWidth ? Promise.resolve() : img.decode().catch(() => undefined)))),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  // Todo lo que no es la página ni uno de sus antecesores se retira del flujo de impresión (sin páginas en blanco).
  const hidden: Element[] = [];
  for (let node: Element | null = root; node && node !== doc.body; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement?.children ?? [])) {
      if (sibling !== node && !sibling.hasAttribute('data-print-hidden') && sibling.tagName !== 'SCRIPT' && sibling.tagName !== 'STYLE' && sibling.tagName !== 'LINK') {
        sibling.setAttribute('data-print-hidden', '');
        hidden.push(sibling);
      }
    }
  }
  doc.documentElement.classList.add('printing');
  let cleaned = false;
  const done = () => {
    if (cleaned) return;
    cleaned = true;
    doc.documentElement.classList.remove('printing');
    for (const node of hidden) node.removeAttribute('data-print-hidden');
  };
  win?.addEventListener('afterprint', done, { once: true });
  try {
    win?.print();
  } finally {
    // Navegadores sin `afterprint` fiable: se limpia al volver el hilo principal.
    setTimeout(done, 0);
  }
}

export interface PrintViewOptions {
  /** Botón «Volver» (o lo que ponga la app). */
  onBack?: () => void;
  backLabel?: string;
  printLabel?: string;
  /** Acciones extra en la barra (solo pantalla). */
  actions?: HTMLElement[];
  /** Se llama al pulsar «Imprimir» (o con `print()`), antes de abrir el diálogo: p. ej. `() => usage.track('food.menu.imprimir')`. */
  onPrint?: () => void;
}

export interface PrintView {
  element: HTMLElement;
  page: HTMLElement;
  /** Sustituye la página (por ejemplo, al cambiar el espejo local). */
  update(spec: PrintPageSpec): void;
  print(): Promise<void>;
}

/** Página imprimible con barra de acciones (que no se imprime): «Volver» y «Imprimir / Guardar PDF». */
export function createPrintView(spec: PrintPageSpec, options: PrintViewOptions = {}): PrintView {
  let page = renderPrintPage(spec);
  const printButton = el('button', { class: 'primary', type: 'button', id: 'printPage', onclick: () => void print() }, icon('download', 18), options.printLabel ?? 'Imprimir / Guardar PDF');
  const back = options.onBack ? el('button', { class: 'ghost', type: 'button', onclick: () => options.onBack?.() }, icon('chevronLeft', 18), options.backLabel ?? 'Volver') : null;
  const bar = el('div', { class: 'print-actions' }, back, ...(options.actions ?? []), printButton);
  const element = el('div', { class: 'print-view' }, bar, page);
  async function print(): Promise<void> {
    try { options.onPrint?.(); } catch { /* la medición nunca bloquea la impresión */ }
    printButton.disabled = true;
    try {
      await printElement(page);
    } finally {
      printButton.disabled = false;
    }
  }
  return {
    element,
    get page() { return page; },
    update(next) { const fresh = renderPrintPage(next); replace(element, bar, fresh); page = fresh; },
    print,
  };
}
