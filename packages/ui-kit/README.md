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

**Prefijos (regla del 19-10-2026):**
- Las clases nuevas del kit no usan un prefijo que ya use una app (`inv-` es de Finance), ni las apps uno del kit (`stk-`, `space-`, `cal-`…). El prefijo es lo que va antes del primer guion.
- Lo vigila `tests/v45.spec.ts`, que lee el CSS de todas las apps.
- Las coincidencias que ya había el 19-10 están en su lista `KNOWN`, con su motivo. Esa lista no crece: si algo choca, se cambia el nombre.

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
- **Feedback y QA** (0.15): `createFeedback({ app, api, userId, role, syncSummary, fallbackNode, container })` → `{ mode, signal, open, openDraft, drafts, pending, flush, refreshVerify, clear }`. Instrumenta con `data-feedback-id="<app>.<pantalla>.<sección>.<elemento>"` y `data-feedback-label` (la etiqueta nunca sale del texto de la página); `data-feedback-ignore` excluye zonas. Pasa `mode` al lanzador (`createAppLauncher({ feedback: feedback.mode })`) y llama a `feedback.clear(userId)` en `onSessionEnd`. `openFeedbackCenter({ api, app, canEdit, feedback })` para la entrada «Sugerencias y QA» del menú (con `scope: 'mine'`, «Mis reportes»: Abiertos, Pendientes de verificar y Mis borradores, solo de quien mira, para las apps cuya revisión vive en Central, 0.58); `createFeedbackProgressiveForm` para «Ayuda y sugerencias» de los portales. Modo «Revisor de QA» (0.16): `createFeedbackReview({ api, app, appDomain })`, pásalo al lanzador como `review` y créalo al arrancar (atiende `?fb=<código>` y `?fbf=<función>`). Demo `#feedback`.
- **Adopción completa** (feedback, revisor, uso, lanzador): copia `demo/adopcion.ts`, que compila con `tsc`. El lanzador lleva los dos interruptores y la entrada «Sugerencias y QA» (`createAppLauncher({ feedback, review, center })`): sin botón en la cabecera.
- **Marcar para el catálogo** (lo lee `scripts/feature-catalog.mjs` al publicar). Vale cualquiera de estas formas, siempre con **ids y etiquetas literales**:
  - atributos `data-feedback-id="booking.reserva.guardar"` y `data-feedback-label="Guardar"` (o `'data-feedback-id': '…'` en `el()`);
  - opciones `feedbackId: '…', feedbackLabel: '…'` (también un ternario entre dos literales);
  - `fbMark(nodo, 'booking.reserva.guardar', 'Guardar')`;
  - `usage.run('booking.reserva.guardar', fn)` / `usage.track('…')` para operaciones.
  Un id construido en ejecución (`${…}`, concatenación, variable) no entra: sale en `dynamic` con su archivo y línea.
