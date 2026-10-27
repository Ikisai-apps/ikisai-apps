# Cambios de @ikisai/ui-kit

## 0.69.10 · 27 de octubre de 2026

**K13: iconos de comida en el kit** (`equipo/Revisor/KIT_PETICIONES.md`). Son 19 iconos de trazo, con el estilo de siempre (24 × 24, trazo 1,9). Salen del prototipo de Food (Recetario y Menús, elegidos por VG); el pescado es nuevo.

- **Momentos:** `cup` (desayuno), `bowl` (entrante), `plate` (principal), `leaf` (guarnición), `cake` (postre), `basket` (picnic), `cookie` (merienda), `glass` (bebida), `jar` (base o se puede adelantar).
- **Colecciones:** `timer` (rápidas), `pot` (para muchos).
- **«Sin»:** `noGluten`, `noLactose`, `noNuts`.
- **Tipos de menú:** `vegan`, `cheese` (vegetariano), `drumstick` (mixto), `chefHat` (otro), `fish` (pescetariano).
- Food ya no tiene que registrarlos con `registerIcons`; Booking y Guests pueden usarlos para el régimen de comidas.
- Lámina para revisarlos: `MUELA/equipo/feedback/ui-kit/K13_iconos_comida.png`. Pruebas: `tests/v82.spec.ts`.

## 0.69.5 · 27 de octubre de 2026

**`testing/mobile-audit.ts`: la revisión móvil en las pruebas de cada app.** Es la herramienta de la revisión a 390 px del 27-10, ahora como ayuda común, igual que `testing/feedback-smoke.ts`. No toca nada: mide la pantalla que se ve.

- `mobileAudit(page, { kinds?, ignore?, minTarget? })` devuelve una lista de hallazgos `{ kind, sel, text, detail }`. Tipos:
  - `desborde` (fuera de los contenedores con scroll propio);
  - `toque` (menos de 44 px; las casillas cuentan con su etiqueta, y los enlaces dentro de un párrafo no cuentan);
  - `cortado`;
  - `contraste`: WCAG AA en oscuro; cambia a oscuro y vuelve a claro.
- `formatFindings(found)` da una línea por hallazgo para el mensaje de `expect`.
- Ya trae los arreglos de la revisión:
  - el desborde se mide contra el ancho de la pantalla (`screen.width`): con emulación de móvil, Chrome aleja la página que desborda y agranda `innerWidth`, y antes no se veía;
  - colores `color(srgb …)` leídos bien;
  - lo escondido para el lector (`.vh`, cajas de 1 px) no cuenta como cortado ni como toque.
- Uso: `expect(await mobileAudit(page, { kinds: ['desborde', 'toque'] }), …).toEqual([])` en el humo de la app.
- Pruebas: `tests/v77.spec.ts`.

## 0.69.6 · 27 de octubre de 2026

**K24: «Sincronizado» del menú común a 44 px con el dedo** (`equipo/Revisor/KIT_PETICIONES.md`, abierta por Core el 27-10).

- `.appmenu-sync` (la línea de sincronización bajo el perfil) medía 24 px de alto. En pantallas táctiles pasa a 44 px, igual que el resto de 0.69.2. Con ratón no cambia.
- El conmutador «Señalar para comentar» del lanzador ya cumplía: es un interruptor dentro de una etiqueta entera, y se toca la etiqueta.
- Pruebas: `tests/v78.spec.ts`.

## 0.69.4 · 27 de octubre de 2026

**La cáscara se aprieta sola en el móvil** (revisión a 390 px, `MUELA/equipo/feedback/ui-kit/REVISION_MOVIL_27-10.md`).

- **Título:** si «Ikisai {app}» no cabe junto a las herramientas, «Ikisai» se esconde a la vista, no al lector, y queda el nombre de la app. Guests («Ikisai Guests · Ana») se cortaba; en Organizers ayuda, aunque su conmutador ES/EN sigue comiendo ancho.
- **Barra de abajo:** `NavItem.short` es el nombre corto («Cobro» por «Pedido y cobro»).
  - Solo se usa si los nombres enteros no caben, como en las seis secciones de Flow a 390 px.
  - El lector sigue diciendo el nombre entero.
  - Sin `short`, la barra se queda como estaba.
- Lo mide la propia cáscara al pintar y cuando cambia el ancho (`ResizeObserver`). El texto del título no cambia.
- Pruebas: `tests/v76.spec.ts`.

## 0.69.2 · 27 de octubre de 2026

**Con el dedo, nada por debajo de 44 px.** Sale de la revisión móvil a 390 px (`MUELA/equipo/feedback/ui-kit/REVISION_MOVIL_27-10.md`). Lo que más se repetía en las apps eran controles de 36 px.

- En pantallas táctiles (`@media (pointer: coarse)`), `--tap-sm` pasa de 36 a 44 px. Eso sube `.small`, `.iconbtn.small` y los controles `.compact` (p. ej. los `select` de filtros). Con ratón, nada cambia.
- `.tabpill`, `.linkbtn`, `.pl-tabs button` y `.space-quick-chip` pasan a 44 px de alto, y `.tabtool` a 44 × 44 px, en pantallas táctiles.
- «¿Sin red?» del inicio de sesión (`.login summary`, en todas las apps) pasa de 28 a 44 px de alto en pantallas táctiles.
- Arregla sin tocar las apps los toques señalados en Booking (calendario), Central (Inicio, Cumplimiento, Inventario), Finance (Facturas, Compras) y Food (filtros del Recetario).

## 0.69.1 · 27 de octubre de 2026

**«Trabajos de hoy» compuesto en la muestra** (encargo de Core): una pantalla de Flow hecha solo con piezas del kit. Es la referencia del cableado que hará Flow, con la receta en `MUELA/equipo/feedback/flow/PIEZAS_GENERICAS.md`.

- **Carriles:** `createLanes` agrupados por persona, oficio o espacio con `groupLanes`.
- **Contenido de cada carril:** un `createProjection` del Plan de hoy de Tasks (`tasks.review_projection`) con «Hecha» (`tasks.complete`) como acción.
- **Guiado:** el título de cada tarjeta abre la tarea en Tasks con el Guiado (`withGuideLink`, `?guia=`) y «Volver a Trabajos de hoy».
- **Cliente:** es de mentira; las capacidades de Tasks están pendientes.
- Sin cambios en la API del kit. Pruebas: `tests/v74.spec.ts`, a 390 px y en escritorio.

## 0.69.0 · 27 de octubre de 2026

**Proyección** (`createProjection`, `src/pieces/projection.ts`; encargo de Core, diseño en `MUELA/equipo/feedback/flow/PIEZAS_GENERICAS.md`). Es un carril que pinta las filas leídas de otra app y tiene una acción por fila que invoca una capacidad del catálogo. Con ella, «Trabajos de hoy», «Recepción» o «Avance por aplicaciones» son composiciones. No copia datos.

- **Lectura:** `read` es una capacidad invocada con el cliente de la app y el token de la persona, y `rows(result)` la convierte en filas `{ id, title, meta, chip, href, data }`.
  - Se vuelve a leer cada `refreshMs`, al volver a la pestaña, al recuperar la red y tras cada acción.
  - Las filas se validan (ids, títulos) y los enlaces solo pueden ser internos o de `*.ikisai.com`.
- **Acción por fila** (`action: { label, capability, input, when?, confirm? }`):
  - es idempotente (`requestId` estable por fila y acción) y dice «Haciendo…» mientras dura;
  - **no se marca como hecha en local**: se vuelve a leer y manda la app dueña;
  - los errores se dicen en palabras («Tu cuenta no puede hacer esto en Booking», «Booking no responde ahora mismo»);
  - `confirm` pregunta antes.
- **Sin red:** la última lectura, con «Sin conexión: puede no estar al día» y sin acciones.
- `onCount(n)` es para el recuento del carril (`createLanes` / `groupLanes`).
- Demo: «Proyección (Recepción, leyendo de Booking)». Pruebas: `tests/v73.spec.ts`.

## 0.68.0 · 27 de octubre de 2026

**Guiado, tanda 3: el shell monta la guía leyendo la ejecución de Flow.** Contrato aprobado por Core el 27-10; la parte de Flow está pendiente.

- `createAppShell({ guide: { client, app, feedbackId } })`: con eso, cada app monta el Guiado en una línea.
  - Con `?guia=<ejecución>`, monta la guía completa (`createGuide`) con los pasos de esa app.
  - Con `?campo=…`, el nivel mínimo (0.66).
  - `guide: true` sigue siendo solo el nivel mínimo.
- `flowGuideSource(client, { app })` (`src/guide/flow-source.ts`) usa dos capacidades del catálogo del núcleo, invocadas con la Edge de la app y el token de la persona (`POST capabilities/<id>/invoke`):
  - `flow.guide_read {execution_id, app}` → la ejecución con sus pasos (`done` lo calcula Flow);
  - `flow.guide_confirm {requestId, execution_id, step_id, how, pending}`, idempotente por `requestId` y **sin valores de campo**: `save` sale del aviso de guardado de `createSaveState`, nunca de leer el campo.
- Lo que llega de Flow se valida (`sanitizeGuideRun`, `safeRoute`):
  - anclajes con el formato del inventario;
  - rutas solo internas (`#/…` o `/…`);
  - textos acotados e ids sin repetir.
  - Si Flow no responde, la guía lo dice, con «Reintentar» y «Volver a Flow».
- Demo: la línea del shell en la sección del Guiado. Pruebas: `tests/v72.spec.ts`, con un cliente falso.

## 0.67.0 · 27 de octubre de 2026

**Guiado, tanda 2: `createGuide`** (`src/guide/guide.ts`), la guía completa dentro de la app real. No bloquea nada: se puede trabajar libremente y volver a la guía.

- **Foco y burbuja:**
  - un anillo sigue al anclaje del paso y el resto de la pantalla se oscurece un poco, sin capturar toques;
  - la burbuja va abajo en el móvil y a la derecha en el ordenador, con «Paso 2 de 5», la barra, el título y la explicación;
  - el campo sube bajo la cabecera, así que lo que le sigue («Guardar») queda a la vista.
- **Avanza solo con la confirmación real:**
  - `confirm: 'save' | 'event'` espera el aviso de guardado de ese campo (0.66, sin valores);
  - `manual` pide «Hecho»;
  - `none` informa y tiene «Siguiente».
  - Cada confirmación llama a `onConfirmed(step, { how, pending })`, para que quien guía la registre.
- **Lo pendiente se recalcula:**
  - `load()` devuelve los pasos con `done` y se vuelve a llamar al volver a la pestaña, al desplegar la guía y con `refresh()`;
  - lo hecho fuera de la guía no se repregunta;
  - «Anterior» vuelve a un paso ya hecho para cambiarlo.
- **Escondido o en otra pantalla:** pide a la app que lo enseñe (`registerReveal`). Si no está, lo dice y ofrece «Ir allí» con la `route` del paso.
- **Otros controles:**
  - «Saltar» en los pasos no esenciales;
  - «Ocultar» la deja en una píldora («Guía · paso 2 de 5»);
  - «Volver a…» usa la convención K9;
  - en `mode: 'learn'` sale la etiqueta «Practicando».
- Demo: «Guía completa» en la sección del Guiado. Pruebas: `tests/v71.spec.ts`.

## 0.66.0 · 27 de octubre de 2026

**Guiado, tanda 1: anclajes semánticos y campo señalado.** Es el nivel mínimo y el primer paso del Guiado completo que decidió VG el 27-10; diseño en `MUELA/equipo/feedback/flow/GUIADO.md`.

- **Anclajes** (`src/guide/anchors.ts`): un anclaje es un id del inventario (`data-field-id` o `data-feedback-id`), nunca un selector.
  - `findAnchor(id)` devuelve el nodo, solo si se ve: un `<details>` cerrado o `display: none` no cuentan.
  - `registerReveal(prefijo, fn)`: la app enseña lo escondido (abrir una hoja, cambiar de pestaña).
  - `revealAnchor(id)` pide que se enseñe y espera a que aparezca; si no aparece, devuelve `null`.
  - `pointAt(nodo)` lo trae a la vista, le da el foco y lo resalta.
- **Confirmación de guardado, sin valores:**
  - `FieldSpec` gana `confirm` (`'save' | 'event' | 'none'`) y `validator` (un nombre, no código). Van a `data-field-confirm`/`-validator` y al catálogo; solo aparecen si se declaran, así que los catálogos de siempre no cambian.
  - `createSaveState` avisa solo cuando la clave es un id de campo (`confirm: 'save'`). Para el resto está `announceSaved(id)`. Se escucha con `onSaved(fn)`.
  - El aviso lleva solo el id y si quedó en cola sin red.
- **Enlace** (`src/guide/link.ts`): `withGuideLink(url, { field, step, run, from, title })` es la convención de «Volver a…» más `campo`, `paso` y `guia`. `readGuideLink()` lo lee al llegar, lo guarda en la pestaña y limpia la URL.
- **Shell:** `createAppShell({ guide: true })` monta el Guiado en una línea e implica `returnTo`.
  - Al llegar con `?campo=…&paso=…`, una línea arriba explica el paso y el campo queda señalado.
  - Hay «Ver el campo» y «Cerrar». Si no encuentra el campo, lo dice.
  - El texto del paso se pinta como texto, nunca como HTML.
