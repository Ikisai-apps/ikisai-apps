# @ikisai/ui-kit

Tokens de la dirección visual «Taller», componentes base en TypeScript sin framework, barra de estado de sincronización y shell de login comunes a las cuatro apps de Ikisai. Se consume como fuente (igual que `@ikisai/sync-client`): sin paso de build propio.

## Instalar en una app

1. **Alias** en `vite.config.ts` y `tsconfig.json` de la app (igual que `@ikisai/sync-client`):

   ```ts
   // vite.config.ts
   resolve: { alias: { '@ikisai/ui-kit': path.resolve(root, '../../packages/ui-kit/src/index.ts') } }
   ```

   ```json
   // tsconfig.json
   "paths": { "@ikisai/ui-kit": ["../../packages/ui-kit/src/index.ts"] },
   "include": ["src/**/*.ts", "../../packages/ui-kit/src/**/*.ts"]
   ```

2. **Estilos**: una vez, al principio de `main.ts`:

   ```ts
   import '../../packages/ui-kit/src/styles/ui-kit.css'; // tokens + base + componentes
   import './styles/app.css';                             // solo lo propio de la app
   ```

   `ui-kit.css` no pinta nada fuera de las clases documentadas abajo; `app.css` añade o ajusta.

3. **Fuentes**: copia `packages/ui-kit/fonts/*.woff2` a `public/fonts/` de la app. Los tokens las cargan desde `/fonts/fraunces.woff2` e `/fonts/inter.woff2` (OFL). Precárgalas en `index.html`:

   ```html
   <link rel="preload" href="/fonts/fraunces.woff2" as="font" type="font/woff2" crossorigin />
   <link rel="preload" href="/fonts/inter.woff2" as="font" type="font/woff2" crossorigin />
   ```

4. **Tema**: llama a `applyTheme()` al arrancar. El modo sigue al sistema; `setTheme('dark'|'light'|'system')` lo fija y lo guarda (`localStorage` `ikisai-theme`). Pon `<meta name="color-scheme" content="light dark">`.

## Tokens

Variables CSS en `:root` (claro) y bajo `prefers-color-scheme: dark` / `[data-theme="dark"]` (oscuro). Las que una app puede querer tocar:

| Variable | Qué es |
|---|---|
| `--accent`, `--accent-ink` | Acento y su tinta. **Lo puede fijar la persona** (color de un área o proyecto) con `applyAccent(color)`; `--accent-deep`, `--accent-soft` y `--accent-glow` se derivan solos. Con `applyAccent(null)` vuelve al neutro. |
| `--item-color`, `--item-ink` | Color propio de un elemento (tarjeta, pastilla): `itemColorStyle(color)` devuelve el `style` listo. El kit nunca lo pisa. |
| `--chip` | Color de familia de un chip: `style="--chip:#b76b3d"` lo vuelve pastel legible. |
| `--content-width*`, `--sidebar-width` | Anchos del shell. |
| `--serif`, `--sans` | Fraunces (títulos, cifras) e Inter (resto). |

Regla: **el acento tiñe lo neutro** (botones primarios, anillos, navegación activa, foco); **nunca sustituye** un color elegido por la persona.

## Clases (contrato con las apps)