- **Idiomas** (0.19, portales): `const i18n = createI18n({ app: 'guests', dictionaries: { es, en } })`; `i18n.t('clave', { nombre })`, `i18n.formatDate/formatNumber/formatMoney`, `createLanguageSelect(i18n)` en la cabecera y `i18n.onChange(repintar)`. Los textos del kit pasan al mismo idioma solos. Las apps internas no llaman a `createI18n` y siguen en español. En el formulario de portales, los textos admiten `{ es, en }`.
- **Portales** (0.20): `createSaveState()` (estado de guardado por campo y global), `createSignaturePad()` (firma con PNG recortado y alternativa escrita), `createInstallPrompt({ appName, app })` (hoja «Instala la app» con alternativa web), `createAppShell({ nav: [] })` sin barra inferior e iconos `guest` y `organizer`.
- **Apps con el CSS del kit acotado** (Tasks, Finance): al arrancar, `setKitLayer(() => document.getElementById('kitLayer'))`. Así todo lo flotante del kit (avisos, hojas, diálogos, feedback, revisor) va a esa capa y conserva sus estilos.
- **Gesto del feedback:** mantener pulsado un campo de texto no abre el composer, a propósito (seleccionar texto y el menú del sistema siguen funcionando al escribir); se comenta sobre su etiqueta o su sección.
- **Prueba de humo del feedback** (0.25): en la prueba `@smoke` de cada app, `await feedbackRoundTrip(page, { target: '<elemento con data-feedback-id>' })` desde `packages/ui-kit/testing/feedback-smoke.ts`. Para comentar sobre una hoja de la app, ábrela en `before: async (page) => …` (se ejecuta con el modo ya encendido). Los portales: `portalHelpRoundTrip(page, { choices: […] })`.
- **Texto con sugerencias** (0.27): `createSuggestField({ label, values, mode: 'pick' | 'unique' })` o `attachSuggestions(input, { values, mode })` sobre un campo propio.
- **«Atrás»** (0.26): `createAppShell` lo gestiona solo: vuelve a la pantalla anterior o al inicio, cierra primero hojas, diálogos y el composer, y desde el inicio pregunta «¿Cerrar la app?». Las apps con cáscara propia (Tasks) llaman a `installBackNavigation({ home })` al arrancar.
- **Versiones nuevas** (0.23): `initAppUpdates({ isSafe: () => sinColaNiConflictosNiEditor, enabled: import.meta.env.PROD })` en lugar del `updates.ts` propio; se aplican solas al abrir si es seguro.
- **Uso de funcionalidades** (0.17): `createUsage({ app, api: client.api, userId })` al arrancar (exposición, activación, `usage.run(id, fn)` en las 5–10 operaciones importantes, envío idempotente y aviso al equipo); `client.onSessionEnd((id) => usage.clear(id))`. Los ids deben empezar por la app (`booking.…`). El catálogo sale de `scripts/feature-catalog.mjs` al publicar.
- `createColorField({ label, value, suggestions, allowNone, openCustom, onChange, attrs })` → `{ element, get, set }`: color sin diálogo nativo; «Personalizado» abre matiz, saturación y brillo ya colocados sobre el color actual.
- Agentes de IA (contrato §3.1): `openProposalReview`, `renderSecretOnce`, `renderRiskSummary`, `renderProposalRow`, `proposalStatusChip`, `renderChangeList`, `renderAccessLog`, `createScopePicker`, `relativeTime`, `maskSecret`. La app pasa etiquetas ya traducidas (motivos de riesgo, tablas, campos) y sus ganchos en `attrs`; demo `#agents`.
- Barra de espacio de trabajo (Tasks): `renderWorkspaceBar({ name, sub, markIcon, tools, rows, rowClass, attrs })`, `renderAreaTabs({ label, items: [{ label, active, color, count, general, attrs }], leading })`, `renderStripTool({ label, icon, attrs })`, `renderQuickViews({ label, items: [{ label, active, icon, attrs }], leading })`, `renderNavMenu({ label, groups: [{ label, icon, open, items: [{ label, icon, active, disabled, attrs }], attrs }], header, hint, closeAttrs })`, `renderNavBackdrop(attrs)`, `renderTabBar({ label, items, standalone? })`. Sin estado y sin manejadores, salvo `standalone` (0.58, solo en la app instalada): `'flush'` baja los botones hasta el borde, sin franja vacía; `'autohide'` la esconde al bajar y la trae al subir, al llegar al final, al deslizar desde abajo o con el foco (`bindTabBarAutoHide(nav)`); `'both'`, las dos. Pone `--tabbar-offset` en `:root` (lo que ocupa la barra a la vista; 0 escondida), que usa el `.fab`; úsala en lo que flote encima de la barra; `icon` acepta un nombre del kit o un nodo propio.
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

## Piezas comunes (MUELA-075, lote A, 0.42)

Piezas pequeñas sin estado y sin lógica de negocio: el orden, los plazos, los tonos y los textos de cada cosa los calcula la app y se los pasa. Todas usan `var(--tap)` en lo que se toca y dicen el estado con texto además del color. Se ven en la demo, en `#pieces`.

