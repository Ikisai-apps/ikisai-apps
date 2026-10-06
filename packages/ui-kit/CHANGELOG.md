# Cambios de @ikisai/ui-kit

## 0.12.0 · 6 de octubre de 2026

- `renderProposalReview(options)` → `{ body, foot }`: la revisión de propuestas sin hoja, para una app que ya tiene la suya (Tasks). El pie lleva `.proposalreview-foot`, pegado abajo dentro de un contenedor que desplaza, y es `null` si la propuesta no está pendiente o no se puede decidir. `openProposalReview` acepta `sheet` con las opciones de `openSheet` (`backAttrs`, `panelAttrs`, `bodyAttrs`, `closeAttrs`, `hideTitle`, `onClose`). Petición de Tasks.
- Paleta: `limitWhenEmpty` (otro máximo sin consulta; Tasks: 18 sin consulta y 16 con ella) y `container` (dónde montarla; por defecto `document.body`).

## 0.11.2 · 6 de octubre de 2026

- `openSheet`: `bodyAttrs` (ganchos del cuerpo desplazable; `class` se suma a `sheet-body`) y `hideTitle` (título solo para lectores de pantalla: la app lo pinta en el cuerpo y el botón de cerrar flota arriba a la derecha). Las `class` de `backAttrs` y `panelAttrs` también se suman a las del kit. Para la hoja de Tasks, donde `#sheet` es el contenedor que desplaza y donde los módulos insertan contenido.

## 0.11.1 · 6 de octubre de 2026

- `openSheet`: `backAttrs`, `panelAttrs` y `closeAttrs` para poner los ganchos de la app en el fondo, el panel y el botón de cerrar (Tasks: `#sheetBack`, `#sheet`, `#closeDialog`). `close(true)` sigue siendo síncrono cuando no hay `beforeClose`, así que quien envuelve `closeSheet` ve el cierre al momento. La paleta ya usaba `#palette`, `#paletteInput` y `#paletteList`: no cambia.

## 0.11.0 · 6 de octubre de 2026

- **Agentes de IA** (contrato §3.1), piezas comunes para las cuatro apps; el kit no conoce el dominio: la app traduce códigos de riesgo, tablas y campos.
  - `openProposalReview({ proposal, changes, threshold, note, canDecide, onApprove, onReject, approveAttrs, rejectAttrs })`: hoja con agente, estado y fechas, resumen de riesgo, cambios agrupados y **pie fijo** «Rechazar» / «Aprobar N cambios» (solo si está pendiente y se puede decidir).
  - `renderSecretOnce({ value, label, warning, confirmBeforeDone, onDone, valueAttrs, copyAttrs, doneAttrs })`: clave entera en monoespaciada, «Copiar» que confirma «Copiada» y «Hecho» que pide «La he guardado» si no se copió. `maskSecret(value)` → `…AzvE`.
  - `renderRiskSummary({ affected, threshold, reasons: [{ label, tone }] })`: contador de afectados (con umbral si se alcanza) y motivos en chips.
  - `renderProposalRow({ id, agent, status, createdAt, expiresAt, affected, reasons, onOpen })` y `proposalStatusChip(status)`: estados `pending`, `approved`, `consumed` (Aplicada), `rejected`, `expired`, `revoked` con colores fijos; caducidad relativa con `relativeTime`.
  - `renderChangeList({ changes: [{ op, table, tablePlural, title, fields: [{ label, before, after }] }], max, opLabels })`: agrupado por operación y tabla, antes tachado y después resaltado, «y N más».
  - `renderAccessLog({ entries: [{ at, label, actor, actorKind, target, icon, tone }] })`: por días (Hoy, Ayer, fecha), con icono, hora y chip de persona o agente.
  - `createScopePicker({ areas, value, onChange })` → `{ element, get, set, isEmpty }`: «Todo, también lo futuro» → área entera → proyectos; valor `'*'` o `{ tabs, projects }`.
