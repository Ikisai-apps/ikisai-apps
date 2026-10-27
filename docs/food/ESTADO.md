# Food · estado

Actualizado: 14 de octubre de 2026. **Backend e interfaz del recorrido F–H completos y publicados en `food.ikisai.com`.**

## Hecho

- `docs/food/API.md`: modelo, procedimientos, hooks, rutas, proyecciones, archivos, pantallas, offline, aceptación F–H y reparto. Aprobado por Core con sus seis decisiones (`API.md` §14.1).
- Backend (PR 15, 19, 24, 29, 32): `supabase/functions/_domain/food/`, `food-api`, migraciones `20261006_0100` a `0130`, `0150` y `0160` (catálogo, menús, estados y avisos, compra y preparación, orden de los pasos nuevos, procedimiento seguro para agentes), eventos por `booking.food_event_projection`.
- Retirada de la vista de pruebas de eventos: migración `20261006_0140_food_retire_event_stub.sql`.
- `packages/domain-food`: reexporta `_domain/food` para Vite.
- `apps/food`: PWA con login sobre `@ikisai/ui-kit` y las cinco entradas (Inicio · Eventos · Menús · Recetario · Maquinaria); service worker con activación coordinada, conflictos y lotes rechazados, como `apps/invoices`.
  - **Recetario**: rejilla de tarjetas con foto, búsqueda y filtros (categoría, dieta, alérgeno, estado), ficha en lectura y edición por bloques (Foto, Presentación, Ingredientes, Cocina, Seguridad, Maquinaria); dietas y alérgenos con el selector de etiquetas del kit. Un ingrediente nuevo se crea en el mismo lote que la línea que lo usa. Papelera: la receta se va y vuelve con sus líneas.
  - **Foto**: se recomprime en el dispositivo a 1600 px y a una miniatura de 480 px (WebP, o JPEG si el navegador no codifica WebP); el original no se guarda. Viaja con el marcador `$blob`, así que puede hacerse sin red. Se guarda en Cache Storage para verla sin conexión y se borra al cerrar sesión.
  - **Maquinaria**: lista, edición y papelera.
  - **Eventos**: lista de la proyección de Booking (próximos, sin menú, pasados) con caché local en `ikisai-food-cache-v1` y la fecha de los datos; ficha del evento con sus restricciones y alta del menú con la propuesta de servicios del régimen. Funciona sin red con lo último leído.
  - **Menús**: lista y ficha del menú con el evento y las restricciones siempre a la vista, avisos calculados en el dispositivo, constructor por días (servicios, hora, platos desde el recetario visual, raciones, orden a mano guardado en `position` con la lista reordenable del kit —arrastre, teclado y subir/bajar—: servicios de cada día y, anidados dentro, platos de cada servicio), estados, validación aceptando los avisos uno a uno y aviso de evento cambiado con lo que cambió («Personas: 22 → 25»). Las acciones de servidor piden conexión y vacían antes la cola.
  - **Compra** (pestaña del menú): generar y regenerar con red; sin red, «en casa» (recalcula «comprar»), «comprar» fijado a mano con vuelta a lo calculado, comprado y recibido, y líneas a mano. Aviso cuando el menú o sus recetas cambian; lista revisada y cerrada.
  - **Preparación** (pestaña del menú): propuesta por plato con red; sin red, marcar hecho, responsable, reescribir un paso (pasa a propio), pasos propios y orden a mano dentro de cada día (manda sobre la hora desde que se usa). Aviso cuando el menú cambia.
  - **Vista de cocinero**: cada plato con sus ingredientes escalados a las raciones, alérgenos, maquinaria y elaboración.
  - **Organizador** (pestaña del menú): hoja en A4 sobre la página imprimible del kit 0.5, con «Imprimir / Guardar PDF». Solo lo público: retiro, fechas, servicios por día en el orden fijado a mano, foto, nombre y descripción públicos, dietas y alérgenos. Marca «BORRADOR» si el menú no está validado.
  - **Cierre**: notas del menú y cierre de cocina, editables también con el menú validado.
  - **Coste estimado** (pestaña Menú y vista de cocinero): precio de cada ingrediente = media ponderada de sus compras de los últimos 3 meses o, si no hay, la de su última compra con aviso (decisión del usuario), con las compras reales asignadas en Invoices (`invoices.food_stock_projection`, lectura registrada), coste por plato, por servicio (desglose con `renderMoneyBreakdown` del kit 0.9) y por persona; señala los ingredientes sin precio. Las compras se guardan en la caché local para verlo sin red. También en Inicio (coste y coste por persona de cada evento próximo), en Eventos (chip «≈ N €») y en la ficha de receta (precio de cada línea y coste por ración).
  - **Inicio**: próximos eventos con cuándo son, el estado de su menú, sus restricciones (alergias destacadas), su compra y su preparación; lo ya listo lleva su marca.