- **`renderMedal({ image?, name?, initials?, icon?, color?, size?, label?, cover? })`** e **`initialsOf(name)`**: el medallón.
  - Muestra la imagen o, si no hay o no carga, las iniciales o el icono. Tamaños 40, 44 (por defecto) o 72.
  - Es decorativo (`aria-hidden`) salvo con `label`, que lo convierte en `role="img"`.
  - `cover` pone la imagen de fondo de una tarjeta grande.
  - Clases `medal-`.
- **`renderStages({ label, stages, current, bad?, onPick?, mini?, caption?, stopText?, feedbackId? })`** y **`stageStates`**: el recorrido.
  - Un `<ol>` con «etapa n de N» y `aria-current="step"`; `current` `-1` o `null` quiere decir parado.
  - Con `onPick`, cada etapa es un botón de 64 px; `mini` es la variante para filas.
  - Clases `stage-`.
- **`renderGroups({ label, groups, toneOf?, row, worstFirst?, chips?, feedbackId? })`** y **`worstOf(tones)`**: grupos con resumen de lo peor (alert > warn > ok).
  - El borde sigue a lo peor. El resumen va escrito: el que pasa la app o, por defecto, «1 con alerta · 2 con aviso».
  - Se abren solos los grupos que piden algo. `chips` filtra por lo peor.
  - Sirve también para grupos por etapa con la acción en la fila: `open` y `listRow` con `actions`.
  - Clases `worst-`.
- **`deadlineText(due, { now?, timeZone?, prefix?, noLeft? })`** y **`deadlineInfo`**: el plazo en texto, por ejemplo «Antes del mié, 14 oct, 19:20 (quedan 5 h)».
  - Sin hora, no la dice; el año solo sale cuando no es el actual.
  - Usa la hora de la casa (`Europe/Madrid`).
- **`renderStats([{ value, label, tone?, hint?, onClick?, selected? }], { label? })`**: cifras de color, siempre con su etiqueta. Con `selected` (0.58), la cifra que filtra lleva `aria-pressed="true"` (y las demás con botón, `false`) y un borde grueso del acento. Clases `stat-`, nunca `.kpi`.
- **`renderChecks({ items: [{ ok, text, detail?, action? }], verdict?, onlyPending? })`**: veredicto y comprobaciones ✓ / !.
  - El veredicto lleva `role="status"`, con el aspecto de `.imp-verdict`.
  - Clases `check-`.
- **`renderTile({ title, value, levelText, level?: { pct, min?, tone? }, medal?, icon?, onClick? })`**: baldosa con cifra y relleno.
  - `levelText` es obligatorio.
  - Clases `tile-`.
- **`bindOnline(button, { client?, reason?, retry?, reasonHost? })`**: desactivado con el motivo.
  - Sin red, el botón queda `aria-disabled` y el clic no llega a la app. Una línea enlazada con `aria-describedby` dice por qué, con «Reintentar» si se pasa `retry`.
  - Devuelve la función que lo suelta. **Solo para lo que necesita red:** lo que funciona con la cola de sincronización no se ata nunca.
- **`renderAreaTabs({ …, layout: 'columns' })`** y `countText` en cada pestaña: etapas con su cifra.
  - En el móvil sigue siendo la tira.
  - Desde 1024 px, una columna por etapa con la cifra grande y lo que cuenta.
  - Sin `layout`, todo queda igual que antes.

### Lote B1 (0.43): piezas compuestas

Se ven en la demo, en `#piecesb`. El orden de las colas, qué está «ahora», los plazos y los precios los calcula la app.

- **`renderCover({ title, image?, color?, pill?, pillTone?, stats?, faces?, titleExtra?, tools?, onOpen?, compact? })`**: la portada.
  - Muestra la foto en grande, o el color con las iniciales.
  - Lleva píldora, caras y las cifras escritas por la app. Pulsarla abre.
  - Clases `cover-`.