- Botones: `.primary`, `.ghost`, `.danger`, `.softbtn` (`.active`), `.linkbtn`, `.iconbtn`; modificador `.small`.
- Campos: `label.field > span + input|select|textarea`, `.hint`, `.fielderror`, `.invalid`, `.check`; `.formerror`; `.row2`.
- Chips: `.chip` (`.pending`, `.trash`, `.ok`, `.alert`, con `--chip`), `.chips`, `.chip .x`.
- Tarjetas: `.card` (`.raised`, `.colored` con `--item-color`), `.cardgrid`, `.cardlink`, `.kv`.
- Listas: `ul.list > li.row` con `.row-title .name`, `.row-meta`, `.row-actions`; estados `.deleted`, `[data-pending="true"]`, `.selected`.
- Secciones: `.pagehead`, `.toolbar .search`, `.sectionlabel .count`, `.empty` (`.plain`), `.skeleton`, `.fab` (`.round`).
- Avisos: `.banner` (`.warn`, `.alert`, `.info`, `.ok`), `.banners`, `.toast`.
- Estado: `.statusbar`, `.statuschip[data-network|data-pending|data-conflicts]`, `.syncbtn`.
- Shell: `.shell` (`.nonav`), `.topbar`, `.brand`, `.mark`, `.nav`, `.navbtn` (`.soon`, `.badge`), `.navfoot`, `.banners`, `.main`.
- Login: `.login`, `.login-card`, `.login-brand`, `.offline-ready`, `.footnote`.
- Hoja y diálogo: `.sheetback.show > .sheet` con `.sheet-head`, `.sheet-body`, `.sheet-foot`, `.handle`; `.dialogback > .dialog`.
- Conflictos y rechazados: `.conflict` (`.rejected`, `.busy`), `tr.overlap`, `.choices`, `label.pick`.
- Tema y paleta: `.segmented` (`.themeselect`), `.themetoggle`, `.palette-back > .palette` con `.palette-input`, `.palette-list`, `.palette-item`, `.palette-group`, `.palette-foot`.
- Calendario: `.calendar[data-view]`, `.cal-head`, `.cal-grid`, `.cal-week`, `.cal-day` (`.today`, `.outside`, `.has`), `.cal-event` (`.starts`, `.ends`, `--event-color`), `.cal-more`.
- Cantidad: `.qtyfield`, `.qty` (`.with-unit`, `.with-select`), `.qty-input`, `.qty-unit`, `.qty-step`.
- Imagen: `.imagepick`, `.imagepreview`.
- Etiquetas: `.labelpicker`, `.lp-summary`, `.lp-family` (`details`), `.lp-head`, `.lp-chips`, `.filterchip.lp-chip` (`.on`, `.child`), `.lp-create`.
- Tarjeta de proyecto: `.card.project` (`.colored`, `.system`, `.pinned`), `.projecttop`, `.cardring`, `.ring`, `.projectopen`, `.projecttitle` (`.star`), `.projectmeta`, `.projecttools`, `.pinbtn`, `.progressline`, `.money`.
- Campo de fecha: `.datefield`, `.date-shortcuts` (`.active`, `.date-clear`), `.date-desc`.
- Lista reordenable: `.sortable` (sobre `.list`), `.sortable-row` (`.lifting`, `.drop-before`, `.drop-after`), `.sortable-handle`, `.sortable-body`, `.sortable-moves`, `.sortable-ghost`.
- Página imprimible: `.print-view`, `.print-actions`, `.print-page[data-draft]`, `.pp-head`, `.pp-title`, `.pp-section` (`.page`), `.pp-group`, `.pp-items`, `.pp-item` (`.with-image`), `.pp-notes`, `.pp-foot`, `.pp-draft`.
- Tablas e importación: `.table` (`.num`, `tr.bad`), `.imp`, `.imp-source`, `.imp-preview`, `.imp-head`, `.imp-lines`, `.imp-taxes`, `.imp-cuadre`, `.imp-verdict` (`.ok`/`.bad`), `.imp-warnings`, `.imp-errors`.

Móvil primero a 390 px; escritorio desde 1024 px (navegación lateral, pastilla de estado larga, `.desktop-only`). Movimiento desactivado con `prefers-reduced-motion`.

## Atributo `hidden`

El CSS base incluye `[hidden]{display:none!important}`: cualquier elemento con `hidden` desaparece aunque su clase fije `display`.

## Controles sueltos

`select`, `textarea` e `input` de texto, búsqueda, número, fecha u hora llevan la piel de los campos también fuera de `.field` (filtros, filas); `.compact` los deja en 36 px. Reglas con `:where()`, así cualquier regla de la app gana.

## API

```ts
import { el, icon, toast, createStatusBar, statusBanners, renderLogin, createAppShell, applyTheme, applyAccent } from '@ikisai/ui-kit';
```