- Clases con el prefijo nuevo `guia-` (`guide-` ya lo usa una app). Demo: «Guiado: campo señalado». Pruebas: `tests/v70.spec.ts`.

## 0.65.0 · 27 de octubre de 2026

**Carriles por cualquier clave** (traspaso de Flow v03, §12; diseño en `MUELA/equipo/feedback/flow/GUIADO.md`). `groupLanes(items, { key, title?, order?, hideEmpty?, noneTitle?, emptyText?, card | mount })` (`src/pieces/lanes-group.ts`) devuelve los `lanes` de `createLanes` agrupados por persona, agente, fase, espacio u objetivo. `createLanes` no cambia.

- La clave es el id del carril, así que al cambiar de agrupación con `setLanes` se conserva el carril elegido si sigue existiendo.
- Orden:
  - `order` fija carriles en ese orden, aunque estén vacíos (`hideEmpty` los quita);
  - los demás van detrás, ordenados por título;
  - lo que no tiene clave va al final, en «Sin asignar» (`LANE_NONE`).
- Dentro de cada carril, una `card(item)` por elemento, o `mount(body, items, key)` para montarlo a mano. Un carril vacío dice «Nada aquí» y en «Lado a lado» se pliega.
- Demo: «Carriles por cualquier clave», con «Agrupar por» persona, fase o espacio. Pruebas: `tests/v69.spec.ts`.

## 0.64.0 · 27 de octubre de 2026

**Piezas genéricas para el catálogo de Flow** (encargo de Core; cómo las monta Flow en `MUELA/equipo/feedback/flow/PIEZAS_GENERICAS.md`). Ninguna guarda nada por su cuenta: solo registran a través de la app.

- **Formulario libre** (`createFreeForm`, `src/pieces/free-form.ts`): las preguntas salen de un esquema JSON y se contestan una a una sobre `createStepForm`.
  - Tipos: texto (o `multiline`), número (con coma o punto, `min`, `max`, `unit`), sí/no, opción y foto.
  - Las opcionales llevan «Saltar» y responden `null`; las obligatorias no avanzan vacías.
  - Al final, una revisión con «Cambiar» en cada respuesta y «Registrar». `onSubmit(answers)` recibe `{ id: texto | número | booleano | valor | ref de foto | null }`.
  - Foto: el kit la recomprime y `onPhoto(blob)` la sube y devuelve su referencia.
  - `value` retoma un borrador y no repregunta lo contestado. `freeFormProblems(schema)` valida el esquema.
- **Lista de comprobación** (`createChecklist`, `src/pieces/checklist.ts`): ítems con casilla, la etiqueta «Obligatoria» u «Opcional» y «Hecho por Ana · 10:42».
  - Arriba, «3 de 5 hechas · faltan 2 obligatorias» con su barra.
  - `onToggle(id, checked, { by, at })`: si falla, la marca vuelve atrás y lo dice.
  - `summary()` y `checklistSummary()` devuelven `{ done, total, requiredDone, requiredTotal, complete }`; `onComplete` avisa al completar las obligatorias. También tiene `readOnly`.
- `createStepForm`:
  - `kind: 'custom'` con `render(ctx)`, para un control propio;
  - `skip: true`, que añade «Saltar»;
  - `multiline` e `inputAttrs` en las preguntas de texto.
  - Sin estas opciones funciona como antes. La marca `saltar` solo se cataloga si la llamada usa `skip`.
- Marcas nuevas en el catálogo:
  - `createFreeForm`: `preguntas`, `foto`, `cambiar`, `registrar` y `nuevo`;
  - `createChecklist`: `item`.
- Demo: sección «Piezas genéricas». Pruebas: `tests/v68.spec.ts`.

## 0.63.0 · 27 de octubre de 2026

**Decoración y finca en `createSpaceMap`** (encargo de VG del 27-10, `MUELA/equipo/feedback/recursos/DECORACION_Y_FINCA.md`). Las formas de los datos se han acordado con Guests (Recursos), Central («Colocar» → Decoración) y Core (el SVG de la finca). Sin las opciones nuevas, el mapa se comporta como antes.

- **Retícula** (`src/spaces/decor.ts`): `FloorPlan.grid = { metersPerUnit, originX, originY }` y escalas de 5 m, 1 m y 0,5 m.
  - `grid: 5 | 1 | 0.5` dibuja la retícula fina. Se quita sola si las celdas salen de menos de 5 px.
  - Funciones exportadas: `cellSize`, `cellToRel`, `relToCell` y `decorBox`.
- **Decoración**: `decor: [{ id, planId, iconId, iconUrl, cellX, cellY, scale, size: 1 | 4, rotation, label }]` va en una capa encima de las estancias.
  - Se pinta como `<image>`, así que nunca se ejecuta, y `safeIconUrl` descarta lo que no es una imagen.
  - Sin `decorEdit` solo se ve: sin eventos y `aria-hidden`.
  - `showDecor: false` la quita en esa vista (p. ej. al ordenar camas).
- **Colocar decoración** (`decorEdit: { icons, onDecorChange, scale }`, Central en el ordenador):
  - una barra con icono, tamaño (1 o 4 celdas) y escala;
  - tocar el plano pone el objeto, que se arrastra saltando de celda en celda;
  - con el objeto elegido: flechas = 1 celda, R o «Girar 90°», y Supr o «Quitar»;
  - cada cambio avisa con `onDecorChange({ type: 'add' | 'move' | 'rotate' | 'remove', item })`, y `setDecor(items)` repinta con lo del servidor.
- **Camas con icono** (`bedIcons: true`): cada cama lleva el símbolo de su `attributes.bed_kind` (individual, doble, litera, sofá cama).
  - El icono va encima del color, el estado y el rayado, que no cambian.
  - Si la cama es apaisada, el icono se gira.
- **Alturas y cotas de la finca**:
  - `FloorPlan.bands` (u opción `bands`) dibuja las líneas y el nombre de cada altura.
  - `FloorPlan.contours = [{ label, elevationM, x, y }]` (u opción `contours`) pone la etiqueta «Altura 3 · 10 m» y «↑ +6 m» hasta la siguiente.
  - Todo va también en el nombre accesible del plano.
- **De la finca a la habitación** (`drill: true`):
  - tocar una forma con dibujos propios entra en su plano (`onEnterBuilding(building, plan)`);
  - tocar una habitación con cosas dentro la amplía;
  - la miga («Finca › Albergue · Planta baja › Hab 1») vuelve a cualquier nivel, y «‹ Volver» o Escape suben uno;
  - opción `plan` (el dibujo con el que empieza) y métodos `setPlan(planId)` y `path()`;
  - sin zoom libre, como decidió VG: se cambia de dibujo.
- Repintar ya no pierde el foco: lo devuelve al mismo control, también cuando el plano cambia de ancho.
- Marcas nuevas: `miga`, `volver`, `deco-icono`, `deco-tamano`, `deco-escala`, `deco-objeto`, `deco-girar` y `deco-quitar`; el catálogo las conoce.
- Pruebas: `tests/v67.spec.ts`.

## 0.62.0 · 27 de octubre de 2026

**Dos peticiones de Tasks** (K4 y K5 de `docs/tasks/PETICIONES.md`, decisiones de VG del 27-10). Sin las opciones nuevas, el selector se comporta como antes.

1. **K5 · Buscar por palabras** (FB_2026_070). `searchItems`, y con él el buscador de `createItemPicker` y el de `createItemCatalog`, encuentra cada palabra en cualquier orden, sin tildes ni mayúsculas: «multicapa 20» da «Tubo multicapa 20 mm».
   - Orden de los resultados:
     1. el nombre empieza por lo escrito;
     2. el nombre contiene la frase;
     3. todas las palabras aparecen al principio de palabras del nombre;
     4. todas las palabras aparecen dentro del nombre;
     5. lo mismo en los alias;
     6. las palabras repartidas entre nombre y alias.
   - Con una sola palabra, el orden es el de siempre.
   - **Completar con nombres que ya existen:** si el primer artículo empieza por lo escrito, bajo el campo sale «→ completa «Tubo multicapa 20 mm»». Se acepta con → al final del texto o tocando la línea.
2. **K4 · Sugeridos en el selector** (FB_2026_056, «solo ordenar el selector»). `createItemPicker({ suggested: [ids], suggestedLabel: 'Del kit del oficio' })`:
   - al buscar, los sugeridos que coinciden van primero y llevan la marca;
   - con el campo vacío, al entrar en él, se ofrecen ellos solos.
   - `searchItems(…, { boost: [ids] })` hace lo mismo para cualquier lista.
- Marca de feedback nueva: `<base>.completar`. Pruebas: `tests/v66.spec.ts`.

## 0.61.0 · 27 de octubre de 2026

**`createLanes`: carriles con dos vistas que se intercambian** (encargo de VG del 27-10 para Flow v2; vale para cualquier app con columnas). La API está acordada con Flow.
- **Firma**: `createLanes({ label, lanes: [{ id, title, short?, count?, empty?, mount(body) }], view?, storageKey?, wideFrom?, selected?, onSelect?, onView?, feedbackId? })`. Devuelve `{ element, view, setView, selected, setLanes, select, refresh, destroy }`.
- **Pestañas**: chips desplazables con título y recuento, y un carril visible. Es `tablist`/`tab`/`tabpanel`, y las flechas, Inicio y Fin cambian de carril.
- **Lado a lado**: desplazamiento horizontal, y vertical dentro de cada carril.
  - La altura sale de `--lanes-height`, por defecto `min(72dvh, 760px)`.
  - Cada carril mide `clamp(172px, 50vw − 22px, 240px)` y crece hasta llenar el ancho: dos en un móvil en vertical y de 5 a 7 en un PC.
  - Un carril `empty` se pliega a una mini columna de 44 px con el título girado (o `short`); al tocarla se despliega.
- **Conmutador «Pestañas / Lado a lado»** siempre visible.
  - La elección se guarda en el dispositivo (`storageKey`).
  - Sin nada guardado, se usan pestañas por debajo de `wideFrom` (720 px) y lado a lado por encima.
- **Ciclo de vida** (lo pidió Flow): `mount(body)` se llama una vez, cuando el carril se ve por primera vez, y puede devolver su limpieza.
  - La limpieza se llama al quitar el carril con `setLanes`, con `refresh(id)` (que vuelve a montarlo) y con `destroy()`.
  - En «Pestañas», los carriles ya montados se ocultan sin desmontarse; el mismo nodo pasa de una vista a otra.
- **`onSelect(id)`** avisa del carril principal, por ejemplo para el hash o la barra inferior. Se llama:
  - al elegir una pestaña;
  - en «Lado a lado», al tocar una cabecera o cuando otro carril pasa a ser el primero visible (60 % o más) al desplazar.
- **Feedback**: `feedbackId` marca `<base>.vista`, `<base>.carril` y `<base>.desplegar`; el catálogo añade esos hijos solo.
- Tokens del kit en los dos temas y textos en inglés.
- Pruebas: `tests/v65.spec.ts`.

## 0.60.0 · 27 de octubre de 2026

**`renderQr(text, { size, label, margin })`** → `SVGSVGElement` (petición de Booking, visión V0.2: el QR de entrada de visitantes que se imprime en la ficha del evento).
- **Sin red y sin dependencias**: codificador propio (`src/print/qr.ts`) en modo byte UTF-8.
  - Nivel de corrección M. Versiones 1 a 10, hasta 213 bytes; una URL corta como `https://ven.ikisai.com/e/AB12CD` sale en la versión 3.
  - Se queda la máscara con menos penalización (reglas 1 a 4 de ISO/IEC 18004).
  - Con un texto más largo lanza un error que dice cuánto cabe.
- **Negro sobre blanco en los dos temas**, para imprimir: los colores van fijos en el SVG.
  - `size` en px (por defecto 160).
  - `margin` en módulos (por defecto 4, el de la norma).
  - `role="img"` y `aria-label`, que es `label` o, si no se da, el propio texto.
  - Clase `qr-code`.
- **Pruebas** (`tests/v64.spec.ts`, con un lector propio en `tests/qr-read.ts` que no usa el codificador):
  - se leen de vuelta textos de 1 a 213 bytes, con los síndromes Reed-Solomon a cero;
  - la información de versión (7 a 10) coincide con la tabla de la norma, y las dos copias del formato son iguales;
  - el SVG se lee desde su propio dibujo.

## 0.59.0 · 27 de octubre de 2026

**Inventario semántico de campos** (visión V0.2, encargo de Core; la forma está acordada con Central para «Uso y cobertura»). Cada campo de un formulario declara qué es, nunca lo que se escribe en él: no se toca la telemetría de valores. Sin declarar nada, no cambia nada.