- **`createFocus({ items, onDone?, onOpen?, emptyTitle?, emptyText? })`**: lo que toca ahora.
  - Una tarjeta grande con «✓ Hecha» (`role="checkbox"`), «Abrir» y «Siguiente ›», que va rotando.
  - Las dos siguientes asoman detrás. «n de N por hacer» se anuncia.
  - `setItems` conserva la tarjeta si sigue en la cola. Sin `onDone`, es de solo lectura.
  - Clases `focus-`.
- **`createCoverCarousel({ label, slides, index?, onChange?, top? })`**: la portada que se pasa con flechas.
  - Lleva `aria-roledescription` «carrusel» y «diapositiva», y anuncia «n de N».
  - Se pasa con las flechas del teclado, con flechas y puntos de 46 px, o deslizando en horizontal (más de 50 px y más que en vertical, con `touch-action: pan-y`).
  - Sin animaciones.
- **`renderLead({ items, top?, max?, onDone?, onOpen?, extra? })`**: lo primero en grande.
  - Las tres primeras van en tarjetas grandes con su número: en el móvil, en un carril que se desliza; desde 900 px, en columnas.
  - El resto, en una cola numerada desde el 4, con su barra de urgencia (`weight`) y «Ver N más».
  - Clases `lead-`.
- **`renderNow({ now?, next?, rest, restTitle?, showDone? })`**: lo de ahora abierto y el resto plegado.
  - Lo de ahora lleva una barra (`progressbar`) y «Quedan…»; debajo, lo siguiente.
  - El resto va en `<details>`, cuyo contenido se pinta al abrir. Lo hecho queda tras «Ver lo ya hecho (N)».
  - Clases `now-`.
- **Calendario de precios:** `createCalendar` acepta en `dayInfo` los campos `price`, `tone` (`low` / `high`) y `toneLabel`.
  - El precio sale bajo el número y el día toma su tono.
  - `toneLabel` se lee siempre y aparece en el panel del día.

### Lote B2 (0.44): recorrer y decidir

Se ven en la demo, en `#piecesb2`. Qué falta, el orden de la cola, la validación y quién decide son de la app.

- **`renderSteps({ items: [{ id, title, done, stateText?, action?, minutes?, icon?, href?|onClick? }], title?, readyText? })`**: paso a paso con lo siguiente en grande.
  - Arriba, «Te quedan N cosas» con su barra.
  - Lo siguiente va en grande, con su verbo y lo que tarda. El resto lleva su estado escrito, y lo hecho cabe en una línea.
  - Sin pendientes, dice «¡Todo listo!».
  - Clases `step-`.
- **`createQueue({ label, items, primary?, secondary?, onOpen?, onAll?, readOnlyText?, doneTitle?, doneText?, doneActions? })`**: una cosa cada vez.
  - Muestra «n de N» con un segmento por cosa, de color según la gravedad. La tarjeta lleva franja y etiqueta de gravedad, cifra grande y de 2 a 4 datos.
  - La acción principal mide 54 px; «Saltar», «Abrir la ficha» y «Ver todo», 46 px. Al acabar, «Has pasado por todo».
  - La app llama a `done()` tras su acción y a `undo()` desde el «Deshacer» de `toastWithAction`.
  - La tarjeta sale de lado al pasar, salvo con movimiento reducido.
  - Clases `queue-`.
- **`createVoteDeck({ label, items, card, name, onVote, onOpen?, onRestart?, texts })`**: votar deslizando.
  - Se vota deslizando: a la derecha, a favor; a la izquierda, en contra. El sello aparece a los 40 px y el voto cuenta a los 90 px. Un gesto vertical deja mover la página.
  - Alternativas al gesto: dos botones de 46 px y las flechas del teclado ← →.
  - Los textos son de cada app («Se mantiene» y «Retirar», o «Aprobar» y «Descartar»).
  - Clases `vote-`.
- **`createStepForm({ label, questions, answered?, onAnswer, onDone?, doneTitle?, doneText? })`**: pregunta a pregunta, solo de lo que falta.
  - Muestra «Pregunta n de N» con su barra.
  - Una opción guarda al tocarla y pasa a la siguiente; las de varias opciones y el texto se aceptan con «Aceptar» o Intro.
  - El guardado se ve con `createSaveState`. Sin red, queda pendiente y se sigue; con otro fallo, no se avanza.
  - Si `onAnswer` lanza `StepFormInvalid`, se queda en la pregunta y enseña el motivo.
  - `goTo(id)` sirve para «Cambiar» desde una revisión.
  - Clases `ask-`.

