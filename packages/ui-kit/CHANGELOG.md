# Cambios de @ikisai/ui-kit

## 0.22.0 · 8 de octubre de 2026

Fallos del QA del usuario en Android:
- **El teclado tapaba los campos** (todas las apps). `installKeyboardInsets()` se instala solo al crear la cáscara, una hoja o un diálogo:
  - pide `interactive-widget=resizes-content` en la meta `viewport` (Chrome Android encoge el contenido y las hojas quedan por encima del teclado);
  - como red de seguridad, publica `--kb` y `--vvh` desde `visualViewport`: hojas y diálogos se apoyan encima del teclado y caben en lo visible;
  - el campo enfocado se desplaza a la vista, centrado, cuando se abre el teclado.
- **El Revisor de QA de Central no abría reportes de Booking:** solo conocía el dominio de otra app después de abrir el lanzador. Ahora, si `appDomain` no lo da, usa la lista guardada por el lanzador en el dispositivo y, si no, `GET /apps`.
- **El lanzador en Tasks no se veía:** `createAppLauncher({ container })`. Las apps con el CSS acotado pasan su capa (`#kitLayer`); fuera de ella la hoja salía sin estilos.
- Prueba `v28` (con `@smoke`).

## 0.21.0 · 8 de octubre de 2026

- **Arreglo (fallo del usuario en Central, Android):** con el Revisor de QA activo, su barra plegada tapaba el final de la hoja del lanzador, así que el interruptor «Revisor de QA» se podía encender pero no apagar.
  - La barra del Revisor se aparta mientras hay una hoja o un diálogo abiertos; va en la hoja global, así que vale también con el CSS acotado.
  - La hoja se desplaza entera (`min-height: 0` en el cuerpo y margen para el área segura inferior).
- **Barra de portal con «Más»** (U5 de Guests): `createAppShell({ nav, more, maxNav: 5 })`.
  - En móvil, la barra lleva como mucho `maxNav` entradas contando «Más», que abre una hoja con el resto (con contadores y la ruta activa marcada).
  - En escritorio, la barra lateral las enseña todas, con el resto en su propio grupo.
  - `setNav(nav, more)` cambia las secciones en vivo (módulos que activa el organizador).
  - Sin `more` ni `maxNav` todo sigue igual.
- **Lista de días deslizable** `createDayTabs({ days, selected, today, count, onSelect, panelId })` → `{ element, get, select, setDays }`:
  - pestañas horizontales con desplazamiento suave;
  - hoy marcado y elegido por defecto;
  - flechas, Inicio y Fin; la elegida se centra;
  - contador por día y nombres con `Intl` en el idioma del kit.
- Prueba del gesto (`v18-qa`, «moverse más de 8 px cancela») estable con la máquina cargada.
- Pruebas `v27` (dos `@smoke`) y `v22` ampliada (390×844 con el Revisor activo).

## 0.20.0 · 7 de octubre de 2026

Piezas que piden los portales (Organizers y Guests); todas en español e inglés:
- **Estado de guardado** `createSaveState({ savedMs, isNetworkError })` → `{ element, field(key), set, track, status, onChange }`:
  - por campo («Guardando…», «Guardado», «Pendiente: se guardará con conexión», «No se guardó · Reintentar») y global (lo más grave);
  - `track(key, promesa, { retry })` decide solo entre guardado, pendiente (error de red o sin conexión) y error.
- **Recuadro de firma** `createSignaturePad({ label, height, color, typed, onChange, attrs })` → `{ element, canvas, isEmpty, clear, undo, toBlob }`:
  - trazo suave con dedo, lápiz o ratón, sin desplazar la página, y alta densidad;
  - «Deshacer» y «Borrar»;
  - «Escribir mi nombre» como alternativa accesible;
  - `toBlob()` da un PNG recortado a la firma con margen y fondo transparente;
  - ignora el gesto de feedback. Booking puede sustituir el suyo.