- **Convención y helper** (`src/fields/field-mark.ts`): `FieldSpec` `{ id, entity, prop, type, required, permission, sensitivity, since, route, anchor, label }`.
  - El `id` es estable y tiene la forma `<app>.<pantalla>.<campo>`, como los de feedback.
  - `required` vale `true`, `false` o la condición en palabras.
  - `sensitivity` vale `'public'`, `'internal'`, `'personal'` o `'sensitive'`.
  - `fieldAttrs(spec)` da los atributos `data-field-*` para `el()`; `markField(nodo, spec)` marca un nodo ya creado, y en el HTML valen los mismos atributos.
  - Si el campo no tiene `data-feedback-id`, lleva el mismo id: es su ancla para el feedback y el uso. `markField` no pisa uno que ya exista.
- **Los campos del kit se marcan solos** con la opción `field`, y ponen ellos el tipo y «obligatorio»: `createDateField`, `createQuantityField`, `createSuggestField`, `createColorField`, `createLabelPicker`, `createLevelStar` y `createSignaturePad`.
- **`createStepForm({ feedbackId })`** marca cada pregunta como `<feedbackId>.<id>`, en minúsculas (`checkIn` pasa a `check_in`), con su tipo y su texto. `StepQuestion.field` añade entidad, propiedad, permiso, sensibilidad…
- **Catálogo** (`scripts/feature-catalog.mjs`): el `feature-catalog.json` de cada versión trae dos listas nuevas.
  - `fields`: `{ fieldId, app, screen, route, anchorId, label, type, entity, prop, required, permission, sensitivity, since, source, file, line }`.
  - `fieldsUninstrumented`: los `input`, `select` y `textarea` (sin `hidden`, `submit`, `button`, `reset` ni `image`) y los campos del kit sin declarar, con su `data-feedback-id` si lo tienen.
  - `fieldsDynamic`: lo que no se puede leer (ids no literales, preguntas de `createStepForm` fuera de la llamada). Va aparte para que `dynamic` siga siendo solo de funciones.
  - Cada campo declarado entra también en `features` con `kind: 'field'`. Lo de antes no cambia: en Booking, Tasks y Central, `features` y `dynamic` salen iguales que en main.
- **Informe «campos sin instrumentar»**: `node packages/ui-kit/scripts/feature-catalog.mjs --fields-report [--app booking] [--out informe.md]`. Hoy en main hay 0 campos declarados y 588 sin instrumentar:

  | App | Sin instrumentar |
  |---|---:|
  | Booking | 36 |
  | Central | 112 |
  | Flow | 18 |
  | Food | 54 |
  | Guests | 22 |
  | Invoices | 120 |
  | Organizers | 74 |
  | Tasks | 152 |
- `since`: si no se declara, lo pondrá el núcleo con la primera versión en que vea el campo; la carga es de Core (`usage_catalog_ingest.py` aún sube solo `features`).
- Pruebas: `tests/v63.spec.ts`.

## 0.58.0 · 26 de octubre de 2026

**Tres peticiones de Tasks** (K1, K2 y K3 de `docs/tasks/PETICIONES.md`). Todo es opcional: sin las opciones nuevas no cambia nada.

1. **K1 · `Stat.selected`** (FB_2026_069). En `renderStats`, la cifra que filtra lleva `aria-pressed="true"`; las demás con botón, `"false"`. La elegida se marca con un borde de 3 px del acento (`.stat-selected`), sin depender del color del texto. Sin `selected` en ninguna cifra, no se pinta `aria-pressed`, como antes.
2. **K2 · la barra inferior en la app instalada** (FB_2026_075; VG eligió «a + b»). Nueva opción `renderTabBar({ …, standalone: 'flush' | 'autohide' | 'both' })`. Solo actúa con `display-mode: standalone`; en el navegador no cambia nada.
   - `'flush'`: los botones bajan hasta el borde (relleno inferior `max(6px, área segura − 14px)`), sin la franja de papel vacía bajo ellos.
   - `'autohide'` (`bindTabBarAutoHide(nav)`): la barra se esconde al bajar más de 24 px. Vuelve al subir, al llegar al final, al deslizar hacia arriba desde los 24 px inferiores y cuando el foco entra en ella. Va superpuesta al contenido.
     - Hay un solo vigilante para toda la página, así que repintar la barra no suma oyentes.
     - No cuentan las hojas, los diálogos, la paleta ni el menú.
     - Sin animación con `prefers-reduced-motion`.
   - **`--tabbar-offset`** en `:root`: lo que ocupa la barra a la vista, y 0 escondida. El `.fab` del kit la usa (`bottom: calc(var(--tabbar-offset, 68px + área segura) + 16px)`), así que baja con la barra. Sin la opción, queda donde estaba.
3. **K3 · «Mis reportes»** (FB_2026_072). `openFeedbackCenter({ …, scope: 'mine' })` y `renderFeedbackCenter` igual.
   - Sin Mapa, con tres vistas: Abiertos, Pendientes de verificar («Funciona» y «Sigue fallando») y Mis borradores.
   - Las listas piden `&mine=true`, y la hoja se titula «Mis reportes» («My reports» en inglés).
   - Es para las apps cuya revisión vive en otra (Central, `#/revision`).
- **Pruebas:** `v62` (4 casos). La app instalada se simula en `matchMedia`, porque Playwright no emula `display-mode`.

## 0.57.1 · 26 de octubre de 2026

**Icono de Flow en el lanzador.** En `KIT_ICONS` (`shell/launcher.ts`), `flow` lleva `board`, un icono neutro del set. Hasta ahora salía el de repuesto (`grid`), el mismo que Central. No cambia nada más; una app que pase `appIcon` sigue usando el suyo.

## 0.57.0 · 20 de octubre de 2026

**El envase, la baldosa con varios mandos y la estantería** (tanda 40, MUELA-093 y 094). Las piden la Compra de Food y Compras R6 de Tasks. Todo es nuevo u opcional: lo de antes no cambia.

1. **`Envase`** (`pieces/envase.ts`), la pieza común de La Muela pasada al kit con la misma API:
   - `plan`, `buyText`, `extraText`, `packText`, `legible`, `words`, `draw`, `tube`, `legend` y `formatSheet`.
   - **Las cuentas:**
     - con envase, envases enteros del habitual;
     - a granel, lo justo;
     - en unidades, manojos o paquetes, el entero;
     - lo que sobra = lo que se compra − lo que hace falta;
     - coste = envases × precio.
   - **Sin precio, `cost` es `null`, nunca 0.**
   - `formats` acepta las filas de `item_units` tal cual: `unit` es la etiqueta, `factor` el tamaño, y además `usual` y `price`. La fila vuelve en `source`.
   - `keep` («al almacén») y `where` («en el inventario») son configurables.
   - **`formatSheet` nunca cambia el tamaño de un envase que ya existe:** «Otro envase» es una fila nueva (`isNew`) y pasa a ser la habitual. Devuelve lo elegido en `onSave`; escribir es cosa de la app.
   - `returnFocus` devuelve el foco al dibujo aunque la app repinte la baldosa.
   - Clases con los prefijos `ev-` y `fs-`, comprobados con `git grep`.
2. **`renderTile` con varios mandos:** `actions: [{ slot: 'media' | 'corner' | 'more', label, onClick, icon?, pressed? }]` y `media`.
   - Con mandos, la baldosa es un `div` con botones hermanos: ningún botón va dentro de otro.
   - `media`: el dibujo es un botón; sin esa acción, el dibujo no es botón.
   - `corner`: la esquina de 46 px (el carrito o la casilla), con `aria-pressed`.
   - `more`: el «⋯» de 46 px, a la izquierda de la esquina, en la fila del medallón y fuera del flujo, así que la baldosa no crece. El nombre va bajo el medallón.
   - La pulsación larga equivale al «⋯» (`onLongPress`, también exportada como `bindLongPress`). Los botones lo dicen en su descripción accesible.
   - `onClick` sigue siendo tocar la baldosa, en un botón que la cubre por debajo de los demás.
3. **`createShelves`:** baldosas en filas con arrastre **entre filas**.
   - Con el ratón, desde cualquier punto de la baldosa. Con el dedo, tras la pulsación larga; si se suelta sin moverla, se abre el «⋯».
   - Al soltar llama a `onMove(item, fromRow, toRow)`.
   - Alternativa con el teclado: `moveSheet(item)` («Mover … a otra tienda», para el «⋯») y Alt+↑ / Alt+↓, con anuncio y el foco en la baldosa movida.
   - `canMove` indica lo que no se mueve (lo comprado, lo que está en un plan).
   - Prefijo de clases: `shelf-`.
4. **El asa de `createSortableList`** pasa a medir 46 × 46 (antes, 36 × 44). Lo pide el «Plan de hoy» de Tasks (MUELA-095).
- **Demo:** `#envase`.
- **Pruebas:** `v61` (8 casos).

## 0.56.0 · 20 de octubre de 2026

**Dos peticiones menores.** Opcionales: por defecto no cambia nada.

- **`createSpaceMap({ labelJoin })`** (Tasks, MUELA-090): el separador entre el nombre y el estado en el nombre accesible («Hab 3: 2 tareas abiertas, 1 vencida»). Por defecto, « · ».
- **`FocusItem.openLabel`** (Food): el texto del botón de abrir por tarjeta («Confirmar consumo», «Abrir en el Recetario»). Manda sobre el `openLabel` de la pieza; sin ninguno, «Abrir».
- **Pruebas:** `v58` y `v60` (+1 cada una).

## 0.55.0 · 20 de octubre de 2026

**Tres opciones de `createSpaceMap` para Tasks** (tanda 37, MUELA-090). Opcionales: por defecto el mapa no cambia.

1. **`layout: 'all'`:** todos los dibujos a la vez, cada uno con su título, en lugar del selector: dos por fila en el ordenador y uno en el móvil. La lista es la de todos.
2. **`mode: 'plan'` (solo plano):** sin lista ni conmutador propios, para la app que ya enseña su lista equivalente (Tasks, su árbol).
   - **La app tiene que poner esa lista.**
   - Sin dibujo, la pieza enseña su lista igualmente: nunca se queda sin ella.
3. **`layer(space) → { short }`:** la cifra corta que se pinta en el dibujo («2»), destacada. `label` es la frase que dicen la lista y el lector de pantalla («2 tareas abiertas, 1 vencida»).

- **Además:** una cama que el filtro deja fuera se ve apagada y sin número.
- **Pruebas:** `v60`.

## 0.54.1 · 20 de octubre de 2026

- **`createSpaceMap({ bedNumbers: false })`** (MUELA-056, Guests): las camas van solo por color, sin el número pintado en el plano ni en la lista. Quedan el nombre accesible («Cama 1, Hab 3 · Libre»), el estado en palabras y la leyenda. Por defecto, con número, como hasta ahora.
- **Pruebas:** `v59`.

## 0.54.0 · 20 de octubre de 2026

**«La elegida ampliada» en `createSpaceMap`** (MUELA-056, para Guests). Opcional: sin `focus`, el mapa sigue igual.

- **`focus: spaceId`** (y `setFocus(id | null)`):
  - el mismo dibujo, recortado a la forma de ese espacio con un poco de margen;
  - encima, su contorno marcado y lo de dentro con los mismos datos y la misma capa del plano: las camas con su número, su color y su estado, tocables y con nombre accesible;
  - el plano se llama «Hab 3 en el plano»;
  - ampliada, cada cama mide más de 46 px en el móvil, y el número no baja de 16 px.
- **La lista equivalente** es la de ese espacio y lo de dentro. Sin forma, solo esa lista, con «Sin sitio en el plano: lo de dentro, en lista.»
- **Pruebas:** `v59`.

## 0.53.1 · 20 de octubre de 2026

- **`floorPlanFromRow`** (tanda 35, punto 6): un dibujo subido sin red lleva en `file_id` el marcador `{ "$blob": sha }` hasta que se sube. Mientras, cuenta como sin archivo y el mapa pinta la capa sobre papel. Antes se usaba el marcador como id de archivo.
- **Prueba `v39`** («deslizar con el dedo… mientras se eligen días»): fallaba la mitad de las veces en local. `scrollIntoViewIfNeeded` dejaba el día debajo de la cabecera fija de la demo, que en el móvil mide casi 400 px, y el gesto empezaba sobre ella. No dependía de la hora. Ahora la cabecera va sin `sticky` en esas pruebas: 8 de 8.
- **Pruebas:** `v57` (marcador `$blob`).

## 0.53.0 · 20 de octubre de 2026

**Ajustes que piden Central y Food** (tanda 35). Sin cambio de diseño; lo de hoy sigue igual salvo lo que se lee o se toca mejor.