- `el(tag, attrs, ...children)`, `append`, `clear`, `replace`, `formatDate`, `plural`: DOM sin plantillas de texto.
- `icon(name, size)`: SVG de trazo que hereda `currentColor`; `registerIcons({...})` añade los de la app.
- `createStatusBar({ client | status, onSync, onClick, describeError })` → `{ element, update, destroy }`. Cumple el contrato §6.4: red, cambios pendientes (`pendingCommands + pendingBlobs`), conflictos; «Todo sincronizado» solo con red y cola vacía. `statusBanners(status, { onResolveConflicts, onRetry, updateApply, hideConflicts })` devuelve los banners derivados.
- `renderLogin(root, { appName, tagline, onLogin, describeError, footnote, markIcon, ids, title })` → función de limpieza. Ids estables: `#email`, `#password`, `#loginSubmit`, `#loginError`, `#loginTitle`.
- `createAppShell(root, { appName, subtitle, markIcon, nav, status, onLogout, tools, navFoot, navigate })` → `{ header, nav, banners, main, setRoute, setSubtitle, setStatus, setBanners, setBadge, destroy }`. La app monta sus vistas en `main` y llama a `setRoute(hash)` en cada cambio de ruta.
- `toast(msg)`, `toastWithAction(msg, { label, onClick })`, `hideToast()`. Con una hoja, un diálogo o la paleta abiertos, el aviso sale por arriba para no tapar su contenido.
- `applyTheme()`, `setTheme()`, `toggleTheme()`, `effectiveTheme()`, `applyAccent(color|null)`, `itemColorStyle(color)`, `inkOn(color)`.
- `openSheet({ title, body, foot, meta, footHidden, beforeClose, onClose, initialFocus })` → `{ panel, body, foot, close(force), setFootHidden, setTitle, isOpen }`; `closeSheet()`, `currentSheet()`. Una sola hoja; foco atrapado; Escape y fondo cierran; `beforeClose` puede devolver `false` (o una promesa) para retener la hoja con cambios sin guardar. Un botón de «Guardar» en el pie se enlaza al formulario con el atributo `form`.
  Ganchos de la app con `backAttrs`, `panelAttrs` y `closeAttrs` (0.11.1).
- `confirmDialog({ title, text, confirmLabel, cancelLabel, danger, noCancel })` → `Promise<boolean>`; `alertDialog(title, text)`. Con `danger` el foco inicial va a «Cancelar».
- `renderConflict(conflict, { fieldLabels, show, rowName, onResolve })` y `renderConflicts(list, …)` sobre `PendingConflict`; `onResolve(conflict, decision)` recibe `{ choice: 'mine' | 'theirs' }` o `{ choice: 'merge', fields }` listo para `client.resolveConflict`. Botones con `data-choice`.
- `renderRejected(batch, { describeError, rowName, onRetry, onDiscard })` y `renderRejectedList(list, …)` sobre `RejectedBatch`.
- `listRow({ id, title, meta, chips, actions, pending, deleted, selected, onClick, label })` y `renderList({ rows, label, empty })`.
- `createThemeToggle()` (botón sol/luna para `tools` de la cabecera) y `createThemeSelect()` (Sistema / Claro / Oscuro).
- `createCommandPalette({ items(query), placeholder, hotkey, limit, hiddenWhenEmpty })` → `{ open, close, toggle, isOpen, destroy }`. Ctrl K / Cmd K; `items` devuelve `{ group, text, sub, color, hint, keywords, run }`.
- Foco: `trapFocus(event, root)`, `focusFirst(root)`, `focusables(root)`, `lockScroll()`.
- `createDateField({ label, name, value, min, max, shortcuts, hint, required, describe, onChange })` → `{ element, input, get(), set(), setMin(), setMax(), setError(), validate() }`. Campo `type="date"` nativo con atajos («Hoy», «Mañana», «+7 días», «Quitar»; configurables con `days`, `date` o `clear`), descripción en palabras con distancia a hoy y validación de límites. Para un rango (entrada/salida), `salida.setMin(entrada.get())` en el `onChange` de la primera. `relativeDayLabel(key)` («Mañana», «en 3 días», «hace 2 semanas») y `longDayLabel(key)`.
- `createLabelPicker({ families, labels, selected, onChange, preferred, search, collapsed, onCreate, inherited, disabled })` → `{ element, get(), set(), setCatalog(), destroy() }`. Familias `{ id, name, color, archived, single }` y etiquetas `{ id, name, familyId, parentId, archived }`; chips coloreados por familia, resumen con quitar, búsqueda sin acentos, familias plegables, alta en línea con `onCreate(familyId, name)`. `labelChips(ids, labels, families, { onRemove, inherited })` para filas y resúmenes. Food puede pasar sus vocabularios fijos como dos familias («Dieta», «Alérgenos»).
- `createAppLauncher({ fetchApps, current, storageKey, appIcon, title, feedback })` → `{ open, attach(trigger) }`: hoja con las apps de `GET /api/v1/apps`, la actual marcada y la última lista guardada sin red; con `feedback`, el interruptor «Señalar para comentar» al pie. Con `createAppShell({ launcher })` la marca de la cabecera lo abre.
- **Feedback y QA** (0.15): `createFeedback({ app, api, userId, role, syncSummary, fallbackNode, container })` → `{ mode, signal, open, openDraft, drafts, pending, flush, refreshVerify, clear }`. Instrumenta con `data-feedback-id="<app>.<pantalla>.<sección>.<elemento>"` y `data-feedback-label` (la etiqueta nunca sale del texto de la página); `data-feedback-ignore` excluye zonas. Pasa `mode` al lanzador (`createAppLauncher({ feedback: feedback.mode })`) y llama a `feedback.clear(userId)` en `onSessionEnd`. `openFeedbackCenter({ api, app, canEdit, feedback })` para la entrada «Sugerencias y QA» del menú; `createFeedbackProgressiveForm` para «Ayuda y sugerencias» de los portales. Modo «Revisor de QA» (0.16): `createFeedbackReview({ api, app, appDomain })`, pásalo al lanzador como `review` y créalo al arrancar (atiende `?fb=<código>` y `?fbf=<función>`). Demo `#feedback`.
- **Adopción completa** (feedback, revisor, uso, lanzador): copia `demo/adopcion.ts`, que compila con `tsc`. El lanzador lleva los dos interruptores y la entrada «Sugerencias y QA» (`createAppLauncher({ feedback, review, center })`): sin botón en la cabecera.
- **Marcar para el catálogo** (lo lee `scripts/feature-catalog.mjs` al publicar). Vale cualquiera de estas formas, siempre con **ids y etiquetas literales**:
  - atributos `data-feedback-id="booking.reserva.guardar"` y `data-feedback-label="Guardar"` (o `'data-feedback-id': '…'` en `el()`);
  - opciones `feedbackId: '…', feedbackLabel: '…'` (también un ternario entre dos literales);
  - `fbMark(nodo, 'booking.reserva.guardar', 'Guardar')`;
  - `usage.run('booking.reserva.guardar', fn)` / `usage.track('…')` para operaciones.
  Un id construido en ejecución (`${…}`, concatenación, variable) no entra: sale en `dynamic` con su archivo y línea.