- **«Instala la app»** `createInstallPrompt({ appName, app, markIcon, snoozeDays, onOutcome, container })` → `{ canPrompt, isInstalled, shouldPromote, install, openSheet, card, onChange }`:
  - guarda `beforeinstallprompt` desde que se importa el kit;
  - si el navegador no deja instalar, explica cómo hacerlo en iPhone, Android o escritorio;
  - ofrece «Seguir en la web»; «Ahora no» se recuerda 14 días;
  - `isAppInstalled()` e `installPlatform()` exportados.
- **Cáscara con `nav: []`**: ya no pinta la barra inferior vacía.
- **Iconos `guest` y `organizer`**, que el lanzador usa para Guests y Organizers.
- Demo `#portal`; prueba `v26` (con tres pruebas `@smoke`).

## 0.19.0 · 7 de octubre de 2026

- **Idiomas (español e inglés) para los portales** (PORTALES_V2.md §8):
  - `createI18n({ app, dictionaries: { es, en }, supported, fallback, currency })` → `{ locale, setLocale, supported, t, onChange, formatDate, formatNumber, formatMoney, tag }`.
    - Toma el idioma del navegador si está entre los admitidos y recuerda el cambio manual por dispositivo (`ikisai-locale:<app>`).
    - Pone `<html lang>` y cambia también el idioma de los textos del kit.
    - `t('clave', vars)` interpola `{nombre}`, admite plurales `{ one, other }` (con `Intl.PluralRules`) y, si falta la clave, usa el idioma de reserva.
    - Fechas, números y monedas con `Intl` (`es-ES`, `en-GB`).
  - `createLanguageSelect(i18n)`: selector ES | EN.
  - **Textos del kit traducidos** con `kt('texto en español', vars)`:
    - piezas: lanzador, feedback (composer, pines, verificación, centro, formulario progresivo, captura), aviso de uso, conflictos, hoja, diálogo y barra de estado;
    - diccionario `KIT_EN` (170 textos), ampliable con `extendKitDictionary`;
    - la clave es el propio texto en español: **las apps internas no cambian nada** (sin `createI18n` todo sigue en español aunque el navegador esté en inglés).
  - `createFeedbackProgressiveForm`: preguntas, opciones, pistas, marcadores y acciones admiten textos por idioma (`{ es, en }`, tipo `LocalizedText`, función `localized`); el formulario se repinta al cambiar de idioma.
- Demo `#i18n` (se activa a mano, como haría un portal); prueba `v25`: cobertura de todas las llamadas a `kt()` en `KIT_EN`, variables conservadas, navegador en inglés, cambio manual recordado y apps internas en español. `v23` más estable en móvil.

## 0.18.5 · 7 de octubre de 2026

Petición C4 de Organizers (portales):
- `createAppLauncher({ centerLabel, centerText })`: la entrada puede llamarse «Ayuda y sugerencias» (por defecto «Sugerencias y QA»).
- **Señalar una vez** sin el interruptor: `captureFeedbackTarget({ text, fallbackNode, container })` arma el gesto solo para ese reporte, aparta las hojas abiertas, muestra «Mantén pulsado sobre el lugar… · Cancelar» y resuelve con el nodo (o `null`). Mientras tanto el gesto del modo «Señalar para comentar» no se dispara.
- Formulario progresivo: el paso `signal` usa `captureFeedbackTarget` por defecto. Lo señalado queda como respuesta (con «Cambiar»), el camino sigue a `next` y el resultado lleva `node: { id, path }`. Opciones nuevas `fallbackNode` y `container`; `onSignal` puede devolver el nodo.
- Pruebas `v18-qa` y `v22` ampliadas.

## 0.18.4 · 7 de octubre de 2026

Dos ganchos que pide Food:
- `renderConflict(s)({ feedbackId: 'food.menu.conflicto' })`: la tarjeta lleva la base y sus botones `<base>.mantener_mia`, `.tomar_servidor`, `.combinar`, `.guardar_combinacion` y `.volver` (con etiqueta), también al repintar con «Combinar campo a campo». `CONFLICT_MARKS` exportado. El catálogo (`feature-catalog.mjs`) añade esos hijos cuando ve la base literal dentro de `renderConflict(s)`.
- `createPrintView({ onPrint })`: se llama al pulsar «Imprimir» (o con `print()`) antes del diálogo, para `usage.track('…imprimir')` sin escuchar el DOM.
- Prueba `v24`.