### Lote B3 (0.45): dinero y tiempo

Se ven en la demo, en `#piecesb3`. El saldo, los choques, las noches y qué está «ahora» los calcula la app.

- **`renderMoneyBreakdown({ mode: 'statement', total, subtitle?, upcoming?, moves?, totalLabel? })`**: el extracto.
  - Muestra en grande lo que queda («Te queda por pagar») y debajo «Próximamente», con borde discontinuo.
  - Los movimientos (`MoneyMove`: `in` pago, `doc` factura, `due` por pagar) van agrupados por mes, con su chip de estado escrito.
  - Sin `mode`, el desglose es el de siempre.
- **`renderTimeline({ label, from, today, lanes, bands?, summary? })`**, con las funciones **`timelineWindow`** y **`timelineSpan`**: tu año en una línea de tiempo.
  - Abarca doce meses: una pista por persona y la franja de retiros, con la raya de hoy.
  - Marca los choques con rayas y «!», y lo pasado más claro.
  - En el móvil se desliza en horizontal (región enfocable); desde 900 px cabe entera.
  - Debajo va el resumen mes a mes en texto.
  - Clases `year-`.
- **`renderHourAgenda({ label, items, now? })`**: la agenda por horas con la línea de ahora. Va debajo de `createDayTabs`.
  - Lo ya hecho queda plegado («2 actividades antes»), y la raya «Ahora · 12:20» solo sale si hay `now`.
  - Lo de ahora y lo siguiente se marcan con su chip. Las comidas llevan su color (`kind: 'meal'`).
  - Clases `hour-`.

### Lote C (0.46): bandeja

Se ve en la demo, en `#piecesc`.

- **`renderTray({ label, groups: [{ key, label, rows, collapsed? }] })`** y **`renderTrayRow`**: la bandeja por áreas, una capa visual que no sabe de conflictos. La usa también SES, que agrupa por estado.
  - **Área:** se pliega y lleva su recuento.
  - **Línea:** solo el título va junto al medallón (44 px, decorativo), con sangría colgante. Debajo, a todo el ancho: quién y cuándo (la fecha en su propia línea), lo que choca, los chips y las acciones (46 px).
  - **Variante `rejected`:** lleva icono.
  - Clases `tray-`.
- **`renderConflicts(list, { layout: 'tray', groupBy?, medal?, theirsName?, labels?, both?, undoMs? })`**: los conflictos en la bandeja.
  - Cada línea dice lo que choca: «Notas: «…» frente a «…»». Lleva dos botones al mismo nivel, «Lo mío» y «Lo de Laura» (con `theirsName`), o «Lo del otro dispositivo» si fuiste tú. En un borrado son «Borrar» y «Conservar».
  - **«Los dos»:** aparece en listas y une las dos sin repetir.
  - **«Ver diferencias»:** abre en una hoja la tarjeta de siempre, con «Combinar».
  - **`undoMs`:** retrasa la llamada a `onResolve` y ofrece «Deshacer» en la línea y en el aviso. Si se cierra la app antes, no se guarda y el conflicto sigue.
  - Se conservan los `data-choice` (`mine`, `theirs`, `both`, `diff`) y las marcas de `feedbackId`; se suman `.los_dos` y `.deshacer`.
  - **Sin `layout`, todo queda igual que antes:** las cuatro apps no cambian hasta que lo encienden.

## Menú lateral común (MUELA-013, 0.47)

Todo es opcional: sin `menu`, `search` ni `navLayout`, la cáscara queda como siempre. Cada app lo enciende en su pasada.

