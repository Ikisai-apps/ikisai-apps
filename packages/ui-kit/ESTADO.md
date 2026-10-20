# UI kit · estado

Actualizado: 7 de octubre de 2026. Agente UI, rama `ui/kit`, directorio `packages/ui-kit`.

## Hecho

- v0.53.1: `floorPlanFromRow` con `$blob` = sin archivo; `v39` estable (cabecera de la demo).
- v0.53.0: ajustes de Central y Food: iniciales legibles sobre cualquier color, `.filterchip` de 46 px, azulejos sin partir palabras, cola plegada en grupos, ruta corta, foco con su texto y su acción, `focusAction` y `setFilter` sin guardar.
- v0.52.0: `createSpaceMap`, el mapa de zonas (MUELA-024): dibujo de fondo, capa de estancias y camas por colores, lista equivalente, sin formas y sin red.
- v0.51.0: `veil: 'full'` en `renderMedal({ cover: true })`, con 4,5:1 en toda la foto.
- v0.50.0: inventario en baldosas, ayudantes de feedback con el menú lateral, cola de propuestas sin diálogo y con «Deshacer», `.segmented` a 4,5:1 y 46 px.
- v0.49.0: ajustes de Organizers: portada con encabezado, salir traducible y en el móvil, Intro en acciones de fila, acción de comprobación de 46 px, ids literales en grupos y pasos, línea sin red compartida y hueco en el extracto.
- v0.48.0: «‹ Volver a…» entre apps (K9) opcional, con «atrás» que vuelve a la app de origen sin preguntar.
- v0.47.0: cáscara con menú lateral común opcional (`menu`, `search`, `navLayout: 'bar'`), `keepOrder` y «atrás» en la paleta, señalar con un toque, marca de 46 px.
- v0.46.1: `createQueue`: un toque rápido sobre la tarjeta que sale ya no confirma la siguiente ni se pierde.
- v0.46.0: bandeja por áreas (`renderTray`) y `renderConflicts({ layout: 'tray' })` con «Lo mío / Lo de …», «Los dos» y «Deshacer». Tanda 27 completa.
- v0.45.0: piezas comunes, lote B3: extracto en `renderMoneyBreakdown`, tu año en una línea de tiempo y agenda por horas. Lote B completo.
- v0.44.0: piezas comunes, lote B2: paso a paso, una cosa cada vez, votar deslizando y pregunta a pregunta (`createStepForm`).
- v0.43.0: piezas comunes, lote B1: portada y foco, portada con flechas, lo primero en grande, lo de ahora y precios en el calendario.
- v0.42.0: piezas comunes, lote A (MUELA-075): medallón, recorrido, grupos con lo peor, plazo en texto, cifras, comprobaciones, baldosa, `bindOnline` y etapas con su cifra en columnas.
- v0.41.0: conflictos con «Reintentar con lo mío» como principal y comparación por contenido; avisos con «Deshacer» que se apilan y botón de 46 px; contraste AA de `--muted`, `.ok` y `.alert`.
- v0.40.0: `createItemCatalog` tiene `refresh()`: repinta con los datos de ahora sin tocar el filtro.
- v0.39.0: `createSpacePicker` acepta `texts` (vacío, buscador y marcas) para usarlo con otras filas en forma de espacio, como los oficios de Tasks; sin ellos, igual que antes.
- v0.38.1: `createCountSession`: «Revisar y cerrar», la barra y «Sin contar» se actualizan también con el foco en una casilla.
- v0.38.0: `createMovementForm` (entrada con lote y coste, salida con motivo y primero lo que caduca antes, traslado en un solo lote) y `createCountSession` (a ciegas, línea a línea sin red, retomar, revisar diferencias y cerrar al sincronizar); la fuente escribe movimientos y recuentos.
- v0.37.0: `createItemCatalog` (buscar, filtros a un toque con recuento, agrupar por sitio, tipo o categoría, acciones del kit y de la app, columnas con ancho) y `createItemSheet` (stock por sitio y lote con coste medio, datos con máquinas, unidades y movimientos con su origen); la fuente lee lotes y costes y escribe la ficha.
- v0.36.0: `createItemPicker` (R3): buscar por nombre y alias con tipo y stock, crear al momento con aviso de parecidos (también sin red), «Ya existe: usar ese» cuando dos dispositivos crean el mismo nombre, cantidad con las unidades del artículo y del proveedor y su equivalencia, sitio; `createSyncItemSource` y el modelo puro exportado.
- v0.35.0: `createCalendar` con `select` afinado en Android: deslizar con el dedo de verdad (`touch-action: pan-y pinch-zoom`; antes Android lo cancelaba), también mientras se eligen días; «Nueva estancia» trae el calendario a la vista; pista de toque; sin hover pegado ni selección de texto al mantener; barra encima de `.nav`/`.tabbar`. U6: textos del calendario por `kt`, reetiquetado en vivo al cambiar de idioma.
- v0.34.0: `createSuggestionSource(client)` sobre las sugerencias de `sync-client` 0.7.0 (lista, aprobar, descartar, retirar, vista previa del lote y errores del contrato con texto claro); `createProposalList` en camelCase como la API (la forma de la 0.33.0 se sigue aceptando) y con detalle asíncrono.
- v0.33.0: calendario de persona (capas con leyenda, sombreado, notas, panel del día, elegir días, deslizar entre meses; nombre corto solo en el primer día de cada tramo) y cola de propuestas `createProposalList` (revisar y «Mis propuestas»; confirmar siempre). `confirmDialog` admite `body`.
- v0.32.0: camas con plazas fijas y supletorias (`extra_capacity`), sofá cama y camas en salas; `spaceSeats` suma fijas y supletorias.
- v0.31.0: árbol de espacios para Booking: `rowActions`, plazas calculadas por camas (`spaceSeats`), «+» con cama en una habitación, fila que no estruja el nombre.
- v0.30.0: espacios (R1): `createSpaceTree` (árbol con arrastre y reglas, ficha, duplicar, archivar) y `createSpacePicker` (más usados a un toque, búsqueda con la ruta), contra una `SpaceSource` inyectable.
- v0.29.0: `createLevelStar` (estrella de nivel por pasos, como la prioridad de Tasks) para las capacidades de Central.
- v0.28.1: conflicto de un `call` sin tabla («Un cambio pendiente»); humo de Food estable (pulsación larga tras la animación de la hoja).
- v0.28.0: tarjeta de conflicto con decisiones arriba («Quedarme con lo del servidor», «Reintentar con lo mío», «Ver diferencias»), título legible (`rowName`, `tableLabels`, nunca el id) y quién lo cambió (`currentUserId`, `conflictIntro`).
- v0.27.2: «atrás» sigue solo si tras saltar hojas cerradas cae en la misma pantalla (humo de Booking); CI completa al tocar la navegación.
- v0.27.1: «atrás» sin `history.back()` asíncronos al cerrar hojas (humo de Food inestable).
- v0.27.0: texto con sugerencias (`createSuggestField`, `attachSuggestions`), petición de Booking.
- v0.26.0: «atrás» dentro de la app (FB_2026_025), Revisor sobre la navegación (FB_2026_012), interruptor visible (FB_2026_004) y «Duda» (FB_2026_011).
- v0.25.4: `.field.check` blindada frente a la `.check` de Tasks (texto montado en «Me bloquea»).
- v0.25.3: `feedbackRoundTrip` con hojas abiertas y ayudantes exportados; aviso de uso tras navegar; ayuda del gesto en campos de texto.
- v0.25.2: formulario progresivo con bloqueo de doble envío, ids estables, cierre y aviso; `portalHelpRoundTrip` para Organizers y Guests.
- v0.25.1: un solo envío por composer, cierre inmediato y aviso dentro de lo visible con teclado (FB_2026_016/017 en Finance).
- v0.25.0: el composer se cierra tras su envío aunque la bandeja tenga otro atascado; prueba común `feedbackRoundTrip`.
- v0.24.0: capa global para lo flotante (`setKitLayer`) y aviso que no se estira (fallo del usuario en PC).
- v0.23.0: versiones nuevas automáticas al abrir (`initAppUpdates`), común a todas las apps.
- v0.22.0: teclado virtual en hojas y formularios, Revisor entre apps sin catálogo previo y `container` en el lanzador (QA del usuario en Android).
- v0.21.0: arreglo de la barra del Revisor sobre la hoja del lanzador (fallo del usuario), barra de portal con «Más» y lista de días (U5 de Guests).
- v0.20.0 (tanda 32): estado de guardado, recuadro de firma, «Instala la app», `nav: []` sin barra e iconos de Guests y Organizers (peticiones de los portales).
- v0.19.0 (tanda 31): capa de idiomas (es, en) para los portales: `createI18n`, `createLanguageSelect`, textos del kit con `kt()` y `KIT_EN`, formulario progresivo con textos por idioma.
- v0.18.5: `centerLabel` en el lanzador y señalar una vez en el formulario de portales (`captureFeedbackTarget`), petición C4 de Organizers.
- v0.18.4: `feedbackId` en `renderConflict(s)` (con hijos en el catálogo) y `onPrint` en `createPrintView` (petición de Food).
- v0.18.3: arreglos del piloto de Booking (FB_2026_002 pin, FB_2026_003 punto de la marca) y nodo en los pasos «abrió».
- v0.18.2: `container` en hoja, diálogo, centro y aviso; reglas de `<html>` en hoja global inyectada; `data-fb-tab`; catálogo con `fbMark` y ternarios (petición de Tasks y Finance).
- v0.18.1: pista de ruta (`route`) en `usage/batch` para «Ir al sitio» del Revisor › Uso.
- v0.18.0 (tanda 30): «Sugerencias y QA» en el panel del lanzador (`center`), `review`/`feedback` aceptan los objetos tal cual y guía de adopción compilable en `demo/adopcion.ts`.
- v0.17.0 (tanda 29): uso semántico de funcionalidades: generador del catálogo, recolector con totales diarios e IndexedDB, aviso al equipo y Revisor › Uso (pestañas «Incidencias | Uso», tarjeta con matriz y decisiones). Alineado con #223 (rutas `usage*`). Pendiente de Core: lanzar el generador en la publicación antes de `usage_catalog_ingest.py`.
- v0.16.0 (tanda 28): modo «Revisor de QA» (interruptor del dueño en el lanzador, lista lateral de todas las apps, ir al sitio con `?fb=` y tarjeta con aprobar, descartar, unir, funciona y sigue fallando) y `routeRaw` en el contexto. Pendiente de que Core publique `review=true`, `approve`, `merge` y `routeRaw` en la Edge.
- v0.15.0 (tanda 27): feedback y QA transversal, fase 2: modo «Señalar para comentar» con interruptor en el lanzador, gesto y teclado, composer, borradores con pin, bandeja sin red, contexto con pasos, «Me bloquea», pin verde de verificación, centro «Sugerencias y QA» con «Copiar para Claude» y «Descargar .md», y formulario progresivo de portales.
- v0.14.0 (tanda 25): lanzador de apps (catálogo §3.3), enganchado a la marca de `createAppShell` y `renderWorkspaceBar`.
- v0.13.0 (tanda 21): campo de color propio con tres degradados (aceptación del usuario).
- v0.12.0 (tanda 20): `renderProposalReview` y atributos de hoja en `openProposalReview`; `limitWhenEmpty` y `container` en la paleta.
- v0.11.2 (tanda 19): `bodyAttrs` y `hideTitle` en la hoja.
- v0.11.1 (tanda 18): atributos de la app en la hoja (fondo, panel, cerrar), para adoptarla en Tasks.
- v0.11.0 (tanda 16): piezas de agentes de IA (revisión con pie fijo, clave una vez, riesgo, fila de propuesta, cambios, registro, ámbitos).
- v0.10.0 (tanda 14): barra de espacio de trabajo (piezas sin estado) para la cáscara de Tasks.
- v0.9.0 (tanda 12): desglose de importes `renderMoneyBreakdown` (Booking «Coste real»).
- v0.8.1 (tanda 11): `attrs`/`pinAttrs` en la tarjeta de proyecto y dinero sin presupuesto; adopción de la tarjeta en `apps/tasks` (PR pendiente del visto bueno de Tasks).
- v0.8.0 (tanda 10): lista reordenable anidable; controles sueltos con `.compact` (petición de Food).
- v0.7.2 (tanda 9): el toast con hoja abierta va bajo la cabecera de la hoja.
- v0.7.1 (tanda 9): ids configurables en `renderLogin`; `abbr` en el calendario móvil. Revisión visual de `apps/tasks` hecha; adopción del kit en Tasks en marcha (login y shell primero), con el visto bueno de su equipo.
- v0.7.0 (tanda 8): selector de etiquetas con familias (`createLabelPicker`, `labelChips`) y tarjeta de proyecto con anillo (`renderProjectCard`, `ringSvg`).
- v0.6.1: la marca «BORRADOR» ya no desplaza la cabecera de la página imprimible.
- v0.6.0 (tanda 7): lista reordenable con arrastre, botones y teclado (`createSortableList`, `positionBetween`) y campo de fecha con atajos (`createDateField`).
- v0.5.0 (tanda 6): página completa imprimible A4 con print CSS, orientada a la vista del organizador de Food y reutilizable por Invoices.
- v0.4.1 (tanda 5): toast sobre la hoja en móvil corregido; snippet de la paleta Ctrl K en el README.
- v0.4.0 (tanda 4): hoja de importación con previsualización de JSON y cuadre de totales (para Invoices, sin tocar `apps/invoices`); revisión visual de `apps/food` y de la ficha de reserva de Booking.
- v0.3.0 (tanda 3): `compressImage` (WebP 1600 px + miniatura 480 px, con prueba), calendario mensual y semanal accesible, campo de cantidad con unidad. 28 pruebas Playwright.
- v0.2.1: separador en `.row-meta`.
- v0.2.0 fusionada en main (PR #17): hoja inferior y diálogo con foco atrapado, conflicto campo a campo sobre `PendingConflict`, rechazados sobre `RejectedBatch`, barra y banners con `rejected` y `USER_CHANGED` (sync-client 0.2), lista «pendiente» como componente, selector de tema y paleta Ctrl K. 22 pruebas Playwright.
- v0.1.0 fusionada en main (PR #4). v0.1.1 fusionada con la adopción de Invoices (PR #5).
- v0.1.0: tokens, base, componentes CSS, DOM e iconos, tema y acento, barra de estado (§6.4), login y shell, demo y pruebas Playwright (5 escenarios × 2 tamaños). Tipos en verde con el `tsconfig` raíz.

## En curso

- Adopción de `openImportSheet` por Invoices cuando su equipo lo decida (hoy tienen su propia hoja en `invoices.ts`; el kit replica su comportamiento y permite inyectar proveedor, categoría y avisos de duplicado).

## Pendiente

- Revisión visual de `apps/tasks` cuando su `ESTADO.md` diga que los escenarios portados están en verde (indicación de Core); componentes que pidan los equipos.
- Pendiente de Core: revisión visual de `apps/tasks` y adopción del kit módulo a módulo cuando su equipo termine el recorrido manual. Candidatos: calendario con horas (si Booking lo necesita).

## Bloqueos y peticiones

- Ver `docs/core/PETICIONES.md`: script `test:ui-kit` en la raíz y carpeta `tests/ui-kit` en la CI (hoy las pruebas viven en `packages/ui-kit/tests` y se lanzan con `npm -w @ikisai/ui-kit run test:e2e`). Ubicación de este `ESTADO.md` (`docs/ui-kit/` o aquí).