## 0.18.3 · 7 de octubre de 2026

Primeros reportes reales del piloto de Booking en Android (build 251):
- **FB_2026_002 · pin que no aparece.**
  - Nuevo pin **«tus sugerencias aquí»** (`GET feedback?status=open&mine=true`): el elemento queda marcado tras enviar; al tocarlo se abre el composer con «Ya hay N reportes abiertos aquí».
  - El pin va al primer elemento **visible** con ese `data-feedback-id` (con una copia oculta del mismo id no se pintaba).
  - Solo se aplica el último repintado (una lectura lenta de IndexedDB ya no pisa a la nueva).
  - Se repinta al navegar (`popstate`, `hashchange`) y al volver a la pestaña.
  - Los pines de un mismo elemento (borrador, tuyos, «¿Ya va?») van uno al lado del otro.
- **FB_2026_003 · punto amarillo sin explicar.**
  - Al activar el modo sale un aviso que explica el punto.
  - En el lanzador, el interruptor dice «Señalar para comentar · activo» con su explicación.
  - La marca (`#appLauncher`) lleva `title` y `aria-label` con los modos activos.
  - Lo mismo para el revisor, cuyo punto pasa a verde.
- Los pasos «abrió» llevan el nodo de la pantalla (`fallbackNode`) cuando la app no la marca.
- Prueba `v23`.

## 0.18.2 · 7 de octubre de 2026

Ajustes que piden Tasks y Finance al adoptar (apps con el CSS del kit acotado a `.ikisai-kit`):
- **`container`** en `openSheet`, `confirmDialog`, `openFeedbackCenter`, `showUsageNotice` y `createUsage` (para el aviso), como ya tenían `createFeedback` y `createFeedbackReview`. Los diálogos que abre la tarjeta del revisor van a su contenedor.
- **Reglas sobre `html.fb-pressing`, `html.fb-mode` y `html.fb-reviewing`** fuera de `components.css`: el kit las inyecta una vez en `<style id="ikisai-kit-feedback-global">` (`src/feedback/global-style.ts`) al crear el feedback, el gesto o el revisor, así que sobreviven al acotado. Colores con valor de reserva.
- **Pestañas del centro y del revisor con `data-fb-tab`** en lugar de `data-tab` (chocaban con apps que enganchan `[data-tab]`).
- **Catálogo:** `feature-catalog.mjs` reconoce también `fbMark(nodo, 'id', 'etiqueta')` (aunque el nodo ocupe varias líneas) y los ternarios entre dos ids fijos (`feedbackId: x ? 'a.b' : 'a.c'`, con sus etiquetas). Booking pasa de 263 a 296 funciones.

## 0.18.1 · 7 de octubre de 2026