- **`createAppShell({ …, menu })`** (K7): la marca (46 px) abre el cajón del menú en vez de la hoja de apps. El lanzador va dentro, en `menu.launcher`.
  - **Cajón:** está a la izquierda, en el móvil y en el ordenador. Es un diálogo modal: lleva `aria-expanded` en la marca, deja el foco en la primera entrada y lo atrapa dentro; Escape, el fondo y «atrás» lo cierran.
  - **Orden:** perfil y rol, con la línea de sincronización debajo; botón de tema; Recientes (3); Secciones como azulejos que despliegan sus filas debajo; `blocks` propios de la app (K8); Apps de Ikisai, sin la actual; Comentarios y ayuda; Cerrar sesión.
  - **Línea de sincronización:** dice lo más urgente: «1 conflicto · toca para resolver», «Sin conexión · 2 sin enviar», «Error al sincronizar»… Va en rojo si hay un problema. Tocarla resuelve los conflictos o sincroniza.
  - **Comentarios y ayuda:** «Señalar un fallo aquí» (`signalHere`) y los bloques del lanzador con sus clases de siempre (`.launcher-center`, `.launcher-signal`, `.launcher-review`).
  - **`menu.column`:** en el ordenador, además, una columna fija de 316 px. La barra de pestañas pasa entonces abajo, en horizontal.
  - **`shell.menu`:** `open()`, `close()` y `refresh()`, este tras cambiar recientes o recuentos.
  - **En el móvil estrecho**, la pastilla de estado se queda en un punto de color. «Sin red», pendientes y conflictos se siguen viendo sin abrir el cajón, y el texto va en su nombre accesible.
- **`search: { onOpen, label? }`** (K8): en la cabecera, una lupa en el móvil y la caja «Buscar en {app}… Ctrl K» en el ordenador. La app abre su paleta.
- **`navLayout: 'bar'`** (K12): la barra de pestañas abajo y en horizontal también en el ordenador.
- **Paleta:**
  - `keepOrder` (K1) respeta el orden que da la app.
  - «Atrás» cierra la paleta (K10).
- **`captureFeedbackTarget({ delay: 0 })`** (K2): basta un toque para señalar, y la barra lo dice.
- **`createAppLauncher().mount(host, { hideCurrent, part })`**: pinta las apps o los bloques de feedback en otro sitio, como el cajón.
- **«‹ Volver a…» (K9, 0.48): `createAppShell({ returnTo: true | { feedbackId } })` o `installBackNavigation({ returnTo: true })`.**
  - **Convención entre apps:** `…?desde=<app>&volver=<url>&titulo=<a dónde>`, en el hash o en la búsqueda. El enlace se arma con `withReturnTo(destino, { from, title })`.
  - **Al llegar con `volver`:** sale arriba «‹ Volver a {titulo}» y se quitan `volver` y `titulo` de la URL. «Atrás» desde el inicio vuelve a la app de origen, sin «¿Cerrar la app?».
  - **`desde` sola no cuenta** y se deja intacta: Booking → Finance la usa con su propio sentido. Solo valen URLs de `*.ikisai.com` o del mismo origen.
- **Clases:** prefijo `appmenu-`, sobre `navmenu-head`, `navmenu-close` y `navmenu-backdrop`. La barra lateral `.navmenu` de Tasks no cambia.

## Muestra y pruebas

```text
npm -w @ikisai/ui-kit run dev        # demo en http://localhost:5178
npm -w @ikisai/ui-kit run typecheck
npm -w @ikisai/ui-kit run test:e2e   # Playwright sobre la demo, 390 px y 1440 px
```

La demo (`demo/index.html`) es la referencia visual: tokens, controles, tarjetas y listas, los siete estados de sincronización con sus banners, el login y el shell, la hoja y el diálogo, conflictos y rechazados, la lista con estado, el selector de tema y la paleta, la recompresión de fotos, el calendario, el campo de cantidad, la hoja de importación, la página imprimible, la lista reordenable, el campo de fecha con atajos, el selector de etiquetas y la tarjeta de proyecto.

## Qué sigue

Ver `ESTADO.md` (pendientes y peticiones) y `CHANGELOG.md`.