1. **`renderMedal` con color:** las iniciales llegan a 4,5:1 sobre cualquier color de equipo. Se elige blanco o tinta, la que contraste más; si ninguna llega (#c4712f, #b7791f), el fondo se oscurece lo justo. La función es `readableColor`, exportada. Un color que ya llega no cambia.
2. **`.filterchip`** mide 46 px (antes 36; también en los tipos de artículo, antes 40).
3. **Azulejos del menú:** no parten palabras («Obligaciones» en una línea); el texto se ajusta entre 11 y 12,5 px.
4. **`renderGroups`:** `tail` por grupo, una cola plegada al final («Revocados (1)») que no cuenta para el recuento, el tono ni el resumen. Lleva la marca `${feedbackId}.cola`.
5. **Food y Central:**
   - **`spaceShortPath`:** la ruta corta del sitio («Cocina › Despensa»), la misma que enseña el selector.
   - **`createFocus`:**
     - `openLabel`, para que el botón de abrir diga lo que hace («Ver en la Despensa»);
     - `action`, una acción destacada más («A la compra»).
   - **`createItemCatalog`:**
     - `focusAction`: la acción de lo que pide atención, primera y destacada, en filas y baldosas. Por defecto aparece en lo que está bajo mínimo; `when` cambia la regla;
     - `setFilter(f, { persist: false })`: el filtro que llega por enlace no pisa el guardado.

- **Pruebas:** `v58`.

## 0.52.0 · 20 de octubre de 2026

**Mapa de zonas: `createSpaceMap`** (tanda 34, MUELA-024). Pieza nueva; lo de hoy no cambia.

1. **El dibujo:** cada edificio y planta (`resources.floor_plans`) se pinta como `<image>` dentro de un SVG con `viewBox` = `width` × `height`. Se ve entero, sin zoom ni arrastre, y pequeño en el móvil. El SVG subido nunca se mete en la página.
2. **La capa:** cada estancia con forma (`plan_id` + `plan_shape`, puntos 0..1) es un botón con su nombre y su estado (`layer(space)` → `tone`, `label`, `state`).
   - Tocar, o Intro o Espacio, resalta el contorno exacto y llama a `onPick(space, { from, offline })`; la app abre su ficha.
   - **Camas** con su número y por colores: gris si no se puede, azul con rayado si está ocupada, verde claro si está libre y verde intenso si está elegida. La leyenda solo lleva los estados que hay.
   - Una habitación con camas dice «N libres» o «Completa» si la app no da otro texto. Sin camas, nada (adenda 1).
   - Los rótulos no bajan de 11 px en pantalla; con camas dibujadas, el nombre de la habitación va abajo.
3. **Lista equivalente siempre**, con la ruta (`spacePath`): lo del edificio del dibujo, con «Sin sitio en el plano» si falta la forma; filas de 52 px.
   - Conmutador Plano/Lista (46 px) en el móvil; lado a lado en el ordenador (`mode: 'both'`, por defecto).
   - `mode: 'map'` deja el conmutador en todos los anchos; `mode: 'list'`, solo la lista.
   - Sin dibujo o sin formas, solo la lista, con su motivo.
4. **Varios dibujos:** conmutador por edificio y planta.
5. **Sin red:** se ve la última copia con aviso, y la app sabe que no hay red en `onPick`. Si el dibujo no carga, las estancias siguen en su sitio.
6. **Preparado para «Colocar»** (Central), sin pantalla: `setShape(id, planId, shape)` y `onShape`.
7. **Datos:**
   - `SpaceRow` lleva `planId` y `planShape`, y `spaceFromRow` y `spaceToFields` los leen y escriben.
   - `createSyncSpaceSource(...).plans` lee `resources.floor_plans` (`floorPlanFromRow`).
8. **Accesibilidad:**
   - el plano tiene nombre («Plano de Albergue · Planta baja»);
   - el estado va siempre en palabras, en el plano, en la lista y en el nombre accesible;
   - contraste ≥ 4,5:1;
   - con movimiento reducido, sin transiciones;
   - prefijo `map-`.

- **Todavía no:** «Colocar» con pantalla y elegir plaza de litera (las literas siguen siendo camas).
- **Pruebas:** `v57`.

## 0.51.0 · 20 de octubre de 2026

**Velo completo para portadas con texto** (punto 11, Organizers) **y `feedbackRoundTrip` dentro del cajón** (punto 12, Tasks y Booking).

- `renderMedal({ cover: true, veil: 'full' })`: el velo cubre toda la foto y el texto blanco da 4,5:1 de arriba abajo, también sobre una foto blanca (antes, en la franja media, el velo era de 0,15). Organizers puede quitar su refuerzo.
- Sin `veil` (o con `veil: 'edges'`), el de siempre: oscurece abajo y arriba y deja ver la foto en medio.
- **`feedbackRoundTrip` y `setMode`:** el interruptor se busca solo en el cajón abierto (o en la hoja), también con la columna, desde la 0.50. Ahora, si el cajón ya está abierto, no se pulsa la marca, que lo cerraría. Tasks y Booking pueden quitar sus apaños.
- **Pruebas:** `v56`.

## 0.50.0 · 20 de octubre de 2026

**Lo que falta de la tanda 29 y la tanda 30** (Central, Tasks y MUELA-080). Lo de hoy queda igual por defecto, salvo `.segmented`, que se ve más.

1. **`createItemCatalog({ layout: 'baldosas' })`** (punto 8; Inventario de Central y Despensa de Food):
   - cada artículo es una baldosa con su cifra y el relleno hasta el mínimo (la mitad de la barra es el mínimo);
   - el nivel va en palabras: «Bajo mínimo», la caducidad, «Va justo», «Bien» o dónde está;
   - la baldosa abre la ficha; «Pedir» y las demás acciones van debajo, con 46 px y nombre propio («Pedir: Harina de espelta»).
   Por defecto, `list`, como siempre.
2. **Ayudantes de feedback con el menú lateral** (punto 9, P11 de Central): `setMode` y `portalHelpRoundTrip` buscan los interruptores dentro de lo abierto (el cajón del menú o la hoja), no en la columna que los repite.
3. **`createProposalList`** (punto 10, Tasks):
   - `confirm: false`: aprobar y descartar sin diálogo; el comentario opcional se escribe en la tarjeta (en escritorio, en el detalle);
   - `undoMs`: la decisión espera ese rato con «Deshacer» en el aviso y en la tarjeta, y entonces llama a `onApprove` u `onReject`. Si falla, la propuesta vuelve a pendientes con su comentario. Al destruir la lista se guarda lo que esperaba.
   Por defecto, siguen el diálogo y el guardado al momento.
4. **`.segmented`** (tanda 30, MUELA-080 n.º 5): el botón no elegido va en `--ink` (de 4,01:1 a más de 4,5:1 sobre crema y papel-2) y mide 46 px (`var(--tap)`); al pasar el ratón cambia el fondo.

- **Pruebas:** `v55`.

## 0.49.0 · 19 de octubre de 2026

**Ajustes que piden las pasadas** (Organizers, #623; tanda 29). No hay cambios de diseño y lo de hoy queda igual por defecto.

1. **`renderCover`:**
   - `headingLevel` (2–4) y `titleId`: el título es un encabezado de verdad. Con `onOpen`, el botón va dentro del encabezado y su zona de toque sigue cubriendo toda la portada.
   - El velo de `.medal-cover` da contraste también arriba.
2. **Salir:** «Cerrar sesión» se traduce, y `logoutOnMobile` lo enseña también en el móvil. Por defecto, solo en el ordenador, como siempre.
3. **`listRow`:** Intro y Espacio sobre una acción de la fila la pulsan a ella; ya no abren la ficha.
4. **`renderChecks`:** la acción mide de verdad 46 px (`.ghost.small` la dejaba en 36), y `action.aria` le da nombre cuando el texto se repite («Rellenar»).
5. **Ids de feedback literales**, para que entren en el catálogo:
   - `feedbackId` por grupo en `renderGroups`; sin él, sigue `${base}.grupo`.
   - `feedbackId` por paso en `renderSteps`; sin él, sigue `${base}.${id}`, porque Organizers localiza así sus pasos y quitarlo rompía su batería.
6. **`bindOnline`:** `renderOfflineReason()` crea una línea de motivo que comparten varios botones (`bindOnline(b, { line })`).
7. **Extracto:** `afterUpcoming` deja un hueco entre «Próximamente» y «Movimientos» (p. ej. «Cómo pagar»).

- **Nota:** `--muted` ya da 4,56:1 sobre `--bg` desde la 0.41.0. No había que tocarlo.
- **Pruebas:** `v54`.

## 0.48.0 · 19 de octubre de 2026

**«‹ Volver a…» entre apps (K9, MUELA-013, tanda 28).** Va solo, porque toca «atrás». **Es opcional:** sin `returnTo`, nada cambia.

- **Convención:** `…?desde=<app>&volver=<url>&titulo=<a dónde>`. `withReturnTo(destino, { from, title })` arma el enlace, y `readReturnTo`, `currentReturnTo` y `clearReturnTo` lo leen o lo olvidan.
- **`createAppShell({ returnTo })`:**
  - Al llegar con `volver`, sale «‹ Volver a {titulo}» arriba del contenido (46 px, con su marca si se da `feedbackId`).
  - Se quitan `volver` y `titulo` de la URL, para que recargar o «atrás» no repitan el salto.
- **«Atrás» (`installBackNavigation({ returnTo })`):** con origen, desde el inicio vuelve a la app de la que se vino, sin «¿Cerrar la app?». Sustituye la entrada, así que no hay bucles.
- **Cuidado con lo que ya existía:**
  - `desde` sola no cuenta y no se toca: Booking → Finance la usa para «Emitir factura».
  - Solo vale una vuelta a `*.ikisai.com` o al mismo origen.
- **Pruebas:** `v53`. La batería completa de las apps corre en la CI, porque cambian `back-navigation.ts` y `app-shell.ts`.

## 0.47.0 · 19 de octubre de 2026

**Cáscara con menú lateral común** (MUELA-013, tanda 28): K1, K2, K7, K8, K10, K11, K12 y el estado de sincronización bajo el perfil. K9 («Volver a…») va aparte. **Todo es opcional:** sin las opciones nuevas, la cáscara queda igual. Detalle en el README («Menú lateral común»).

- **`createAppShell({ menu })` (K7 y K8):**
  - La marca abre el cajón del menú (`createAppMenu`, exportado) en vez de la hoja de apps. Con `menu.column`, en el ordenador hay además una columna fija de 316 px.
  - Contenido: perfil y rol; la línea de sincronización (`syncLine`); tema; recientes; secciones en azulejos que despliegan sus filas; `blocks`; apps sin la actual; comentarios y ayuda; cerrar sesión.
  - Es un diálogo modal con foco atrapado. Escape, el fondo y «atrás» lo cierran.
  - Con menú, en el móvil estrecho la pastilla de estado se queda en un punto de color, así que «sin red» y los conflictos siguen a la vista.
- **`search` (K8):** lupa en el móvil y caja con «Ctrl K» en el ordenador.
- **`navLayout: 'bar'` (K12):** la barra de pestañas abajo y en horizontal también en el ordenador.
- **Paleta:** `keepOrder` (K1). «Atrás» la cierra, con `trackOverlay` (K10).
- **Feedback:** `captureFeedbackTarget({ delay: 0 })` señala con un toque (K2). El gesto dispara al soltar sin moverse. Con el `delay` de siempre, nada cambia.
- **Marca:** la que se pulsa mide 46 px y los botones de navegación de escritorio también (K11). Es un cambio visible en las cabeceras de todas las apps.
- **Lanzador:** `mount(host, { hideCurrent, part })` pinta las apps o los bloques de feedback dentro del cajón, con las mismas clases.
- **Prefijo:** `appmenu-`. La barra lateral `.navmenu` de Tasks no cambia, y el fondo del cajón también se ve en el ordenador.
- **Pruebas:** `v52`. La batería completa de las apps corre en la CI, porque cambia `app-shell.ts`.
## 0.46.1 · 19 de octubre de 2026

**Arreglo en `createQueue` («una cosa cada vez»)**. Lo encontró la CI de #618: `v49` fallaba siempre en Linux.
- **Qué pasaba:** mientras la tarjeta salía (300 ms), sus botones seguían recibiendo toques. Un segundo toque rápido confirmaba la siguiente cosa sin verla. En la última tarjeta se perdía, y la cola no llegaba a «Has pasado por todo».
- **Ahora:** la tarjeta que sale queda `inert`, con los botones desactivados, y `done()` y `skip()` ajustan la posición antes de actuar.
- **Prueba:** nueva en `v49`, con dos clics seguidos en el mismo botón. Sin el arreglo falla («3 de 3» en vez de «2 de 3»).

## 0.46.0 · 19 de octubre de 2026

**Bandeja por áreas, lote C** (MUELA-075 K20, K15 y K16, tanda 27). Con esto, la tanda 27 está completa. Detalle en el README («Lote C»).

- **Nueva: `renderTray` y `renderTrayRow`.**
  - Es una bandeja visual genérica, por áreas o por estado: SES la usa así.
  - Las áreas se pliegan y llevan su recuento.
  - La línea pone el título junto al medallón y el resto a todo el ancho. Variante «rechazado».
- **Ampliada: `renderConflicts` con `layout: 'tray'`.**
  - Agrupa con `groupBy` y pone medallón en cada línea.
  - Dice lo que choca en una línea, con dos botones al mismo nivel («Lo mío» / «Lo de Laura» con `theirsName`). En un borrado son «Borrar» y «Conservar».
  - «Los dos» para listas; «Ver diferencias» abre la tarjeta de siempre, con «Combinar».
  - `undoMs` retrasa el envío y ofrece «Deshacer».
  - **Sin `layout`, todo queda igual que antes.**
- **Arreglo en el aviso:** un aviso con acción ya oculto seguía recibiendo toques y tapaba lo que tenía debajo. Ahora solo los recibe mientras se ve.
- **Demo:** `#piecesc`. **Pruebas:** `v51`, que comprueba también que sin `layout` siguen las tarjetas.

## 0.45.0 · 19 de octubre de 2026

**Piezas comunes, lote B3** (MUELA-075, tanda 27): dinero y tiempo. Con esto, el lote B está completo. Detalle en el README («Lote B3»).

- **Ampliado:** `renderMoneyBreakdown` con `mode: 'statement'` (extracto): lo que queda, lo próximo y los movimientos por meses (`MoneyMove`). Sin `mode`, el desglose es el de siempre, y `lines` pasa a ser opcional.
- **Nuevas:**
  - `renderTimeline`, `timelineWindow` y `timelineSpan`: tu año en una línea de tiempo, con pistas por persona, retiros, hoy, choques y el resumen en texto.
  - `renderHourAgenda`: la agenda por horas con la línea de ahora.
- **De dónde sale cada una:** «Tu año» calca Booking Estancias, la única demo que lo tiene; en Guests, la pantalla 030 es el calendario del kit.
- **Accesibilidad:**
  - barras y retiros de 46 px, cada uno con su nombre completo («… · choca con …»);
  - la región de la línea de tiempo es enfocable y se desliza;
  - el estado siempre va escrito.
- **Prefijos:** `year-`, `hour-` y `mb-` (del kit). Pasa `v45`.
- **Demo:** `#piecesb3`. **Pruebas:** `v50`.

## 0.44.0 · 19 de octubre de 2026

**Piezas comunes, lote B2** (MUELA-075, tanda 27): recorrer y decidir. No cambia nada de lo que ya había. Detalle en el README («Lote B2»).

- **Nuevas:**
  - `renderSteps`: paso a paso con lo siguiente en grande.
  - `createQueue`: una cosa cada vez, con `done`, `skip` y `undo` para el «Deshacer».
  - `createVoteDeck`: votar deslizando, con botones y flechas como alternativa.
  - `createStepForm` y `StepFormInvalid`: pregunta a pregunta, solo de lo que falta, con `createSaveState`.
- **De dónde sale cada una:**
  - `createStepForm` es la mecánica de `createFeedbackProgressiveForm`, sacada para cualquier formulario. El formulario de «Ayuda y sugerencias» no cambia.
  - «Votar deslizando» calca la demo consolidada de Central (Decisiones), que Food copia para los platos sugeridos.
  - En «Una cosa cada vez», la demo de Finance no tenía la ficha completa de la nota. Se ha hecho genérica a partir de la nota y de lo que sí había: tarjeta, «… y siguiente», «Saltar» y «Deshacer».
- **Accesibilidad:**
  - acción principal de 54 px y el resto de 46 px;
  - recuentos y votos anunciados;
  - gesto con alternativa por botones y teclado;
  - sin giros ni salidas con movimiento reducido.
- **Prefijos:** `step-`, `queue-`, `vote-` y `ask-`. Pasa `v45`.
- **Demo:** `#piecesb2`. **Pruebas:** `v49`, con el deslizar probado con toques reales en el móvil.

## 0.43.0 · 19 de octubre de 2026

**Piezas comunes, lote B1** (MUELA-075, tanda 27): las piezas compuestas más visuales. Lo que ya existía no cambia. Detalle en el README («Lote B1»).

- **Nuevas:**
  - `renderCover` y `createFocus` (portada y foco);
  - `createCoverCarousel` (portada que se pasa con flechas, puntos, teclado y dedo, con «n de N» anunciado);
  - `renderLead` (lo primero en grande y la cola);
  - `renderNow` (lo de ahora abierto, el resto plegado).
- **Ampliado:** `createCalendar` acepta `price`, `tone` y `toneLabel` en `dayInfo` (calendario de precios). Sin esos campos, la celda es la de siempre.
- **Accesibilidad:**
  - objetivos de 46 px;
  - «✓ Hecha» con `role="checkbox"`;
  - recuentos anunciados;
  - el tono del precio dicho con palabras;
  - sin animaciones que reducir.
- **Prefijos:** `cover-`, `focus-`, `lead-`, `now-` y `cal-tone-`. Pasa `v45`.
- **Medallón:** fondo opaco, para que las iniciales se lean también sobre una foto o un color oscuro.
- **Demo:** sección `#piecesb`, sin enlace en la cabecera, que en el móvil ya tapaba el calendario de `v39`.
- **Pruebas:** `v48`, con el deslizar probado con toques reales por CDP en el móvil.

## 0.42.0 · 19 de octubre de 2026

**Piezas comunes, lote A** (MUELA-075, tanda 27): piezas pequeñas sin estado, para que las apps las usen al rehacerse. No cambia nada de lo que ya había. Detalle de cada una en el README («Piezas comunes»).

- **Nuevas:**
  - `renderMedal` e `initialsOf` (medallón);
  - `renderStages` y `stageStates` (recorrido, con `mini`);
  - `renderGroups` y `worstOf` (grupos con resumen de lo peor, también por etapa con la acción en la fila);
  - `deadlineText` y `deadlineInfo` (plazo en texto);
  - `renderStats` (cifras de color), `renderChecks` (veredicto y comprobaciones) y `renderTile` (baldosa con relleno, con `levelText` obligatorio);
  - `bindOnline` (desactivado con el motivo sin red).
- **Ampliada:** `renderAreaTabs` admite `layout: 'columns'` y `countText`, para las etapas con su cifra. Sin la opción, el DOM es el de siempre.
- **Accesibilidad:** objetivos de 46 px (64 px en las etapas tocables) y el estado siempre en texto. El medallón es decorativo salvo con `label`.
- **Prefijos:** `medal-`, `stage-`, `worst-`, `stat-`, `check-`, `tile-` y `offline-`. Pasa `v45`.
- **Demo:** sección `#pieces`. **Pruebas:** `v47` (funciones en Node, piezas en la demo y sin desbordar en el móvil).
- El catálogo de funciones conoce las marcas de `renderStages` (`.etapa`) y `renderGroups` (`.grupo`, `.filtro`).

## 0.41.0 · 19 de octubre de 2026

**Tres arreglos de la revisión de La Muela (MUELA-075, tanda 26).** No cambian el diseño.

- **Conflictos (`renderConflict`), que usan Booking, Central, Food e Invoices:**
  - **La acción principal es «Reintentar con lo mío» y va primero.** «Quedarme con lo del servidor», que descarta lo tuyo, queda al lado y sin destacar. Los `data-choice` y las marcas no cambian.
  - **Compara por contenido.** Un campo lista u objeto igual en las dos versiones ya no sale como cambiado. La función nueva `sameValue` está exportada.
- **Aviso con acción (`toastWithAction`):**
  - El botón mide al menos 46 px de alto.
  - **Otro aviso ya no quita el «Deshacer» de uno vivo:** se apilan en el mismo `.toast`, cada uno con su tiempo, el más antiguo arriba.
    - Hasta 3 avisos con acción a la vez.
    - Un aviso sin acción sigue sustituyendo al anterior sin acción.
    - Con un solo aviso, el HTML es el de siempre.
  - `hideToast()` quita todos.
  - El aviso ya no se queda en media pantalla en el móvil: antes partía «Tarea completada» en dos líneas. Ahora mide lo que el texto (`max-content`), hasta el 92 % del ancho.
- **Contraste (WCAG AA, 4,5:1), cambiando el color lo mínimo:**
  - **Claro:**
    - `--muted` pasa de #6d7a70 a #616d64: sobre `--bg`, de 3,79 a 4,56.
    - `--ok` pasa de #4f7a4a a #497044: chip `.ok`, de 3,98 a 4,55.
    - `--alert` pasa de #b3412a a #ae3f29: chip `.alert`, de 4,39 a 4,60.
  - **Oscuro:** `--alert` pasa de #e07a5f a #e3866e: chip `.alert`, de 4,12 a 4,58. Lo demás del oscuro ya pasaba.
- **Pruebas:** `v46` (conflictos, aviso y contraste medido en el navegador en los dos temas). En la demo, la muestra de conflicto lleva una lista y un objeto iguales; `v02` ya contaba 3 filas, y sin el arreglo serían 5.

## Sin versión · 19 de octubre de 2026

**Regla de prefijos de clases, con prueba** (Core, tras el `inv-` que escondía «Validar» en Finance).
- Las clases nuevas del kit no usan prefijos de app, ni las apps los del kit. Está en el README, en «Clases».
- **`v45`** lee el CSS del kit, las clases que pone su código y el CSS de todas las apps (también `<style>` en HTML), y falla si una clase de app comparte prefijo con el kit.
  - Excepción: las coincidencias que ya había (`date-` de Booking, `space-item`/`space-main` de Booking, `drop-` y `star-` de Tasks, `ikisai-kit`/`ikisai-legacy`), cada una con su motivo.
  - Comprobado a mano: con una `.inv-prueba` en el kit, la prueba falla y nombra `.inv-head`, `.inv-actions`… de Finance.
- No cambia el código del kit: sin versión nueva.

## 0.40.0 · 19 de octubre de 2026

**`createItemCatalog` con `refresh()`** (petición de Tasks, R6).
- Vuelve a pintar con los datos de ahora sin cambiar el filtro ni guardarlo. Sirve cuando cambia algo de la app que el catálogo no ve: lo que devuelven `rowActions` o `filter`.
- **Tasks** puede cambiar `setFilter(getFilter())` por `refresh()` en `purchases-ui.js`.
- **Demo:** «Pedir» pasa a «Pedido» al momento. **Pruebas:** una nueva en `v42`.

## 0.39.0 · 18 de octubre de 2026

**`createSpacePicker` con textos propios** (petición de Tasks: elige oficios con filas en forma de espacio).
- **Nueva opción `texts`**, ya traducidos por la app:
  - `empty`: sin resultados, con `{q}` para lo buscado («Ningún oficio coincide con «{q}».»);
  - `search`: el texto del buscador, si no se pasa `placeholder`;
  - `feedback`: las etiquetas de las marcas, por clave de `SPACE_PICKER_MARKS` (`quick`, `search`, `option`, `remove`).
- **Sin `texts`, todo igual que antes;** lo que no se pasa sigue con el texto de espacios.
- **Tasks** puede quitar `TRADE_WORDS` y el `MutationObserver` de `trades-ui.js` y pasar `texts`.
- **Demo:** «Oficio de la tarea» en `#spaces`. **Pruebas:** `v44`, que también comprueba que los espacios no cambian.

## 0.38.1 · 18 de octubre de 2026

**Arreglo en `createCountSession`** (lo encontró Central):
- **Qué pasaba:** con el foco en una casilla, el repintado parcial solo actualizaba el contador y las marcas. «Revisar y cerrar» seguía desactivado aunque dijera «1 de 2 contados», y «Sin contar (n)» no bajaba.
- **Ahora:** el repintado parcial actualiza también el botón, la barra y el chip.
- **Antes de guardar:** con la primera cantidad escrita ya se puede pulsar «Revisar y cerrar», que guarda lo escrito.
- **Por qué no `focusout`:** repintar al salir de la casilla sustituiría el botón justo cuando se pulsa.
- **Pruebas:** dos nuevas en `v43`, sin pulsar «Ver lo calculado», que fallan sin el arreglo.

## 0.38.0 · 18 de octubre de 2026

**Movimientos y recuento del inventario** (R3, segunda entrega aprobada el 18-10-2026). Con esto, «Gastar», «Entrada», «Trasladar» y «Contar» del catálogo y de la ficha ya tienen pantalla.

- **`createMovementForm`:** entrada, salida o traslado a mano.
  - **Siempre:** artículo (`createItemPicker`, fijo si se abre desde una fila), cantidad en sus unidades, sitio y nota.
  - **Entrada:** coste por unidad base opcional; con lotes o caducidad, un lote que ya existe o uno nuevo con su código y fecha (la fecha es obligatoria si el artículo lleva caducidad).
  - **Salida:** motivo obligatorio. Sale primero lo que caduca antes y lo dice («Sale del lote L-1018 · caduca mañana»), o de un lote elegido.
  - **Traslado:** dos filas con el mismo `transfer_id` en **un solo lote** de commit; si hay que tirar de varios lotes, un par por lote.
  - **Resumen:** lo que quedará («Quedarán 8 ud en Cámara»). Avisa sin bloquear si sale más de lo que consta en el dispositivo.
  - Con un solo modo (`modes: ['exit']`, el «Gastar» de Tasks) no hay selector, y el motivo se puede preelegir (`reason`).
- **`createCountSession`:** recuento en el móvil, sin red.
  - Un sitio y lo de dentro, todo, o solo unos artículos (el «Contar» de una fila). Retoma el recuento abierto de ese sitio, o lo abre al guardar la primera línea.
  - **A ciegas por defecto:** «Ver lo calculado» lo enseña, también en el «Recontar» de Tasks.
  - **Cada línea se guarda al escribirla,** con − y +. Pasar a la siguiente casilla no pierde lo escrito: se aplaza el repintado hasta que el foco llega.
  - Chips por sitio y «Sin contar»; «Contar otro artículo aquí».
  - **«Revisar y cerrar»:** cada diferencia y cuántas cuadran; «Cerrar y ajustar» llama a `resources.close_count`.
    - Avisa de que **se cierra al sincronizar**, con el stock de ese momento (Core, 18-10).
    - Lo no contado no cambia.
- **Modelo:**
  - `fefoPlan` (primero lo que caduca antes, después sin caducidad, y lo que falta aparte), `stockAt`, `countTargets`, `movementToFields`, `CountRow`, `CountLineRow` y `MovementDraft`;
  - la fuente escribe `record` (lotes y movimientos en un lote), `openCount`, `saveCountLine` y `closeCount`, y lee `counts` y `count_lines`.
- **Arreglo en `createItemPicker`:** `set({ quantity: null })` ya vacía la cantidad (antes la conservaba).
- **Demo:** `#inventory` abre el formulario y el recuento en una hoja, y suma «Movimiento a mano» y «Recuento de la cocina».
- **Pruebas:** `v43` (18), con el modelo en Node; con `v41` y `v42`, 62 de inventario en verde.

## 0.37.0 · 18 de octubre de 2026

**Catálogo y ficha del inventario** (R3, primera de las dos entregas aprobadas el 18-10-2026; movimientos y recuento, en la 0.38).

- **`createItemCatalog`:** la lista del inventario.
  - **Buscar:** por nombre y alias, sin tildes.
  - **Filtros a un toque, con cuántos hay:** bajo mínimo, caduca pronto (7 días, `expiringDays`), sitios (`spaceChips`), tipos y archivados. Con `storageKey` se recuerdan.
  - **Agrupar:** por sitio (por defecto), al nivel de espacio, así que la despensa va con su cocina. También por tipo o por categoría.
  - **Cada fila:**
    - stock y dónde, mínimo y avisos con texto («Bajo mínimo», «caduca mañana»);
    - «sin subir» y «archivado»;
    - las acciones del kit (`actions` → `onAction`) y las de la app (`rowActions`, p. ej. «Pedir»).
  - **Ancho:** en el móvil son filas con botones grandes. Con ancho (≥ 760 px de contenedor, `@container`) se alinean en columnas.
  - **Ámbito:** `scope` (sitios con lo de dentro) y `filter` (p. ej. el área de Tasks). Central lo monta sin ámbito.
  - **«+ Artículo»:** el alta rápida del selector y, después, `onOpen` con el nuevo.
- **`createItemSheet`:** la ficha de un artículo, que la app monta donde quiera.
  - **Stock:** por sitio y lote con su caducidad, total, bajo mínimo y coste medio. El coste sale del espejo, igual que `item_costs`, con los costes que llegan después y los contrarios, para que funcione sin red.
  - **Datos:**
    - nombre, sin repetir (la pista va enlazada con `aria-describedby`), tipo, categoría y unidad base (fija con movimientos);
    - mínimo, «Al pedir, cuánto», sitio habitual y proveedor (`supplierField` de la app);
    - otros nombres (`attributes.aliases`), lotes, caducidad y notas;
    - en máquinas y herramientas, también marca, modelo, serie, estado y factura de compra;
    - archivar con confirmación, y recuperar.
  - **Unidades:** conversiones con validación: nunca la base, factor mayor que 0 y sin repetir unidad y proveedor.
  - **Movimientos:** por fecha, con signo, en palabras («Traslado a Cámara», «Salida a mano · Merma») y con el origen que enlaza la app (`sourceLink`). Con ancho van siempre a la derecha.
  - `permissions.edit = false`: solo lectura.
- **Modelo:**
  - `LotRow`, `MovementRow`, `averageCost`, `lotsWithStock`, `nextExpiry`, `itemToFields` y las etiquetas de tipos, motivos y estados;
  - `createSyncItemSource` lee también `lots` y `movement_costs` y escribe la ficha (`update`, `setActive`, `saveUnit` y `removeUnit`) con la revisión de la fila.
- **Clases con prefijo `stk-`:** `inv-` ya lo usa Finance (`.inv-head`, `.inv-actions`), y con él el kit le escondía el botón «Validar».
- **Demo:** sección `#inventory`. **Pruebas:** `v42`, con el modelo en Node, el catálogo y la ficha en móvil y escritorio.

## 0.36.0 · 18 de octubre de 2026

**`createItemPicker`** (R3; propuesta aprobada el 18-10-2026): elegir un artículo del inventario o crearlo sin salir. Lo esperan Finance (R4), Food (R5) y Tasks (R6).

- **Buscar:**
  - por nombre y alias, sin mayúsculas ni tildes; los alias son `attributes.aliases` más los que pase la app (`aliases`);
  - cada resultado lleva su tipo y su stock («18,5 kg · Despensa», «sin stock»);
  - bajo mínimo se avisa con texto, no solo con color;
  - con `stockIn`, solo el stock de esos sitios y de lo que hay dentro;
  - se maneja con flechas, Intro y Esc, como `createSpacePicker`.
- **Crear al momento** (`create`, por defecto activo), desde la última opción, «Crear «lo escrito»»:
  - avisa de los parecidos antes de crear: mismo nombre sin tildes, uno contenido en otro o la misma primera palabra;
  - no deja repetir un nombre, con la misma regla que el índice del servidor, y ofrece «Usar «X»»;
  - el alta va dentro del campo, no en otra hoja: nombre, tipo (los que admite el campo), unidad base y, si hay sitios, dónde se guarda;
  - sin red se crea en el dispositivo y se sube al volver.
- **Nombre repetido entre dos dispositivos sin red:**
  - `createSyncItemSource` descarta el lote rechazado (`CONSTRAINT_VIOLATION`) y busca el que ya existe;
  - el campo enseña «Ya existe «X» (lo dio de alta otro dispositivo)» con «Usar ese»;
  - con `onChange`, la app reapunta su línea al artículo que ya existía.
- **Cantidad** (`quantity`):
  - unidades: la base, las métricas equivalentes (g ↔ kg, ml ↔ l) y las conversiones de `item_units`;
  - con `supplierId`, las de ese proveedor van primero y las de otros, con su nombre;
  - la equivalencia sale en vivo: «= 50 kg · 1 saco = 25 kg».
- **Sitio** (`space`): un `createSpacePicker` dentro que propone el sitio habitual del artículo.
- **Usos especiales:**
  - `fixed`, fijo en un artículo («Gastar»);
  - `allowText`, «Usar «texto» sin artículo», para gastos que no son inventario.
- **No escribe movimientos:** devuelve `{ itemId, text?, quantity, unit, unitId, baseQuantity, spaceId }` y cada app hace su commit.
- **Modelo puro** (`src/items/model.ts`), exportado para que las apps usen las mismas reglas:
  - `searchItems`, `sameNameItem`, `similarItems`, `unitsFor`, `baseQuantity`, `stockFromMovements` y `stockSummary`;
  - `itemFromRow` y `createMemoryItemSource`.
- **Fuente real:** `createSyncItemSource(client)` sobre el espejo de `resources` (artículos, unidades, tipos y movimientos), así que funciona sin red.
- **Feedback:** marcas `ITEM_PICKER_MARKS` y entrada en el catálogo de funciones.
- **Demo:** sección `#items` con tres usos: receta, «Gastar» y línea de factura.
- **Pruebas:** `v41`, con el modelo en Node, buscar, teclado, crear, repetido, sin red, «Gastar», factura e inglés.

## 0.35.0 · 14 de octubre de 2026

**`createCalendar` con `select`, fino en Android** (O2 y O4: Guests y Booking).

- **Deslizar para cambiar de mes ya funciona con el dedo de verdad.**
  - Antes, Android cancelaba el gesto horizontal (`pointercancel`) y solo funcionaba en la prueba sintética.
  - La rejilla lleva ahora `touch-action: pan-y pinch-zoom`: el desplazamiento vertical y el zoom con dos dedos siguen igual.
  - Esto también lo gana el calendario de Booking.
- **También se desliza mientras se eligen días**, para estancias que cruzan de mes. El primer día ya tocado se conserva.
- **«Nueva estancia» trae el calendario a la vista** si el día no se ve (desplazamiento suave, o directo con movimiento reducido).
- **Pista de toque en vez de teclado** en pantallas sin ratón: «Desliza a los lados para cambiar de mes.». La barra es más baja. En escritorio sigue la pista de teclado.
- **Sin efectos raros al tocar:**
  - el hover ya no se queda pegado en el último día tocado (solo con `hover: hover`);
  - no hay destello azul al tocar, sino un fondo suave mientras se pulsa;
  - mantener pulsado mientras se eligen días no selecciona texto ni abre el menú;
  - la vista previa del rango al pasar por encima solo sale con ratón.
- **La barra de elegir días queda encima de la barra inferior de la app** (`.nav` o `.tabbar`) en móvil y tableta, en vez de quedar tapada.
- **U6 (Guests): textos del calendario en inglés.**
  - «Hoy», «Anterior», «Siguiente», «Vista», «Mes», «Semana» y «N eventos» pasan por `kt`.
  - Al cambiar el idioma del kit en vivo (`onKitLocaleChange`), el calendario se reetiqueta sin rehacerse.
- **Pruebas:** `v39` amplía con toque real por CDP, que pasa por el reconocedor de gestos de Chromium. La de deslizar falla sin el arreglo. También prueba el cambio a inglés y la vuelta a español en vivo.

## 0.34.0 · 14 de octubre de 2026

**Adaptador de sugerencias** (O1; contrato §3.10, `sync-client` 0.7.0).

- **`createSuggestionSource(client, { scope, app, limit, tables, fields })`:** fuente de `createProposalList` sobre `client.suggestions`.
  - **Lista y recuento:** `list()` y `pendingCount()` (el del servidor).
  - **Decidir y retirar:** `approve`, `reject` y `withdraw`, que se conectan tal cual a `onApprove`, `onReject` y `onWithdraw`.
  - **Vista previa:** `renderPreview(item)`, con el antes y después del lote (`previewSuggestion`) en la lista de cambios del kit, con nombres de tabla y campo.
  - **Errores con texto claro:** `SUGGESTION_NOT_ALLOWED`, `SUGGESTION_UNAVAILABLE`, `TOO_MANY_SUGGESTIONS` y sin red. Los demás llegan con el mensaje del servidor.
  - También exporta `proposalFromSuggestion`, `changesFromPreview` y `suggestionErrorMessage`.
- **`createProposalList` en camelCase**, como la API: `createdAt`, `decidedBy`, `decidedAt` y `label`.
  - La forma de la 0.33.0 (snake_case) se sigue aceptando (`normalizeProposal`).
  - `renderDetail` puede devolver una promesa: sale «Cargando…» y el resultado se guarda por propuesta.
  - `source.pendingCount()`, si lo da, manda en el contador de «Pendientes».
  - El nombre del tipo sale de `label` si `kinds` no lo trae.
- **Demo:** la cola usa el adaptador con un cliente simulado, sin red. Los platos y las solicitudes enseñan la vista previa del lote.
- **Pruebas:** `v40` amplía con el adaptador, la vista previa, la forma antigua y «ya no está pendiente».

## 0.33.0 · 13 de octubre de 2026

**Calendario de persona y cola de propuestas** (O1, O2 y O4 de `ampliacion/RECURSOS.md`; propuesta aprobada por el usuario el 13-10-2026).

- **`createCalendar` amplía sus opciones, todas opcionales.** Sin ellas, el calendario funciona como antes (Booking):
  - **Capas** (`layers`): color y estilo `solid`, `outline` (borde discontinuo) o `soft`. Con `legend`, chips para encender y apagar cada capa, que se recuerdan con `storageKey`. Con `shadeLegend`, el sombreado sale también en la leyenda.
  - **Sombreado y notas por día** (`dayInfo`): rayado «hay alguien», sin nombres, y marca de notas con hora. Las dos cosas se leen en la etiqueta del día.
  - **Panel del día** (`agenda`): debajo en el móvil y a la derecha en escritorio. Enseña los eventos, el sombreado y las notas, más lo que añada la app con `renderDay`. Tocar una barra también elige ese día.
  - **Elegir días** (`select` y `selectRange()`):
    - se toca el primer día y luego el último, y una barra abajo permite guardar;
    - en escritorio también se arrastra;
    - con teclado: Intro, flechas e Intro, y Esc cancela;
    - `selectRange({ from, to, eventId })` sirve para «Cambiar fechas»;
    - admite `minDays`, `maxDays`, `allowed` y `describe`, y anuncia cada paso;
    - `cancelSelect()` sale del modo.
  - **Deslizar a los lados** cambia de mes en pantallas táctiles (`swipe`, activado por defecto).
  - Otros métodos: `setLayers()` y `selectDay()`. Admite `label`, `feedbackId` y `CALENDAR_MARKS`.
- **El nombre corto de una barra sale solo en el primer día de cada tramo** (inicio o principio de semana). Antes se repetía cortado cada día («Estanci», «Estanci»…). Afecta a todos, Booking incluido, por decisión del usuario.
- **`createProposalList`** (sugerencias del núcleo: `pending`, `approved`, `rejected` y `withdrawn`):
  - **Modo `review`:**
    - pestañas «Pendientes N», «Aprobadas» y «Descartadas», y filtro por tipo;
    - «Aprobar» y «Descartar» **confirman siempre** con un diálogo, que lleva un comentario opcional;
    - en escritorio, detalle a la derecha (`renderDetail`); ↑ y ↓ cambian de propuesta y, al decidir, pasa a la siguiente;
    - en el móvil, el detalle sale en una hoja.
  - **Modo `mine`:** «Pendientes» y «Resueltas», con el comentario de quien decidió, «Retirar» (confirma), «Proponer» y enlace a lo creado (`link`).
  - **Datos:** con `source`, vuelve a leer al enfocar la ventana y tras decidir, o usa `subscribe`.
  - Exporta también `suggestionStatusChip` y `PROPOSAL_LIST_MARKS`.
  - No cambia el revisor de feedback de Central ni la revisión de propuestas de agentes.
- **`confirmDialog`** admite `body` (un campo debajo del texto, que recibe el foco).
- **Demo:** secciones «Calendario de persona» y «Propuestas». La sección «Calendario» se queda como estaba.
- **Pruebas:** `v39` (calendario) y `v40` (propuestas).

## 0.32.0 · 13 de octubre de 2026

**Camas con plazas fijas y supletorias** (decisión del usuario; servidor en Core #479, docs/resources/API.md §2.3).

- **Datos de la cama:** «Tipo de cama» (individual, doble, litera o **sofá cama**), **«Plazas fijas»** (`capacity`; 0 vale) y **«Plazas supletorias»** (`extra_capacity`). Ejemplos: litera partida 1 + 1, sofá cama 0 + 1. Están en los tipos de partida y en el adaptador `createSyncSpaceSource`.
- **Una cama puede ir también en una sala** (sofás cama de la Sala multiusos). El motivo al rechazarla dice «…dentro de una habitación o una sala».
- **`spaceSeats(row, rows)`:**
  - **Con camas:** `{ seats: Σ capacity, extras: Σ extra_capacity }`. Una cama sin `capacity` cuenta 1, y 0 cuenta 0.
  - **Texto:** «12 plazas + 4 supletorias».
  - **Sin camas:** la capacidad escrita, como antes.
- **Quitado `EXTRA_BED_KINDS`** (0.31.0): las supletorias ya no son un tipo de cama, sino plazas de cada cama. Nadie lo usaba todavía.
- **`createInside` no se hace** (decisión del usuario): crear y cambiar camas y espacios sigue siendo de `structure` (owner).
- **Demo:** la Hab 3 con una litera partida y la Sala multiusos con un sofá cama 0 + 1. Pruebas `v37` y `v38` al día.

## 0.31.0 · 13 de octubre de 2026

**El árbol de espacios, para que Booking no pierda nada** (sección 17 de RECURSOS.md; comparación de Booking entre su pantalla de hoy y las capturas de «después»).

- **`rowActions: (row) => [{ label, icon, onClick, feedbackId }]`:** acciones propias de la app en cada fila, a un toque.
  - Con `icon`, botón de icono de 44×44 y nombre accesible «<label>: <espacio>»; sin él, botón con texto de 44 de alto.
  - El árbol expone `tree.create(parentId, kind)` y `tree.duplicate(id)` para usarlos desde ahí. Booking: «Añadir cama» y «Duplicar» en la fila de cada habitación, como hoy.
- **Plazas calculadas:** `spaceSeats(row, rows)` → `{ seats, extras, fromBeds }` y `seatsLabel` («3 plazas + 1 supletoria»).
  - Una habitación con camas suma las de sus camas activas (`capacity` de cada una, 1 si no lo tiene).
  - Las supletorias (`bed_kind` en `EXTRA_BED_KINDS`: `supletoria`, `sofa_cama`, cuando el usuario los apruebe) van aparte.
  - Sin camas, la capacidad escrita. La fila del árbol lo enseña así.
- **«+» en una habitación** trae «Cama» como tipo. `tree.create` acepta el tipo que se quiera.
- **Fila que no estruja el nombre:** si no cabe junto a los botones (móvil, habitación con acciones de la app), los botones bajan a una segunda línea.
- La cabecera que se colaba en `despues/arbol-light.png` era de la captura (la cabecera de la demo es fija), no del componente. Capturas rehechas.
- Prueba `v38` (con `@smoke`).

## 0.30.0 · 13 de octubre de 2026

**Espacios comunes (fase R1 de RECURSOS.md).** Lo que se ve en Tasks y Booking lo enseñan sus equipos en R2, con las capturas de `coordinacion/ui/r1-espacios/`.

- **`createSpaceTree({ source, kinds, permissions: { edit, structure }, filter, feedbackId, container, storageKey })`**
  - **Niveles:** Altura › Edificio o Exterior › Espacio › Subespacio.
  - **Ver:** desplegado hasta los edificios por defecto (se recuerda con `storageKey`). Búsqueda por palabras en el nombre, el nombre público, el código o la ruta. Los datos del tipo salen en la fila, y la descripción de cada altura va de subtítulo.
  - **Migración:** grupo «Sin altura» para lo que aún no está colocado. Se pueden ver los archivados.
  - **Editar** (`edit`): ficha con nombre, nombre público, código, notas y datos del tipo. El nombre avisa si ya hay uno igual al lado (campo con sugerencias de la 0.27).
  - **Estructura** (`structure`):
    - «+» para crear dentro, con los tipos válidos;
    - asa de 44×44 para arrastrar. Encima o debajo = al lado; en el centro = dentro. En el borde de un padre posible también entra dentro. Lo no válido se marca en rojo con su motivo y no se mueve;
    - subir y bajar con botones o con las flechas en el asa;
    - «Mover a…» con el selector limitado a padres válidos;
    - «Duplicar» con lo de dentro (`createMany`);
    - «Archivar con todo lo de dentro», con el recuento. Si el servidor se niega (reservas futuras, stock o tareas abiertas), se enseña su motivo tal cual;
    - «Recuperar».
- **`createSpacePicker({ source | rows, multiple, value, onChange, kindFilter, filter, quick, recentKey, feedbackId })`**
  - **A un toque:** los más usados (`quick`, los da la app) o, si no, los recientes del navegador.
  - **Búsqueda:** sin mayúsculas ni tildes, por palabras y también por la ruta. Primero los nombres que empiezan por lo buscado. Cada resultado lleva su ruta y su tipo. Teclado: flechas, Intro y Escape.
  - **Elegidos:** chips con la ruta corta («Albergue › Hab 3») y «×».
  - **Filtro:** por tipos o con una función (p. ej. solo lo reservable).
- **Modelo y reglas** (`src/spaces/model.ts`):
  - **Forma de la fila:** `SpaceRow` (`{ id, parentId, kind, name, publicName, code, position, active, notes, attributes }`).
  - **Tipos:** `DEFAULT_SPACE_KINDS` (§11.1, con los padres y los datos de cada tipo) mientras `resources-api` no dé `space_kinds`.
  - **Reglas** (`canPlace`): el tipo fija el nivel; una altura solo en la raíz; una cama solo en una habitación; una ubicación en almacén, cocina, instalación, comedor u otro; sin ciclos; edificio o exterior en la raíz solo durante la migración.
  - **Ayudas:** `spacePath`, `spaceDescendants` (para filtrar con lo de dentro), `spaceMatches` y `nextAltura`.
  - **Fuente de datos** (`SpaceSource`): `{ list, subscribe, create, createMany, update, archive, restore }`.
  - **Demo:** `createMemorySpaceSource` y `demoSpaces` (las cinco alturas del usuario con su descripción).
- **Fuente real: `createSyncSpaceSource(resources)`.** Es un adaptador sobre el `sync-client` del módulo `resources` (docs/resources/API.md, #473):
  ```ts
  const resources = createSyncSpaceSource(createSyncClient({ app: 'resources', apiBase: '/api/v1/resources', sessionFrom: client, clearOnLogout: true }));
  createSpaceTree({ source: resources, permissions: { edit: role !== 'reader', structure: role === 'owner' } });
  ```
  - **Lectura:** lee el espejo local (sin red) y marca las filas sin confirmar.
  - **Escritura:** cada operación es un lote con la revisión de la fila. Archivar o recuperar con todo lo de dentro va junto, como exige `ORPHAN_CHILD`.
  - **Tipos:** salen de `resources.space_kinds` (`listKinds` y `subscribeKinds`; el árbol y el selector los usan si la app no fija `kinds`).
  - **Rechazos:** si el servidor rechaza un lote de esta fuente (`FORBIDDEN`, `INVALID_SPACE_PARENT`…), se enseña su mensaje tal cual, por `onError` o con un aviso.
  - El edificio admite también `bookable`, `capacity` y `accessible`, como el servidor.
- Marcas de feedback de todos los controles (`SPACE_TREE_MARKS`, `SPACE_PICKER_MARKS`), también en el catálogo. En español e inglés.
- **Nada existente cambia:** solo se añaden archivos, estilos `.space-*` y textos.
- Prueba `v37` (20 pruebas, con `@smoke`): reglas, búsqueda, arrastre al lado, dentro y no válido, flechas, crear, editar, duplicar, «Mover a…», archivar y recuperar, la negativa del servidor y el selector.

## 0.29.0 · 13 de octubre de 2026

- **Estrella de nivel** (petición de Central, para el nivel de las capacidades; Tasks la adoptará en P2 para la prioridad):
  - `createLevelStar({ levels, labels, value, onChange, readonly, name, showLabel, feedbackId })` → `{ element, get, set, setReadonly }`.
  - **Aspecto:** una sola estrella que se rellena por pasos, como la prioridad de Tasks. Con 3 niveles: vacía, media y llena. Mismo dorado en claro y en oscuro.
  - **Uso:** pulsar pasa al siguiente nivel y vuelve al primero.
  - **Teclado:** las flechas suben y bajan, e Inicio y Fin van a los extremos.
  - **Lector de pantalla:** el nombre accesible incluye el nivel («Nivel en fontanería: Sabe. Pulsa para cambiar…») y el cambio se anuncia.
  - **Tamaño:** objetivo táctil de al menos 44×44. Con `showLabel`, el nombre del nivel va al lado, como el botón de prioridad de la ficha de Tasks.
  - **Solo lectura:** `renderLevelStar(value, levels, label)` para filas y tarjetas (`role="img"`). `levelFill(value, levels)` da la proporción rellena.
- **Nada existente cambia:** solo se añaden un archivo, sus estilos (`.level-star*`) y textos en inglés. La prioridad de Tasks sigue como estaba.
- Prueba `v36` (con `@smoke`).

## 0.28.1 · 9 de octubre de 2026

- **Conflicto de un `call` aparcado** (p. ej. validar una factura): no lleva tabla, y la 0.28.0 la usaba para el título.
  - Ahora se pinta igual, con «Un cambio pendiente» si la app no da `rowName`, y con sus decisiones.
  - Prueba en `v35`.
- **Humo de Food (`tests/food/feedback.spec.ts:170`, en la CI fallaba 3 de 3 dentro del mismo trabajo):**
  - **Causa:** la pulsación larga medía la caja de «Nombre» nada más abrirse la hoja, a media animación. La pulsación caía unos 10 px más abajo, sobre el campo editable, y el gesto no abría el formulario.
  - **Arreglo:** el `hold` de la prueba usa `hover()`, que espera a que el elemento esté quieto.

## 0.28.0 · 9 de octubre de 2026

- **Conflictos que se pueden descartar y con nombre legible** (incidencia del usuario en Finance: «Conflictos … «1edf75e5-…»», sin manera de quitarlo):
  - **Decisiones arriba y a la vista:** las decisiones van ahora encima de la tabla de campos. Antes, en móvil, la tabla las dejaba fuera de la pantalla.
    - **«Quedarme con lo del servidor»** descarta lo tuyo (`theirs`).
    - **«Reintentar con lo mío»** reenvía tu cambio (`mine`).
    - **«Ver diferencias»** despliega la tabla, plegada por defecto (sigue en el DOM).
    - «Combinar campo a campo» sigue igual en las ediciones.
    - Los `data-choice` y las marcas de feedback no cambian; se añade `<base>.diferencias`.
  - **Título legible:**
    - `rowName(conflict)` es la etiqueta de la app (p. ej. «FVR_2026_003 · Intermodalidad de Levante»).
    - Si falta, se usa `code`/`number` · `name`/`title` de la fila.
    - Si tampoco los hay, «Un registro de {tabla}», con `tableLabels: { 'invoices.invoices': 'facturas' }`.
    - **Nunca el id.**
  - **Quién lo cambió:** con `currentUserId` (`profile.userId` del arranque), la tarjeta dice «Lo cambió otra persona.» o «Lo cambiaste tú desde otra pestaña o dispositivo.».
    - `conflictIntro(conflicts, currentUserId)` da la frase de la cabecera de la pantalla, en lugar del «Otra persona cambió lo mismo que tú» fijo.
  - Funciones exportadas: `conflictIntro`, `conflictRowName`, `conflictAuthor`. En español e inglés.
- Prueba `v35` (con `@smoke`).

Adopción (Finance, Food, Booking, Central):
```ts
el('p', null, conflictIntro(conflicts, userId)),
...renderConflicts(conflicts, { fieldLabels, show, onResolve, currentUserId: userId,
  rowName: (c) => invoiceLabel(c.current), tableLabels: { 'invoices.invoices': 'facturas', 'invoices.suppliers': 'proveedores' } })
```

## 0.27.2 · 9 de octubre de 2026

- **«Atrás» tras cerrar hojas** (FB_2026_025, regresión de la 0.27.1 que rompía el humo de Booking, `smoke.spec.ts:200`): tras abrir y cerrar tres hojas en `#/espacios`, el primer «atrás» no hacía nada.
  - Si «atrás» se salta entradas muertas y llega a la **misma pantalla** de la que se partió, sigue hacia atrás solo hasta una pantalla distinta (o la raíz).
  - Una hoja que se abre sobre la entrada muerta de otra recién cerrada **la reutiliza** en vez de apilar otra: la historia ya no crece con cada hoja abierta y cerrada.
  - La navegación nueva por fragmento se distingue de un «atrás» con la Navigation API (`navigationType`); el cambio de `history.length` queda solo como respaldo, porque falla con la historia llena (50 entradas).
- CI: un cambio en `back-navigation.ts`, `app-shell.ts`, `sheet.ts` o `dialog.ts` corre la batería completa de todas las apps.
- Pruebas `v33`: tres hojas cerradas y un solo «atrás»; en el inicio, tras cerrar una hoja, «atrás» pregunta «¿Cerrar la app?» a la primera.

## 0.27.1 · 9 de octubre de 2026

- **«Atrás» sin carreras** (FB_2026_025): el humo de Food (`smoke.spec.ts:71`) fallaba 1 de cada 4 veces.
  - Al cerrar el lanzador con Escape, el kit lanzaba un `history.back()` para quitar la entrada de la hoja. Si se navegaba justo después (`#/maquinaria`), ese «atrás» asíncrono deshacía la navegación.
  - Ahora una hoja o un diálogo cerrados por la interfaz dejan su entrada **marcada como muerta**, con `replaceState`, que es síncrono. «Atrás» se salta las muertas: desde una muerta sigue un paso más, para que una sola pulsación lleve siempre a la pantalla anterior.
  - Un `popstate` que cambia `history.length` es una navegación nueva por fragmento (Chrome lo dispara al cambiar `location.hash`), no un «atrás».
  - El módulo sigue `pushState` y `replaceState` para saber en qué entrada está.

## 0.27.0 · 9 de octubre de 2026

- **Texto con sugerencias** (petición de Booking, de su versión local para FB_2026_014; también para etiquetas de Tasks y proveedores de Finance):
  - `createSuggestField({ label, values, mode, onUse, onChange, feedbackId, attrs })` → `{ element, input, get, set, setValues, check, match }`;
  - `attachSuggestions(input, { values, mode, onUse, feedbackId })` para un campo que ya existe;
  - lista con búsqueda (`<datalist>`, valores limpios, sin repetidos y ordenados según el idioma);
  - aviso «Ya existe «X».» con **«Usar «X»»** cuando se parece salvo mayúsculas, tildes o espacios, y «Nuevo: no existe todavía.» (modo `pick`) o «Ya hay uno que se llama «X».» (modo `unique`);
  - mismo marcado que Booking (`small.hint.suggest[role=status]`, botón con `<feedbackId>_usar`). Funciones `normalizeName`, `uniqueNames`, `matchName` y `suggestMessage` exportadas. En español e inglés.
- Prueba `v34` (con `@smoke`).

## 0.26.0 · 9 de octubre de 2026

Triaje de feedback del 9-10:
- **FB_2026_025 · «atrás» dentro de la app**, sin que cada app haga nada. Lo instala `createAppShell` (`backNavigation: false` lo desactiva; `{ home }` fija el inicio); Tasks llama a `installBackNavigation()`.
  - «Atrás» vuelve a la pantalla anterior o, si no la hay (entrada directa), al inicio.
  - Desde el inicio pregunta «¿Cerrar la app?» (Cerrar / Cancelar).
  - Con una hoja, un diálogo o el composer abiertos, «atrás» los cierra primero; el composer guarda el borrador.
  - Una hoja que sustituye a otra hereda su entrada, y si la app navega con una hoja abierta, cerrarla no deshace esa navegación. `trackOverlay` exportado.
  - Sin carreras con `history.back()`, que es asíncrono. La entrada de una hoja cerrada se quita en el siguiente ciclo y solo si sigue arriba, así que «Crear menú» → `#/menus/…` en Food conserva la navegación. Una hoja nueva espera a que termine el «atrás» pendiente, y las entradas huérfanas se saltan solas.
- **FB_2026_012 · la barra del Revisor tapaba la navegación inferior.** En el móvil va encima de la navegación (cáscara del kit o `.bottomnav` de Tasks) y empuja el contenido: las dos se ven y se puede navegar.
- **FB_2026_004 · el interruptor del Revisor dejaba de verse.**
  - Más contraste en claro y en oscuro: carril con borde y blindado frente al CSS de la app.
  - `available()` ya no recuerda los fallos pasajeros (sin red, sesión arrancando), así que el interruptor vuelve. Solo recuerda «sí» o 403/404.
- **FB_2026_011 · «Idea» se llama «Duda»** (solo la etiqueta; el valor interno sigue siendo `idea`).
- Prueba `v33` (con `@smoke`).

## 0.25.4 · 8 de octubre de 2026

- **Fallo del usuario (Tasks en Android):** en el composer, «Me bloquea: no puedo seguir trabajando» salía con el texto montado junto a la casilla.
  - **Causa:** la casilla del kit usa `.field.check`, y Tasks tiene su propia `.check` para las casillas de tarea (38×44 px con `::before`) en `index.html` y `taller.css`, sin acotar. Esa regla se aplicaba también dentro de la capa del kit y estrechaba la etiqueta.
  - **Arreglo:** blindaje de `.field.check` en el kit (ancho, alto, borde, posición, fondo, color y pseudo-elementos), que gana por especificidad. Cubre también las casillas de agentes, del revisor y del selector de ámbitos dentro de Tasks.
  - En apps sin esa regla no cambia nada.
- Prueba `v32` a 390 px, con y sin la regla de Tasks. Sin el blindaje, falla.

## 0.25.3 · 8 de octubre de 2026

Lo que piden Central, Booking, Tasks y Food de la prueba común:
- **`feedbackRoundTrip` con una hoja de la app abierta:**
  - opción `before` (o `beforeTarget`): se ejecuta después de encender «Señalar» y antes del gesto;
  - **no cierra las hojas de la app con Escape**: al final apaga el modo solo si no queda ninguna abierta;
  - el objetivo por defecto se busca en la hoja abierta (si no, en `main`) y **salta lo ignorado** (`data-feedback-ignore` en él o en un ancestro) y los campos editables;
  - se exportan `setMode`, `longPress`, `simulateKeyboard` y `acceptUsageNotice`;
  - da por aceptado el aviso de medición de uso (`acceptUsageNotice: false` para no hacerlo).
- **Aviso de medición de uso:** solo sale con la pantalla libre (sin hoja, diálogo ni feedback abiertos). Si se acaba de usar el feedback, espera a la siguiente navegación, así que no tapa el lanzador al cerrar el composer.
- **Gesto sobre campos de texto:** no abre el composer **a propósito** (para no estorbar al escribir; sí sobre su etiqueta). Ahora lo dice la ayuda del interruptor y el README.
- `v31` ampliada.

## 0.25.2 · 8 de octubre de 2026

- **Formulario progresivo de los portales** («Ayuda y sugerencias») con el mismo comportamiento que el composer tras FB_2026_016/017:
  - un envío a la vez y ninguno más tras el éxito;
  - `result.id` y `result.requestId` **estables por formulario** (los mismos en cada intento mientras el contenido no cambie), para pasarlos a `POST feedback` y que el servidor deduplique;
  - al terminar, aviso («Enviado. Gracias.» o «Pendiente…»), se suelta el teclado y **se cierra la hoja del kit** que lo contiene. Con `onDone(result)`, la app decide.
- **Prueba común de los portales:** `portalHelpRoundTrip(page, { open, choices, keyboard })` en `testing/feedback-smoke.ts`. Recorre «Ayuda y sugerencias» → respuestas → enviar con doble toque → hoja cerrada → aviso visible dentro de lo visible.
- `v31` ampliada, en escritorio y en móvil con teclado: un solo reporte.

## 0.25.1 · 8 de octubre de 2026

Doble envío del feedback en Finance (FB_2026_016 y FB_2026_017, con un segundo de diferencia, desde una hoja abierta y con el teclado abierto):
- **Un solo envío por composer:**
  - «Enviar» queda bloqueado desde el primer toque hasta que el composer se cierra (antes se rehabilitaba en «Enviado», durante el cierre);
  - el `id` y el `requestId` son los mismos en cada intento mientras el contenido no cambie, así que el servidor deduplica. Si tras un fallo se cambia el texto, van nuevos, para no chocar con la huella.
- **Cierre inmediato:** tras «Enviado» se cierra enseguida y suelta el teclado.
- **Aviso dentro de lo visible:** el aviso se coloca dentro de la parte visible (`visualViewport`), así que con el teclado abierto ya no queda fuera de la vista. Con una hoja abierta, sigue saliendo bajo su cabecera.
- **Prueba común:** `feedbackRoundTrip` pulsa dos veces por defecto y admite `keyboard` (alto visible simulado); `simulateKeyboard(page, alto)` se exporta.
- `v31` cubre el caso exacto: 484×1008, hoja «Nueva factura», teclado de 1008 a 686 px y doble toque → un solo reporte, composer cerrado y aviso visible.

## 0.25.0 · 8 de octubre de 2026

- **El composer se cierra tras su envío** aunque la bandeja tenga otro reporte atascado (fallo en Finance: «el reporte llega pero la hoja no se cierra y no se ve el aviso»).
  - Antes, «Enviar» esperaba a vaciar toda la bandeja: un reporte anterior atascado (p. ej. una imagen que no termina de subir) lo dejaba en «Enviando…» indefinidamente.
  - Ahora `enqueue` envía **ese** reporte (como mucho 15 s; si no, «Pendiente de enviar») y el resto de la bandeja sigue en segundo plano.
  - Un mismo reporte nunca se envía dos veces a la vez.
  - Si el `onSent` de la app lanza un error, el reporte ya enviado no vuelve a la bandeja como fallido.
- **Prueba común para todas las apps:** `packages/ui-kit/testing/feedback-smoke.ts` → `feedbackRoundTrip(page, { target, launcher, text })`.
  - Recorrido por la interfaz: lanzador → «Señalar para comentar» → pulsación larga → enviar → **composer cerrado** → **aviso «Enviado · FB_…» visible**, dentro de la pantalla y sin estirarse.
  - Cada app lo llama desde su prueba `@smoke`.
- Prueba `v31` (con `@smoke`, a 1280×800 y 390×844, y con un reporte atascado).

## 0.24.0 · 8 de octubre de 2026

- **Fallo del usuario en PC (Tasks):** el aviso «Enviado · FB_2026_015» salía como una columna crema enorme.
  - **Causa:** el aviso del kit se montaba en `body`, fuera de la capa `.ikisai-kit`, así que le aplicaba la regla heredada de la app `.toast { bottom: 85px }`. Con una hoja abierta, el kit le ponía además un `top` en línea, y con `top` y `bottom` a la vez se estiraba.
  - **Capa global del kit para todo lo flotante:** `setKitLayer(() => capa)`, que se fija una vez al arrancar, y `kitLayer()`. La usan por defecto avisos, hojas, diálogos, paleta, composer y pines del feedback, barra y tarjeta del Revisor, barra de señalar y fantasma de arrastre. El `container` de cada pieza sigue mandando.
  - El aviso fija en línea `bottom: auto` y `height: auto` cuando sube, para que ninguna regla de la app lo estire.
- Prueba `v30`, a 1280×800 y 390×844: app normal y app con CSS heredado y capa (como Tasks).

## 0.23.0 · 8 de octubre de 2026

- **Versiones nuevas automáticas al abrir**, para todas las apps: `initAppUpdates({ isSafe, enabled, swUrl, autoApply, autoWindowMs, resumeAfterMs })` → `{ apply, check, available }`.
  - Sustituye a los `updates.ts` copiados en cada app (Booking, Central, Food, Invoices, Organizers y Guests) y mantiene su protocolo con `sw.js` (`CHECK_UPDATE_READY`, `UPDATE_READY`/`UPDATE_ABORT`, `APPLY_UPDATE`).
  - Mismo criterio que Tasks. Al abrir la app, o al volver a ella tras más de un minuto en segundo plano, si hay versión nueva y `isSafe()` (sin cola, conflicto, editor abierto ni fallo de sincronización), **se aplica sola**: dentro de 15 s y antes de la primera interacción.
  - Si no, se queda el aviso de siempre (`ikisai:update-available`).
  - `shouldAutoApply` exportada.
- Prueba `v29` (con un service worker simulado).

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