- **Idiomas** (0.19, portales): `const i18n = createI18n({ app: 'guests', dictionaries: { es, en } })`; `i18n.t('clave', { nombre })`, `i18n.formatDate/formatNumber/formatMoney`, `createLanguageSelect(i18n)` en la cabecera y `i18n.onChange(repintar)`. Los textos del kit pasan al mismo idioma solos. Las apps internas no llaman a `createI18n` y siguen en español. En el formulario de portales, los textos admiten `{ es, en }`.
- **Portales** (0.20): `createSaveState()` (estado de guardado por campo y global), `createSignaturePad()` (firma con PNG recortado y alternativa escrita), `createInstallPrompt({ appName, app })` (hoja «Instala la app» con alternativa web), `createAppShell({ nav: [] })` sin barra inferior e iconos `guest` y `organizer`.
- **Uso de funcionalidades** (0.17): `createUsage({ app, api: client.api, userId })` al arrancar (exposición, activación, `usage.run(id, fn)` en las 5–10 operaciones importantes, envío idempotente y aviso al equipo); `client.onSessionEnd((id) => usage.clear(id))`. Los ids deben empezar por la app (`booking.…`). El catálogo sale de `scripts/feature-catalog.mjs` al publicar.
- `createColorField({ label, value, suggestions, allowNone, openCustom, onChange, attrs })` → `{ element, get, set }`: color sin diálogo nativo; «Personalizado» abre matiz, saturación y brillo ya colocados sobre el color actual.
- Agentes de IA (contrato §3.1): `openProposalReview`, `renderSecretOnce`, `renderRiskSummary`, `renderProposalRow`, `proposalStatusChip`, `renderChangeList`, `renderAccessLog`, `createScopePicker`, `relativeTime`, `maskSecret`. La app pasa etiquetas ya traducidas (motivos de riesgo, tablas, campos) y sus ganchos en `attrs`; demo `#agents`.
- Barra de espacio de trabajo (Tasks): `renderWorkspaceBar({ name, sub, markIcon, tools, rows, rowClass, attrs })`, `renderAreaTabs({ label, items: [{ label, active, color, count, general, attrs }], leading })`, `renderStripTool({ label, icon, attrs })`, `renderQuickViews({ label, items: [{ label, active, icon, attrs }], leading })`, `renderNavMenu({ label, groups: [{ label, icon, open, items: [{ label, icon, active, disabled, attrs }], attrs }], header, hint, closeAttrs })`, `renderNavBackdrop(attrs)`, `renderTabBar({ label, items })`. Sin estado y sin manejadores; `icon` acepta un nombre del kit o un nodo propio.
- `renderMoneyBreakdown({ lines, total, totalLabel, compare, format, sort, max, emptyText })` → `div.moneybreak`: total con barra frente a `compare` (presupuesto, importe final; `.over` si lo excede), líneas `.mb-line` con participación y enlace/acción al origen, «y N más». Booking: «Coste real» de la reserva con `compare: { label: 'presupuestados', amount: finance.budget_amount }` y `href` a la factura en Invoices.
- `renderProjectCard({ id, title, meta, progress, color, pinned, urgency, chips, budget, system, pending, onOpen, onPin, actions, attrs, pinAttrs, ring })` → `article.card.project` con anillo (`ringSvg(pct, size)`), pin, estrella, chips, presupuesto y color propio (`--item-color`, tinta calculada).
- `createSortableList({ items, key, render, name, onReorder, label, buttons, disabled })` → `{ element, setItems, getItems, setDisabled, destroy }`. Arrastre por el asa (en táctil, pulsación mantenida), botones «Subir»/«Bajar» y teclado (flechas, Inicio, Fin sobre el asa); `onReorder(items, { item, from, to })` recibe el orden nuevo y la app guarda `position`: `positionBetween(prev?.position, next?.position)` da un valor entre vecinos y `renumber(n)` renumera toda la lista cuando los intermedios se agotan.
  Se puede anidar (una lista dentro de la fila de otra): cada una solo mueve sus filas directas. Si la app repinta desde el espejo tras `onReorder`, pase las filas nuevas con `setItems` en vez de crear otra lista.
