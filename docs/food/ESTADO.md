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
- Pruebas: 44 en PGlite y en `domain.test.ts` el cálculo de coste (`tests/food/*.test.ts`) y cuatro de extremo a extremo en Playwright con una API falsa propia: `smoke.spec.ts` (receta con foto, sin red, sincronización, papelera), `menus.spec.ts` (recorrido G–H: evento, menú, orden a mano, avisos, validar, hoja del organizador con PDF en A4, cambio del evento, reabrir y validar de nuevo) `planning.spec.ts` (vista de cocinero, compra, preparación y cierre, con sus casos sin red) y `offline.spec.ts` (dos dispositivos: fusión automática en preparación, conflicto con decisión en compra y rechazo `MENU_LOCKED` sin bloquear la cola).

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
  - Falta: el descuento automático en el servidor (petición P17 a Core).
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