- `createUsage`: cada elemento de `POST usage/batch` lleva `route`, la ruta real (sin consulta) donde la función se vio o usó por última vez. Core la guarda como pista (#238) y la devuelve en la tarjeta como `routeRaw`, así «Ir al sitio» de «Revisor › Uso» abre la pantalla exacta. El servidor anterior la ignora.

## 0.18.0 · 7 de octubre de 2026

- `createAppLauncher({ center })`: entrada **«Sugerencias y QA»** en el panel del lanzador, encima de los interruptores. Cierra el lanzador y llama a `center()` (normalmente `openFeedbackCenter(...)`). Las apps ya no necesitan botón propio en la cabecera, que a 390 px no cabía (nota de Booking).
- `createAppLauncher({ feedback, review })` acepta los objetos de `createFeedback(...)` y `createFeedbackReview(...)` tal cual (o sus `mode`, o `{ get, set, available }` como hasta ahora). Tipo `LauncherMode`.
- **Guía de adopción que compila**: `packages/ui-kit/demo/adopcion.ts` monta feedback, revisor, uso, lanzador y shell sobre un `SyncClient` real; `tsc` del kit la comprueba, así que no puede quedarse atrás de las firmas.
- Prueba `v22`.

## 0.17.0 · 7 de octubre de 2026

- **Uso semántico de funcionalidades** (coordinacion/ampliacion/USO.md; rutas de Core #223, contrato §3.8).
  - **Catálogo al compilar:** `node packages/ui-kit/scripts/feature-catalog.mjs --app <app> [--release v…] [--commit …]` recorre `apps/<app>/src`, `public` (sin `sw.js`) e `index.html` y escribe `apps/<app>/dist/feature-catalog.json` `{ app, release, commit, generatedAt, features: [{ id, label, kind, parent }], dynamic }`. Saca cada `data-feedback-id` (con `data-feedback-label` y el tipo: botón, enlace, pestaña, campo, sección…) y cada `usage.run('…')`/`usage.track('…')` (tipo `operation`). Los ids construidos en ejecución van en `dynamic` con archivo y línea. Sin dependencias.
  - **Recolector** `createUsage({ app, api, userId, context, generation, flushEveryMs, notice })` → `{ run, track, activate, flush, today, clear, destroy }`:
    - exposición con `IntersectionObserver` (≥ 50 % durante 1 s, una por función y sesión; nada oculto ni dentro de un `<details>` o menú cerrado);
    - activación automática por clic o teclado en controles marcados (no en `data-feedback-ignore` ni en la capa del feedback; la pulsación larga no cuenta); repetir antes de 2 s es un intento repetido;
    - `usage.run(id, fn)` para éxito y error;
    - contexto `production | qa | reviewer` desde los interruptores del kit (el revisor manda);
    - totales acumulados del día por dispositivo (uuid por instalación) en IndexedDB, enviados a `POST usage/batch` al volver la red, al pasar a segundo plano, al salir y cada 3 minutos. Nunca bloquea. Solo ids de la propia app. `clear(userId)` al cerrar sesión.
  - **Aviso al equipo** `showUsageNotice({ api, userId })`: la primera vez, hoja «Ikisai mide qué funciones se usan para mejorar las herramientas. Lo ve solo Víctor; no se usa para evaluar a nadie» con «Entendido» → `POST usage/consent`. No pisa una hoja abierta. `createUsage` lo muestra salvo `notice: false` (portales).
  - **Revisor › Uso:** la lista lateral del revisor pasa a tener dos pestañas, «Incidencias | Uso» (recordada en el dispositivo). `review.ts` queda como armazón y se divide en `review-feedback.ts` y `review-usage.ts`.
    - Uso: funciones de todas las apps (`GET usage/review?app=all`) agrupadas por *insight* (`HIGH_ERROR`, `TARGET_NOT_ADOPTING`, `IGNORED`…), lo más grave arriba.
    - «Ir al sitio» con la misma navegación (`?fbf=<función>&qa=1` en otra app). Si la función no está a la vista, se ancla a su sección y se ilumina sola cuando aparece.
    - Tarjeta (`GET usage/features/:id`): estado, últimos 30 días (audiencia frente a otros, QA), matriz por equipo y por persona, uso sin persona, generación, último uso e incidencias. Acciones: audiencia (equipos y personas), frecuencia esperada, mantener o revisar más tarde con fecha, no evaluar, nueva generación y «Revisar utilidad» (crea un reporte de feedback normal con el texto generado).
    - En móvil la tarjeta se puede minimizar para llegar a la función; un diálogo abierto desde ella va por encima.
- Demo `#feedback` con rutas simuladas de `usage/*`; pruebas `v20` (recolector, aviso y catálogo) y `v21` (Revisor › Uso).

## 0.16.0 · 7 de octubre de 2026

- **Modo «Revisor de QA»** (FEEDBACK.md §9), solo para el dueño del ecosistema: `createFeedbackReview({ api, app, appDomain, navigate, openUrl, waitMs, container })` → `{ mode, available, refresh, goTo, show, destroy }`.
  - Segundo interruptor al pie del lanzador (`createAppLauncher({ review })`), debajo de «Señalar para comentar» (que ahora lleva la clase `.launcher-signal`). Solo aparece si `GET feedback?review=true` responde (403 para cualquier otra cuenta); se pregunta al abrir el lanzador. `html.fb-reviewing` marca la cabecera.
  - **Lista lateral** de todas las apps (`GET feedback?review=true&app=all`): «Por revisar» (`reviewStatus = 'new'`) y «Por comprobar» (`display = 'pending_verify'`), con app, código, primera línea, «Me bloquea» y apoyos. Plegable; en móvil va abajo y se aparta mientras hay tarjeta.
  - **Ir al sitio**: en esta app navega a `report.routeRaw` sin recargar (hash o `pushState`), espera al `[data-feedback-id]` (6 s como mucho; si no aparece, la sección o la pantalla más cercana, con aviso), lo ilumina (`.fb-spot`) y ancla la tarjeta. En otra app abre `https://<dominio>/?fb=<código>&qa=1`; al arrancar con `?fb=` el kit enciende el modo, enseña el reporte y limpia la URL.
  - **Tarjeta del revisor**: comentario, imágenes, últimos pasos y, según el caso, «Aprobar para arreglar» (`approve`), «Descartar» con motivo, «Unir a…» (`merge { into }`), o «Funciona» y «Sigue fallando». «Siguiente» sigue la cola (primero por revisar, luego por comprobar).
- Contexto: `routeRaw` (ruta real con el hash de la app, sin consultas) además de la saneada; `rawRoute()` exportada. `FeedbackReport` gana `reviewStatus` y `routeRaw`.
- Demo `#feedback`: «Ejemplos del revisor» y servidor simulado con `review=true`, `approve` y `merge`. Prueba `v19`.

## 0.15.0 · 7 de octubre de 2026

- **Feedback y QA transversal, fase 2** (`coordinacion/ampliacion/FEEDBACK.md` §2, §6–§8; rutas de Core #212, contrato §3.7). Todo en `src/feedback/`, sin dominio de ninguna app.
  - `createFeedback({ app, api, userId, role, syncSummary, fallbackNode, intents, container, fetchImpl, onSent })` → `{ mode, signal, open, openDraft, drafts, pending, flush, refreshVerify, clear, refreshPins, destroy }`.
  - **Modo «Señalar para comentar»** (`mode.get/set/onChange`), por persona, app y dispositivo, **apagado por defecto**. Apagado: ni gesto ni pines, la app se comporta como siempre. Encendido: pulsación mantenida de 600 ms (tolerancia de 8 px; suprime selección, menú y arrastre nativos desde `pointerdown` y anula el clic de después), Mayúsculas+F10 o la tecla de menú; pines de borrador; `html.fb-mode` pone un punto discreto en la marca de la cabecera. Ignora `[data-feedback-ignore]`, asas de arrastre y campos editables.
  - `createAppLauncher({ feedback })`: interruptor al pie del lanzador (normalmente `feedback.mode`).
  - **Composer** en capa propia (popover en escritorio, hoja inferior en móvil que sigue a `visualViewport`): tipo, comentario (4000), hasta 3 imágenes comprimidas, «Me bloquea» (`blocking`), aviso «Ya hay N reportes abiertos aquí» con «También me pasa». Vacío se descarta; con contenido queda borrador en IndexedDB con pin.
  - **Bandeja sin red** idempotente (mismo `id` y `requestId` en cada intento; subida firmada con `sha256`; reintentos con espera creciente y al volver la red). Un rechazo definitivo vuelve a borrador con el motivo. `clear(userId)` para `onSessionEnd`.
  - **Contexto con lista blanca** con los nombres de `cleanContext` de la Edge: `release`, `commit`, ruta saneada (sin `#`), dispositivo, viewport, en línea, rol, idioma, `sync` (`pending`, `conflicts`, `lastSyncAt`, `cursor`), `errors`, `http` y los **últimos 10 pasos** (`abrió` ruta / `tocó` nodo, nunca valores). Como mucho 8 KB.
  - **Pin verde** «Esto ya está corregido. ¿Lo compruebas?» (`GET feedback?status=pending_verify&pin=true`) con «Funciona» (`verify` con la versión de `version.json`) y «Sigue fallando» (`reopen` con nota opcional).
  - **«Sugerencias y QA»**: `openFeedbackCenter` / `renderFeedbackCenter({ api, app, canEdit, feedback, tab, reportId })` con Mapa (árbol plegado de `GET feedback/tree`, recuentos y búsqueda), Abiertos, Pendientes de verificar y Mis borradores; `feedbackReportCard`; detalle con imágenes, tareas, **«Copiar para Claude»** y **«Descargar .md»** (`agentBlock`), y verificar, reabrir y descartar con motivo.
  - **Formulario progresivo** para portales: `createFeedbackProgressiveForm({ config: { start, steps }, known, onSubmit, onSignal })`. Pasos `choice` (con ramas por opción), `text` (con imágenes) y `signal`; una pregunta cada vez, cambiar una respuesta borra las de después, `known` no se pregunta y `suggest` ofrece primero lo probable («¿Es sobre Habitación 3?»).
  - Demo `#feedback` con servidor simulado; pruebas `v18` (composer, borradores, bandeja, contexto) y `v18-qa` (modo, gesto, pin verde, pasos, «Me bloquea», centro, formulario progresivo).

## 0.14.0 · 7 de octubre de 2026

- **Lanzador de apps** `createAppLauncher({ fetchApps, current, storageKey, appIcon, title })` → `{ open, attach(trigger) }` (contrato §3.3). Hoja con las apps de `GET /api/v1/apps`, en el orden del catálogo: internas arriba y portales debajo con su título. Muestra icono, nombre, descripción y el rol si no es propietaria; la actual va marcada «Aquí» y no es enlace; las demás enlazan a `https://<domain>/` en la misma pestaña. Sin red, enseña la última lista guardada en el dispositivo, con aviso. Iconos del kit por id de app (se ven sin red) o los de la app con `appIcon`.
- `createAppShell({ launcher })` y `renderWorkspaceBar({ markButton })`: la marca de la cabecera pasa a ser un botón (`#appLauncher`) que abre el lanzador.
- Demo: el registro de accesos usa horas fijas de hoy y ayer, para que la prueba no dependa de la hora del día.

## 0.13.0 · 6 de octubre de 2026

- **Campo de color** `createColorField({ label, value, suggestions, allowNone, openCustom, onChange, attrs })` → `{ element, get, set }`: sugerencias, «Sin color» y «Personalizado», que despliega en línea tres degradados (matiz, saturación y brillo) **colocados ya sobre el color actual**, con vista previa y código hexadecimal. Sustituye al `input type=color` nativo, que en Android abre con los deslizadores a cero (prueba de aceptación del usuario, imagen 8). También exportado como `createColorPicker` (el nombre que pidió Tasks). Utilidades `hexToHsv`, `hsvToHex`, `normalizeHex`. Demo `#color`, prueba `v16`.

## 0.12.0 · 6 de octubre de 2026

- `renderProposalReview(options)` → `{ body, foot }`: la revisión de propuestas sin hoja, para una app que ya tiene la suya (Tasks). El pie lleva `.proposalreview-foot`, pegado abajo dentro de un contenedor que desplaza, y es `null` si la propuesta no está pendiente o no se puede decidir. `openProposalReview` acepta `sheet` con las opciones de `openSheet` (`backAttrs`, `panelAttrs`, `bodyAttrs`, `closeAttrs`, `hideTitle`, `onClose`). Petición de Tasks.
- Paleta: un solo resaltado (la fila seleccionada, que sigue al ratón y al teclado; sin `:hover`), como la paleta de Tasks.
- Paleta: el kit trae por fin su CSS completo (fondo, panel, campo, grupos, elementos, pie y tema oscuro); hasta ahora dependía de las reglas de Tasks.
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