- Página imprimible: `renderPrintPage({ brand: { appName, markIcon, line }, title, subtitle, meta, draft, intro, sections: [{ title, subtitle, groups: [{ title, subtitle, items: [{ title, text, image, chips: [{ text, kind }], meta }] }], breakBefore }], notes, footer, columns })` → `<article class="print-page">`; `createPrintView(spec, { onBack, actions, printLabel })` → `{ element, page, update, print }` con la barra «Volver · Imprimir / Guardar PDF» (que no se imprime); `printElement(root)` espera a las imágenes y llama a `window.print()`. La app la monta en su `main` (ruta propia); la impresión oculta cabecera, navegación, banners y botones, usa `@page A4` con 14 mm y no parte ni servicios ni platos. Con `draft` lleva la marca «BORRADOR».
- `openImportSheet({ title, parse(text), recalculate(document), fields(document, recalc), notices(document, recalc), onImport(document, recalc), importLabel, initialText, toleranceEur })` → `{ sheet, current(), setText() }`. `parse` devuelve `{ ok, document }` o `{ ok: false, errors: [{ path, reason }] }` (por ejemplo `parseImportDocument` del dominio); `recalculate` devuelve `calculated_*`, `totals_delta`, `within_tolerance` y `warnings` (por ejemplo `recalculate` del dominio). Piezas sueltas: `createJsonSource`, `renderImportHeader`, `renderImportLines`, `renderImportTaxes`, `renderImportReconciliation`, `renderSchemaErrors`, `formatMoney(valor, moneda)`.
- `compressImage(file, { maxSide: 1600, thumbSide: 480, quality, thumbQuality, mime })` → `{ full, thumb, width, height, thumbWidth, thumbHeight, originalWidth, originalHeight, mime, filename }`. WebP de calidad media (JPEG si el navegador no codifica WebP), orientación EXIF respetada, nunca amplía. Lo que se sube a `client.stageBlob` es `full` (y `thumb` si la app guarda miniaturas); el original no se conserva (contrato §11.3). `isImageFile(file)`, `supportsWebp()`, `compressedFilename(nombre, mime)`.
- `createCalendar({ events(range), view, date, onSelectDay, onSelectEvent, onRangeChange, weekStartsOn, viewSwitch, maxPerDay })` → `{ element, setView, setDate, getRange, refresh, destroy }`. Días completos (`YYYY-MM-DD`), eventos multidía con `start`/`end` incluidos, `color`, `badge` («[PRE]»), `abbr` (título corto que se muestra en los tramos del mes en móvil) y `status` (`data-status`). Teclado: flechas, Inicio (hoy), AvPág/RePág, Enter. Utilidades: `toDayKey`, `fromDayKey`, `addDays`, `startOfWeek`, `startOfMonth`, `daysBetween`, `todayKey`.
- `createQuantityField({ label, name, value, unit | units, decimals, fixedDecimals, min, max, step, hint, required, onChange })` → `{ element, input, select, get(), set(), setError(), parse() }`. Acepta «1.250,5», «1250.5» y «1 250,5»; con `step` hay botones y flechas; `fixedDecimals` muestra siempre los decimales (importes). `parseQuantity(texto)` y `formatQuantity(valor, decimales, locale, fijo)`.