- Iconos `bot` y `copy`. `.chip.small`, `.chip.warn`.
- Barra de espacio de trabajo: la pestaña «General» conserva el borde discontinuo visible en tema oscuro (revisión de Tasks de #114).

## 0.10.0 · 6 de octubre de 2026

- **Barra de espacio de trabajo** para apps con áreas, vistas guardadas y menú agrupado (Tasks, paso 1 de su cáscara): `renderWorkspaceBar` (cabecera apilada: fila de marca con `.spacer` y herramientas, más filas), `renderAreaTabs` (`.tabstrip` con `.tabpill`, `.general`, color propio y `.tabcount`), `renderStripTool` (`.tabtool`), `renderQuickViews` (`.viewstrip` con `.viewpill`), `renderNavMenu` (menú de grupos `details.navgroup` con `.navitem`: desplegable en móvil con `show`, barra lateral fija de `--sidebar-width` en escritorio), `renderNavBackdrop` y `renderTabBar` (navegación inferior en móvil). Son piezas sin estado: la app las monta o las serializa y repinta en cada `render()`; los ganchos de la app van en `attrs`. Demo en `#workspace`, prueba `v13`.

## 0.9.0 · 6 de octubre de 2026

- Tarjeta de proyecto (revisión de Tasks): la estrella de urgencia es ámbar en los dos niveles y el relleno dice cuál (media = alta, entera = crítica); pistas de progreso, del anillo y del presupuesto mezcladas con la tinta, legibles en oscuro; presupuesto excedido en rojo también en tarjetas con color; chips legibles en tarjeta con color en tema oscuro; icono `euro` delante del coste (nuevo icono).
- **Desglose de importes** `renderMoneyBreakdown({ lines, total, totalLabel, compare, format, sort, max, emptyText })`: total arriba (con barra frente a una referencia como el presupuesto o el importe final, y en rojo si lo excede), líneas por categoría ordenadas de mayor a menor con su participación y enlace (`href`) o acción (`onOpen`) al origen, «y N más» para plegar. Pensado para el bloque «Coste real» de la reserva en Booking (proyección de Invoices); vale para el coste por etiqueta de un proyecto en Tasks o por servicio de un menú en Food.

## 0.8.1 · 6 de octubre de 2026

- `renderProjectCard`: `attrs` (atributos extra del `article`, p. ej. `data-drop-project`) y `pinAttrs` (del botón de fijar: `data-project-pin`, `data-tip`, `aria-label` propio), para que Tasks conserve sus ganchos. El bloque de dinero sale también sin presupuesto cuando hay coste (solo la cifra) y, con presupuesto excedido, añade «· excedido». `ring: false` deja la línea de progreso sin anillo (tarjeta del sistema).

## 0.8.0 · 6 de octubre de 2026

- `createSortableList` **anidable** (Food: platos dentro de servicios): cada lista solo mira sus filas y asas hijas directas (`:scope > …`), así el teclado, los botones y el arrastre de una lista interior no tocan la exterior ni al revés. Recordatorio: si la app repinta desde el espejo tras cada `onReorder`, use `setItems` con las filas nuevas en vez de crear otra lista, para que los movimientos seguidos lleven revisiones al día.
- **Controles sueltos**: `select`, `textarea` e `input` de texto, búsqueda, número, fecha, hora… fuera de `.field` llevan la misma piel que los campos (borde, papel, 46 px, foco con anillo, chevrón en `select`); `.compact` los deja en 36 px para filtros y filas. Reglas con `:where()` (especificidad cero): cualquier regla propia de la app o de un componente gana. Food puede retirar sus estilos de `.filters select`, `.linerow input/select`, `.service input[type=time]` y `.buyactions select`.
- `[hidden]{display:none!important}` en el CSS base: el atributo `hidden` gana a cualquier clase que fije `display` (`.fab`, `.chip`, `.row`…); Booking e Invoices pueden retirar sus parches (P19).
- Toast: la transición era `all` y animaba también `top`, así que al abrirse bajo la cabecera de la hoja llegaba tarde; ahora solo transicionan opacidad y transform.

## 0.7.2 · 6 de octubre de 2026

- Toast: con una hoja abierta se coloca justo bajo la cabecera de la hoja (título y cierre siguen visibles) en vez de en lo alto de la pantalla (aviso de Invoices en 390 px).

## 0.7.1 · 6 de octubre de 2026

- `renderLogin`: `ids` configurables (`email`, `password`, `submit`, `form`, `error`) y `title`, para que una app con pruebas sobre sus ids actuales (Tasks: `loginUsername`, `loginPassword`, `accountLogin`) adopte el login del kit sin tocarlas. La función de desmontaje restaura el `document.title` anterior.
- Calendario: `abbr` en `CalendarEvent` muestra un título abreviado dentro de los tramos del mes en móvil (petición de Booking); sin `abbr`, el tramo sigue siendo una barra.

## 0.7.0 · 6 de octubre de 2026

- `createLabelPicker`: selector de etiquetas por familias (Tasks; Food para dietas y alérgenos): chips conmutables coloreados por familia, resumen con quitar, familias plegables con contador, padres e hijas con sangría, búsqueda sin acentos (automática con más de 12 etiquetas), familias de una sola etiqueta (`single`), etiquetas preferidas primero, heredadas apagadas y alta en línea («Crear «x»») con `onCreate`. `labelChips` para resúmenes y filas.
- `renderProjectCard` y `ringSvg`: tarjeta de proyecto con anillo de progreso, pin, estrella de urgencia, chips, barra de presupuesto, estado pendiente, variante del sistema y color propio que tiñe toda la tarjeta con tinta calculada (de la interfaz heredada de Tasks).
- Demo y pruebas (40 en total).

## 0.6.1 · 6 de octubre de 2026

- Página imprimible: con `draft` activo la marca «BORRADOR» ocupaba unos 6 cm al principio de la hoja (una regla general la volvía `position: relative`); vuelve a ir superpuesta y la cabecera empieza arriba (avisado por Food).

## 0.6.0 · 6 de octubre de 2026

- `createSortableList`: lista reordenable con asa de arrastre (ratón; en táctil, pulsación mantenida para no robar el scroll), indicador de destino, fantasma, desplazamiento automático en los bordes, botones «Subir»/«Bajar», teclado sobre el asa (flechas, Inicio, Fin) y anuncio `aria-live`. `onReorder` recibe el nuevo orden y el movimiento; `positionBetween` y `renumber` calculan `position numeric` (contrato §2.1). Pedido por Food para platos, servicios y pasos; sirve a Tasks.
- `createDateField`: campo de fecha nativo (selector del sistema en móvil) con atajos «Hoy», «Mañana», «+7 días», «Quitar» (configurables), descripción en palabras con distancia a hoy («Martes, 13 de octubre de 2026 · en 7 días»), validación de obligatorio y límites, `setMin`/`setMax` para rangos (entrada y salida de Booking). `relativeDayLabel` y `longDayLabel` exportadas.
- Iconos `grip` y `chevronUp`. Demo y pruebas (38 en total).

## 0.5.0 · 6 de octubre de 2026

- Página completa imprimible (`renderPrintPage`, `createPrintView`, `printElement`): cabecera con marca Ikisai, título, fechas y datos; secciones (días) con grupos (servicios) y tarjetas con imagen, nombre público, descripción y chips de dieta y alérgenos; notas y pie; marca «BORRADOR». En pantalla se ve como papel A4; al imprimir: `@page A4` con 14 mm, sin navegación ni botones, salto de página por sección, `break-inside: avoid` por servicio y plato, `print-color-adjust: exact`, y espera a que las imágenes estén decodificadas antes de `window.print()`. Pensada para la vista del organizador de Food y reutilizable para la ficha imprimible de factura de Invoices.
- Demo con un menú de ejemplo de dos días y prueba (33 en total).

## 0.4.1 · 6 de octubre de 2026

- Toast: con una hoja, un diálogo o la paleta abiertos, el aviso aparece en la parte alta de la pantalla (`.toast.top`) y deja de taparles el cuerpo o el pie en móvil.
- README: cómo montar la paleta Ctrl K en una app.

## 0.4.0 · 6 de octubre de 2026

- Hoja de importación (`openImportSheet`): origen del JSON (pegar, archivo, portapapeles), errores de formato, cabecera con confianza, artículos con líneas dudosas y con aviso, impuestos, cuadre calculado frente a documento con tolerancia de 0,02 € y veredicto («REVISAR IMPORTES» no bloquea), campos y avisos propios de la app por inyección. Piezas sueltas: `createJsonSource`, `renderImportHeader`, `renderImportLines`, `renderImportTaxes`, `renderImportReconciliation`, `renderSchemaErrors`, `formatMoney`. El kit no depende del dominio: recibe `parse` y `recalculate` de la app (tipos estructurales compatibles con `ImportDocument` y `Recalculation` de `_domain/invoices`).
- Estilos genéricos de tabla (`.table`, `.num`, `tr.bad`).
- Demo y prueba nuevas (30 en total).

## 0.3.0 · 6 de octubre de 2026

- `compressImage(file, { maxSide, thumbSide, quality, thumbQuality, mime })`: WebP de calidad media con lado mayor 1600 px y miniatura de 480 px, orientación EXIF respetada, sin ampliar imágenes pequeñas, JPEG si el navegador no codifica WebP (contrato §11.3). `isImageFile`, `supportsWebp`, `compressedFilename`.
- `createCalendar`: calendario mensual y semanal de días completos sin librerías, accesible (`role="grid"`, flechas, Inicio, AvPág/RePág, Enter), barras multidía con el color del estado, «+N» por día, eventos síncronos o asíncronos por rango; utilidades `toDayKey`, `fromDayKey`, `addDays`, `startOfWeek`, `startOfMonth`, `daysBetween`, `todayKey`.
- `createQuantityField`: cantidad con unidad fija o seleccionable, número a la española (`1.250,5`), botones y flechas de paso, validación de mínimo, máximo y decimales, `fixedDecimals` para importes; `parseQuantity`, `formatQuantity`.
- `markIcon` en `renderLogin` y `createAppShell` para que cada app lleve su icono de marca (`bed`, `chef`, `invoice`, `tasks`).
- Iconos `minus` e `image`. Demo y 6 pruebas nuevas (28 en total).

## 0.2.1 · 6 de octubre de 2026

- Listas: los fragmentos de `.row-meta` se separan con un punto medio (antes dependía de que la app lo pusiera).

## 0.2.0 · 6 de octubre de 2026

- `openSheet` / `closeSheet`: hoja inferior (diálogo centrado en escritorio) con una sola instancia, foco atrapado, Escape y fondo, `beforeClose` para cambios sin guardar, pie ocultable y foco devuelto al abrir.
- `confirmDialog` / `alertDialog`: diálogo modal que resuelve una promesa; variante `danger` enfoca «Cancelar».
- `renderConflict` / `renderConflicts` sobre `PendingConflict`: tabla campo a campo, «Mantener la mía», «Tomar la del servidor» y «Combinar campo a campo» (contrato §6.3); `SYSTEM_COLUMNS`.
- `renderRejected` / `renderRejectedList` sobre `RejectedBatch` (sync-client 0.2): resumen de operaciones, error del servidor, «Reintentar» y «Descartar».
- Barra de estado: cuenta `rejected` (`data-rejected`, «N rechazados» en el texto) y banner de rechazados con «Ver», «Reintentar» y «Descartar»; aviso `USER_CHANGED` como banner informativo sin tratarlo como error.
- `listRow` / `renderList`: lista con filete y chip «Pendiente de sincronizar», papelera, selección y filas pulsables accesibles.
- `createThemeToggle` (sol/luna para la cabecera) y `createThemeSelect` (Sistema / Claro / Oscuro).
- `createCommandPalette` (Ctrl K): grupos, búsqueda sin acentos, teclado, `hiddenWhenEmpty`; `filterPaletteItems` y `foldText` exportados.
- Utilidades de foco: `trapFocus`, `focusFirst`, `focusables`, `lockScroll`.
- Demo y 12 pruebas nuevas (6 escenarios × 2 tamaños).

## 0.1.1 · 6 de octubre de 2026

- Barra de estado: «Todo sincronizado» (en vez de «Todo guardado») cuando hay red y la cola está vacía, como ya mostraba Invoices.
- `apps/invoices` consume el kit: tokens, login, shell, barra de estado, DOM, iconos y toast.

## 0.1.0 · 6 de octubre de 2026

Primera entrega: tokens + barra de estado + shell de login.

- Tokens «Taller» (`tokens.css`): color, Fraunces + Inter alojadas, espaciado, radios, sombras, capas, movimiento; modo oscuro cálido automático y manual (`data-theme`); acento derivado de `--accent` que la app puede fijar con el color elegido por la persona.
- `base.css`: reinicio, tipografía, foco visible, utilidades, `prefers-reduced-motion`.
- `components.css`: botones, campos, chips (incluido pastel por `--chip`), tarjetas (incluida `.colored`), listas con fila pendiente, secciones, vacíos, esqueletos, FAB, banners, toast, pastilla de estado, marca, shell (cabecera, navegación inferior/lateral, contenido), login, hoja inferior, diálogo y conflictos (solo CSS).
- `dom.ts`, `icons.ts` (46 iconos de trazo, registrables), `theme.ts`, `toast.ts`.
- `createStatusBar` y `statusBanners` sobre `SyncStatus` (contrato §6.4).
- `renderLogin` y `createAppShell` comunes.
- Demo `demo/index.html` y pruebas Playwright (`tests/demo.spec.ts`) a 390 px y 1440 px.