- **Lanzador común** (kit 0.14, 7 de octubre de 2026): la marca de la cabecera (`#appLauncher`) abre la hoja con las apps de la cuenta (`GET /api/v1/apps`), Food marcada; sin red, la última lista guardada. Con la sesión única, abrir otra app no pide contraseña.
- **Sugerencias y QA, y uso** (kit 0.18, 7 de octubre de 2026; `coordinacion/ampliacion/FEEDBACK.md` y `USO.md`): `createFeedback`, `createFeedbackReview`, `createUsage` y `client.onSessionEnd` en `ui/shell.ts`; «Señalar para comentar», el revisor y «Sugerencias y QA» van en el panel del lanzador, sin botón propio. Todo control con significado lleva `data-feedback-id` (`food.<pantalla>.<sección>.<elemento>`, literal) y `data-feedback-label` (`ui/feedback.ts`: `fb`, `fbIgnore`, `fbRows`); `data-feedback-ignore` en lo que viene de Booking (nombre del grupo, códigos, notas, restricciones), en notas de cocina y en nombres de personas. Operaciones medidas (`app/usage.ts`): crear menú, añadir servicio y plato, validar, borrar, generar y marcar la compra, añadir línea, generar preparación, marcar hecho y guardar paso, imprimir organizador, notas y cierre, guardar receta, foto, guardar máquina y resolver conflicto. Pruebas: `feedback-ids.test.ts` (forma de los ids, etiquetas, raíces y operaciones medidas) y `feedback.spec.ts` (aviso de uso, marcas de cada pantalla, pulsación larga, envío sin el nombre del grupo, centro y `usage.run` al crear menú).
- **Peticiones a Tasks** (7 de octubre de 2026, API.md §6.1): en la ficha de una máquina limitada, averiada o fuera de servicio, «Avisar a Tasks para repararla» crea una petición `food.equipment_fault` (una por máquina y día) que Tasks enruta o deja en «Por clasificar».
- **Pruebas `@smoke`** (norma del 7 de octubre de 2026): `smoke.spec.ts` (entrada, receta con foto, sin red y sincronizar), `menus.spec.ts` (pantalla principal: evento → menú → validar) y `feedback.spec.ts` (cáscara del kit, lanzador y marcas de todas las pantallas). Son las que corre la CI cuando una PR toca algo compartido.
- **El menú en los portales** (fase 4, 8 de octubre de 2026, API.md §7.5): «Compartir con el organizador» en la ficha del menú; lectura `food.portal_menu` para Organizers y Guests (Guests solo lo confirmado), acción `food.portal_menu_comment` y lectura `food.portal_my_menu_comments`. Los comentarios llegan a Food (`food.menu_comments`) con aviso en la ficha y chip en Menús; cocina los marca vistos o resueltos y responde. Un comentario sobre un menú validado lo devuelve a «por revisar». Fotos de los platos (miniatura) por `portal-files` con el resolutor `food.portal_dish_photo` (C8).
- **Versiones nuevas** (kit 0.23, 8 de octubre de 2026): `initAppUpdates` del kit en lugar del `updates.ts` propio, con el mismo `isSafe` (`safeToUpdate`: sin editor con cambios, cola, fotos pendientes, conflictos ni sincronización en curso). Al abrir, o al volver tras más de un minuto, la versión nueva se aplica sola si es seguro; si no, queda el aviso «Nueva versión disponible».
- **Elaboración en pasos y antelación con unidad** (FB_2026_028, 13 de octubre de 2026): la elaboración se escribe en pasos y subpasos (dos niveles), reordenables y numerados 1, 1.1… en el formulario, la ficha y la vista de cocinero (`recipes.method_steps`; `method` guarda el mismo texto numerado). Lo escrito antes pasó a pasos en la migración `0193` (una línea, un paso) y, si queda alguna receta sin convertir, al abrirla. La antelación es «Sin indicar», «En el momento» o número con minutos, horas o días (hasta siete días), y se ve también en la vista de cocinero. Los subpasos se mueven sin restricción, como las tareas de Tasks: arrastrar entre pasos (dedo y ratón; a la derecha mete de nivel, a la izquierda saca), teclado sobre el asa (↑/↓ mover, → meter, ← sacar) y botones por fila; dos niveles como máximo (`apps/food/src/app/method-tree.ts`).
- **Menú de casa y plato rápido** (O3a, 13 de octubre de 2026; API.md §2.6). Antes, pruebas de caracterización de lo que había (`caracterizacion.test.ts` y `caracterizacion.spec.ts`, PR #488), que siguen en verde sin tocarlas.
  - **Menús:** el menú de casa, fijo arriba, con lo de hoy. Se crea solo al abrirlo la primera vez.
  - **Ficha del menú de casa:** «Personas en casa» (raciones por defecto), semanas de lunes a domingo con hoy marcado, «+ Comida» y «+ Cena» de un toque por día, y el constructor y la vista de cocinero de siempre. Sin restricciones, estados ni pestañas.
  - **Plato rápido:** en «Añadir plato» del menú de casa, si lo escrito no es una receta, «Añadir «…» como plato rápido» (también con Intro).
  - **Salvaguarda:** en un retiro, el plato rápido por completar sale atenuado con «Completar en el Recetario» (abre su ficha); el servidor lo rechaza igualmente.
  - **Recetario:** chip «Rápida · por completar», opción «Rápidas por completar» en el filtro Estado y aviso con «Completar» en la ficha.
  - **Inicio:** tarjeta «Hoy en casa».
  - **Compra y Preparación del menú de casa** (O3b, 14 de octubre de 2026): por los días que se eligen al generarlas, «Del … al …» con «Esta semana» y «La que viene». Hay una lista por rango, sin solaparse, y chips para abrir las anteriores. La preparación enseña y regenera solo los pasos de esos días.
  - **Platos sugeridos** (O3c, 14 de octubre de 2026): las personas de fuera con nivel `outsider` proponen desde Guests un plato para un día y un servicio (`plato_casa`). En Food, «Platos sugeridos» en Menús y un aviso en el menú de casa; al aprobar, el plato entra en ese día (con la receta del mismo nombre o una rápida por completar).
  - Pruebas: `house.test.ts`, `house-planning.test.ts` y `house-suggestion.test.ts` (PGlite), y `house.spec.ts` y `house-suggestion.spec.ts` (Playwright, con capturas a 390 px si se pide `FOOD_CAPTURAS`).
- Kit 0.3 adoptado: `compressImage` para las fotos y `parseQuantity`/`formatQuantity` para las cantidades.
- **Recetas sin foto** (27-10, F-REC-3; regla del medallón de VG): en el recetario, el selector de platos y la ficha del menú, las iniciales del plato sobre el color de su categoría (`ui/recipe-medal.ts`); Cocina usa el mismo color. Prueba: `bloque2.spec.ts`.
- Pruebas: 44 en PGlite y en `domain.test.ts` el cálculo de coste (`tests/food/*.test.ts`) y cuatro de extremo a extremo en Playwright con una API falsa propia: `smoke.spec.ts` (receta con foto, sin red, sincronización, papelera), `menus.spec.ts` (recorrido G–H: evento, menú, orden a mano, avisos, validar, hoja del organizador con PDF en A4, cambio del evento, reabrir y validar de nuevo) `planning.spec.ts` (vista de cocinero, compra, preparación y cierre, con sus casos sin red) y `offline.spec.ts` (dos dispositivos: fusión automática en preparación, conflicto con decisión en compra y rechazo `MENU_LOCKED` sin bloquear la cola).
- **Tanda 27, interfaz de una pasada** (MUELA-068, aprobada por VG el 19 de octubre de 2026; `docs/food/TANDA27_INTERFAZ.md`): menú lateral del kit, «Ahora en cocina» en Inicio, Cocina por servicios con el pase, Preparación por días, platos sugeridos con el mazo de votos y Maquinaria con su recorrido; la tabla «hoy / después / se conserva» es la referencia de lo que no se pierde.
- **«Lo mío» en Preparación** (27-10, F-PRE-2): un chip que deja solo los pasos cuyo responsable es mi nombre (o mi nombre de pila), recordado en el dispositivo; con él puesto no se ordena a mano. Prueba: `planning.spec.ts`.
- **Bloque 2** (MUELA-077, 20 de octubre de 2026; `docs/food/BLOQUE2_INTERFAZ.md`): barra con «Casa» (Despensa y Maquinaria en pestañas), Inicio con lo urgente abierto (lo caducado primero) y el resto plegado, ficha de receta comparada con el próximo servicio («Hay bastante» solo sin dudas), Despensa con las baldosas del kit 0.50 y Maquinaria con un solo «Dónde está».
- **Avisar a Tasks desde la fila** (27-10, F-MAQ-3): en Maquinaria, la máquina en «Falla» lleva «Avisar a Tasks» en su fila, con el mismo aviso que la ficha (uno por máquina y día). Prueba: `bloque2.spec.ts`.
- **Compartir desde el Organizador** (27-10, F-ORG-3): «Compartir en la pestaña Menú» abre «Portal del organizador» y señala el botón con el guiado del kit (`revealAnchor` y `pointAt`); compartir sigue en un solo sitio. Prueba: `tanda27.spec.ts`.
- **Ficha de menú y Cierre** (tanda 38, MUELA-091, 20 de octubre de 2026; `docs/food/MENU_CIERRE_INTERFAZ.md`): restricciones en una sola línea plegada encima de las pestañas (se abre sola solo en Menú, en borrador o revisar con avisos por aceptar), portada, «Lo siguiente», foco de lo que falta, menú en lectura con el ⚠ de cada plato y lo ya servido plegado, y estado, portal, comentarios y coste plegados. El Cierre suma comentarios y alérgenos, y deja «Cerrar menú» también allí (con algo pendiente, solo avisa). M1 de Cocina arreglado.
- **Avisos en la lista de menús** (27-10, F-MEN-4): cada fila en borrador o en revisar dice cuántos avisos quedan por aceptar («1 aviso»), como la tarjeta de arriba. Prueba: `menus.spec.ts`.
- **Compra «Estantería» con el envase** (tanda 40, MUELA-093, 20 de octubre de 2026; `docs/food/COMPRA_ESTANTERIA.md`): una estantería por tienda con baldosas, el envase dibujado y su hoja («Guardar en la Despensa» crea una fila de `item_units` habitual, sin cambiar el factor de otra), el carrito y el lote con «Deshacer», el dinero con «≈» y sin sumar 0 €. Regenerar ya no toca lo comprado y redondea al envase habitual (1108). H-C5 arreglado: lo comprado sigue editable y corrige la Despensa.
- **Organizador · «Revisar»** (27-10, F-ORG-4): junto a la hoja A4, una vista en una columna y sin fotos con lo mismo (día, servicio, plato y sus etiquetas) para repasarla en el móvil; se imprime siempre la hoja. Prueba: `menus.spec.ts`.

- **La carta, tanda 1: modelo, ventas y proyección para Flow** (26 de octubre de 2026; decisión de VG para el servicio del sábado 31; API.md §2.10).
  - **Migración 1109:**
    - `menus.kind = 'carta'` con `name`;
    - las tablas `food.carta_lines` y `food.carta_sales`;
    - `food.record_carta_sales`, idempotente por carta y día;
    - el coste por unidad desde el inventario;
    - `food.carta_projection`, registrada para Flow;
    - la semilla «Barra · Evento de octubre», con 8 montaditos como recetas y 5 artículos de barra.
  - **food-api** ajusta el stock de Recursos tras registrar las ventas (`carta.ts`) y ofrece `POST carta/stock` para reintentarlo.
  - **En la app**, las pantallas del menú cerrado no enseñan la carta.
  - **Prueba:** `carta.test.ts`.
- **Ficha del evento** (27-10, F-EVT-4): las restricciones van lo primero, antes de los datos, y el tipo de menú se lee «Vegetariano», no `vegetariano`. Prueba: `menus.spec.ts`.
- **La carta, tanda 2: su vista y el evento familiar** (API.md §2.10).
  - El bloque «Cartas» en Menús, con «Nueva carta».
  - `#/cartas/<id>`, con sus bloques, el precio, el coste, el margen y «Disponible».
  - «Usar en otro evento» y la carta en la ficha del evento, incluidas las que marca Booking en jornadas abiertas.
  - El evento familiar come del menú de casa.
  - **Pruebas:** `carta.spec.ts` y lo nuevo de `carta.test.ts`.

- **Previsión de la carta: modelo y lecturas** (migración 1110; API.md §2.11). Unidades esperadas, reparto mesa/nevera/fresco, estación por ingrediente, conversiones sin inventar (rodajas incluidas), `food.carta_prep_projection` y `food.carta_prep_totals_projection` para Flow, y la lista de la compra de una carta. Prueba: `carta-prevision.test.ts`. **Su pantalla:** las pestañas Previsión (reparto, unidades esperadas y plan de bandejas imprimible) y Compra de la carta. Prueba: `carta.spec.ts`.

- **Ofertas de comida por evento** (migración 1111; API.md §2.12): `food.event_offers`, la conversión de lo de hoy, `food.event_offers_projection` para Booking, `food.portal_offers` para Organizers y Guests (las internas solo a Guests, marcadas), `food.event_needs` y el bloque «Ofertas de comida» en la ficha del evento. Prueba: `offers.test.ts`.

- **Rendimiento del ingrediente** (migración 1112; API.md §2.13): «1 tomate = 8 rodajas» en el ingrediente; las cuentas de la carta y la previsión para Flow (`prep_unit`, `prep_need_total`, `purchase_unit` y `yield`); la sección «Rendimiento» en Previsión. Prueba: `carta-rendimiento.test.ts`.

- **Capacidades en el catálogo del núcleo** (migración 1113; API.md §2.14): `food.carta_prep`, `food.carta_prep_lines`, `food.event_offers`, `food.event_needs` y `food.use_carta_in_event`, con la ruta `POST carta/:id/use-in-event`. Prueba: `capability.test.ts`.

- **«Rellenar previsión» y aviso «Sin previsión»** (hueco S3 de la QA de Flow; migración 1114 con la previsión de partida de la carta de octubre; API.md §2.11).
- **Qué falta en la previsión para Flow** (encargo de Core del 28-10: rendimiento y recipientes; migración 1115; API.md §2.13): `missing`, `yield_missing` y `note` en las dos lecturas; avisos en el plan de bandejas y «Falta» en el rendimiento.
- **Lista de la compra única por evento** (encargo de Core del 28-10; migración 1117; API.md §2.15): suma el menú y las cartas del evento por tienda y pasillo, avisa de lo que no tiene lista, compra desde aquí o pide a Tasks (`tasks.request_purchase`) y marca lo que Tasks ha comprado.
- **Compra a Tasks con artículo** (opción A de Core; Tasks #874): Food manda el `item_id` de cada fila y Tasks apunta la entrada de stock al recibir. Prueba de punta a punta con la Tasks real (`tests/food/event-shopping-e2e.test.ts`).
- **Guiado mínimo del kit** (0.68, encargo de Core del 27-10): `guide: { feedbackId: 'food.cabecera.guia' }` en el shell; con `?campo=` se señala el anclaje (los `data-feedback-id` de Food) y con `?paso=` se explica y sale «Volver a…». los `<details>` cerrados los abre el kit (0.69.3) y `ui/guide.ts` cambia a la pestaña Previsión o Compra de la carta.
- **Hallazgos de las listas** (27-10): la fila de Eventos dice las restricciones en personas («1 con alergia · 2 veganos», F-EVT-1); las casillas usan el acento en tema oscuro (F-EVT-6); en Maquinaria toda la fila abre la ficha (F-MAQ-4).
- **Orden del «hoy real»** (decisión de Core del 27-10): Menús por cercanía, con los pasados aparte y plegados (F-MEN-1); Maquinaria con lo averiado o fuera de servicio arriba, luego lo limitado (F-MAQ-1). Caracterización reescrita para fijar el orden nuevo.
- **Maquinaria y su uso** (27-10, línea de Core, F-MAQ-2): la fila dice cuántas recetas la necesitan y cuántas están en menús que vienen; en la vista de cocinero del menú, cada máquina lleva su estado si no está operativa. Pendiente: un aviso del menú por máquina averiada (necesita la maquinaria en `food.menu_graph`).
- **Hallazgos de textos y avisos** (27-10): la tarjeta del recetario avisa «Alérgeno sin declarar» y el editor propone marcar los alérgenos que delatan sus ingredientes (F-REC-5); el coste de la fila de Eventos dice «faltan precios» o «precio antiguo» (F-EVT-3); en Preparación, qué hace «Regenerar» junto al botón (F-PRE-5).
- **Platos sugeridos** (27-10, línea de Core): «Ese día en casa» dice cuántos comen en cada servicio (F-SUG-1); aprobada como plato rápido nuevo, un aviso con «Completar la receta» lleva a su ficha (F-SUG-2).
- **Seguridad FO2** (auditoría del 27-10; Tasks #852): las peticiones a Tasks llevan la clave de worker y `X-Ikisai-Caller: food`.
- **Seguridad FO1** (auditoría del 27-10; migración 1118): las ofertas de visitante, por el código público del evento y sin `event_id`. Necesita que Booking añada `public_code` a `booking.food_event_projection`.
- **Seguridad FO3** (auditoría del 27-10; migración 1119): los avisos de avería (`food.equipment_notices`) solo los escribe la cuenta de servicio `food`.

## Aceptación del usuario (6 de octubre de 2026)

- Incidencia «no puedo crear un menú desde Eventos» (evento confirmado sin comidas ni régimen en Booking): corregida y publicada (PR #135). La ficha del evento ofrece siempre «Crear menú» (salvo reserva cancelada o cuenta de solo lectura, con la razón), explica qué falta en Booking con enlace, y deja elegir con qué régimen proponer los servicios o ninguno.

## Pendiente

- **R5, en preparación** (recetas con artículos de Recursos, consumo al acabar el servicio y compra con stock; RECURSOS.md §6):
  - Caracterización de lo que cambia de fuente: `caracterizacion-r5.test.ts` y `caracterizacion-r5.spec.ts` (Inicio, Maquinaria, ficha y formulario de receta, vista de cocinero, compra y alergias por nombre de ingrediente). Deben seguir en verde después de R5 sin tocarlas.
  - Vista previa de la migración de ingredientes y maquinaria a artículos: `docs/food/r5/vista_previa.sql` (solo lectura; la lanza Core en producción), probada en `r5-vista-previa.test.ts`.
  - Diseño aprobado por el usuario el 14-10-2026 (respuestas en `coordinacion/food/RESPUESTAS.md`).
  - **R5a hecho:** cada ingrediente y máquina enlazado con su artículo de Recursos, y el recetario sugiere los ingredientes de Recursos que Food aún no usa (API.md §2.7). Pruebas: `resources-link.test.ts` y `resources.spec.ts`.
  - **R5b hecho:** la compra con el stock de la cocina, el mínimo de cada artículo, el grupo «Reponer» y «comprado» al stock (API.md §3.2, paso 6b). Pruebas: `shopping-stock.test.ts` y `shopping-stock.spec.ts`.
  - **R5c hecho:** consumo al acabar el servicio: «Confirmar consumo» a las 2 h, descuento solo a las 24 h y tarjeta en Inicio (API.md §2.8). Pruebas: `consumption.test.ts` y `consumption.spec.ts`.
  - **También:** «En casa» de cada ingrediente en la ficha de receta, y en Inicio el bloque «Despensa» (bajo mínimo y lotes que caducan en 7 días), solo si se lleva inventario.
  - **Maquinaria con Recursos:** espacio de cada máquina (ruta en la lista y en el formulario de receta) y «Cantidad» como stock.
  - **Descuento a las 24 h en el servidor** (worker `consumption/tick`, migración 1100), con la app como respaldo a las 26 h. Conversiones con las reglas del kit (`itemUnitFactor`).
  - Cuenta de servicio `food` en el núcleo (0096) y `once` en `resources.consume` (0806): el worker ya trabaja, y nada se descuenta dos veces.
  - **Despensa** (18-10-2026): pestaña propia con el catálogo, la ficha, los movimientos y el recuento a ciegas del kit, «A la compra» y enlaces desde Inicio y la ficha de receta (API.md §9). Prueba: `pantry.spec.ts`.
  - Valorado y descartado por ahora: `createItemPicker` en el recetario. Cambiaría los controles caracterizados del formulario, y sus unidades («saco») no caben en `recipe_ingredients.unit`. Food usa las reglas de conversión del kit.
- Formulario para sugerir el plato: es de Guests (O4), con `houseDishSuggestionOperations` y el tipo `plato_casa`.
- Agentes de IA (núcleo, contrato §3.1): solo `food.regenerate_preparation` está marcado como seguro sin aprobación; el resto de procedimientos la exige.

- Recorrido de aceptación en un Android real y con una cuenta real (hasta ahora todo se ha probado con Playwright y una API falsa, y con PGlite).
- `food.stock_entries`: en G4, con la proyección de compras de Invoices.

## Bloqueos

- Ninguno.

## Notas

- Las migraciones de Food las aplica el release de Core; `food.ikisai.com` lo ata Core tras la primera release con `apps/food`.
- Al reemplazar o quitar una foto, la app deja de referenciar el archivo y no lo borra (decisión de Core sobre P6).

Peticiones abiertas: `docs/food/PETICIONES.md` (P12, aceptada para `sync-client` 0.3).