### Barra de estado y sync-client 0.2

`statusSummary` añade «N rechazados» y la pastilla lleva `data-rejected`. `statusBanners` acepta `onShowRejected`, `onRetryRejected`, `onDiscardRejected` y `hideRejected`; con `lastError.code === 'USER_CHANGED'` muestra un banner informativo («ha entrado otra persona en este dispositivo») en lugar del de error.

## Montar la paleta Ctrl K en una app

La paleta vive en el kit; cada app aporta sus elementos. Se crea una vez al montar el shell y se destruye al desmontarlo; Ctrl K / Cmd K la abre y la cierra, y un botón de la cabecera puede abrirla en móvil.

```ts
import { createCommandPalette, icon, el, type PaletteItem } from '@ikisai/ui-kit';

// Dentro de renderShell(), después de createAppShell():
const palette = createCommandPalette({
  placeholder: 'Buscar o saltar: recetas, secciones, acciones…',
  hiddenWhenEmpty: ['Recetas'],            // grupos que solo aparecen al escribir
  items: (query): PaletteItem[] => [
    { group: 'Acciones', text: 'Nueva receta', hint: 'N', run: () => openRecipeEditor(null) },
    ...NAV.map((item) => ({ group: 'Ir a', text: item.label, run: () => navigate(item.hash) })),
    ...(query.length >= 2 ? recipesInMirror().map((r) => ({ group: 'Recetas', text: r.name, sub: r.category, run: () => openRecipe(r.id) })) : []),
    { group: 'Tema', text: 'Claro / oscuro', run: () => toggleTheme() },
  ],
});
// Botón en la cabecera (opcional, útil en móvil):
shell.header.querySelector('.tools')?.prepend(el('button', { class: 'iconbtn', type: 'button', 'aria-label': 'Buscar o saltar', onclick: () => palette.open() }, icon('search')));
// Al desmontar el shell:
palette.destroy();
```

`items` recibe la consulta ya normalizada (minúsculas, sin acentos) y se vuelve a llamar con cada tecla, así que puede leer el espejo local. El filtrado, el orden (primero lo que empieza por la consulta), el teclado (↑ ↓ Enter Esc) y el foco los pone el kit.

## Muestra y pruebas

```text
npm -w @ikisai/ui-kit run dev        # demo en http://localhost:5178
npm -w @ikisai/ui-kit run typecheck
npm -w @ikisai/ui-kit run test:e2e   # Playwright sobre la demo, 390 px y 1440 px
```

La demo (`demo/index.html`) es la referencia visual: tokens, controles, tarjetas y listas, los siete estados de sincronización con sus banners, el login y el shell, la hoja y el diálogo, conflictos y rechazados, la lista con estado, el selector de tema y la paleta, la recompresión de fotos, el calendario, el campo de cantidad, la hoja de importación, la página imprimible, la lista reordenable, el campo de fecha con atajos, el selector de etiquetas y la tarjeta de proyecto.

## Qué sigue

Ver `ESTADO.md` (pendientes y peticiones) y `CHANGELOG.md`.
