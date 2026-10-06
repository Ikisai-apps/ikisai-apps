# Food · estado

Actualizado: 6 de octubre de 2026. **Backend e interfaz del recorrido F–H completos y publicados en `food.ikisai.com`.**

## Hecho

- `docs/food/API.md`: modelo, procedimientos, hooks, rutas, proyecciones, archivos, pantallas, offline, aceptación F–H y reparto. Aprobado por Core con sus seis decisiones (`API.md` §14.1).
- Backend (PR 15, 19, 24, 29, 32): `supabase/functions/_domain/food/`, `food-api`, migraciones `20261006_0100` a `0130` (catálogo, menús, estados y avisos, compra y preparación), eventos por `booking.food_event_projection`.
- Retirada de la vista de pruebas de eventos: migración `20261006_0140_food_retire_event_stub.sql`.
- `packages/domain-food`: reexporta `_domain/food` para Vite.
- `apps/food`: PWA con login sobre `@ikisai/ui-kit` y las cinco entradas (Inicio · Eventos · Menús · Recetario · Maquinaria); service worker con activación coordinada, conflictos y lotes rechazados, como `apps/invoices`.
  - **Recetario**: rejilla de tarjetas con foto, búsqueda y filtros (categoría, dieta, alérgeno, estado), ficha en lectura y edición por bloques (Foto, Presentación, Ingredientes, Cocina, Seguridad, Maquinaria). Un ingrediente nuevo se crea en el mismo lote que la línea que lo usa. Papelera: la receta se va y vuelve con sus líneas.
  - **Foto**: se recomprime en el dispositivo a 1600 px y a una miniatura de 480 px (WebP, o JPEG si el navegador no codifica WebP); el original no se guarda. Viaja con el marcador `$blob`, así que puede hacerse sin red. Se guarda en Cache Storage para verla sin conexión y se borra al cerrar sesión.
  - **Maquinaria**: lista, edición y papelera.
  - **Eventos**: lista de la proyección de Booking (próximos, sin menú, pasados) con caché local en `ikisai-food-cache-v1` y la fecha de los datos; ficha del evento con sus restricciones y alta del menú con la propuesta de servicios del régimen. Funciona sin red con lo último leído.
  - **Menús**: lista y ficha del menú con el evento y las restricciones siempre a la vista, avisos calculados en el dispositivo, constructor por días (servicios, hora, platos desde el recetario visual, raciones, orden a mano guardado en `position`: los platos con la lista reordenable del kit —arrastre, teclado y subir/bajar— y los servicios con subir y bajar), estados, validación aceptando los avisos uno a uno y aviso de evento cambiado con lo que cambió («Personas: 22 → 25»). Las acciones de servidor piden conexión y vacían antes la cola.
  - **Compra** (pestaña del menú): generar y regenerar con red; sin red, «en casa» (recalcula «comprar»), «comprar» fijado a mano con vuelta a lo calculado, comprado y recibido, y líneas a mano. Aviso cuando el menú o sus recetas cambian; lista revisada y cerrada.
  - **Preparación** (pestaña del menú): propuesta por plato con red; sin red, marcar hecho, responsable, reescribir un paso (pasa a propio) y pasos propios. Aviso cuando el menú cambia.
  - **Vista de cocinero**: cada plato con sus ingredientes escalados a las raciones, alérgenos, maquinaria y elaboración.
  - **Organizador** (pestaña del menú): hoja en A4 sobre la página imprimible del kit 0.5, con «Imprimir / Guardar PDF». Solo lo público: retiro, fechas, servicios por día en el orden fijado a mano, foto, nombre y descripción públicos, dietas y alérgenos. Marca «BORRADOR» si el menú no está validado.
  - **Cierre**: notas del menú y cierre de cocina, editables también con el menú validado.
  - **Inicio**: próximos eventos con el estado de su menú, sus restricciones, su compra y su preparación.
- Kit 0.3 adoptado: `compressImage` para las fotos y `parseQuantity`/`formatQuantity` para las cantidades.
- Pruebas: 42 en PGlite (`tests/food/*.test.ts`) y cuatro de extremo a extremo en Playwright con una API falsa propia: `smoke.spec.ts` (receta con foto, sin red, sincronización, papelera), `menus.spec.ts` (recorrido G–H: evento, menú, orden a mano, avisos, validar, hoja del organizador con PDF en A4, cambio del evento, reabrir y validar de nuevo) `planning.spec.ts` (vista de cocinero, compra, preparación y cierre, con sus casos sin red) y `offline.spec.ts` (dos dispositivos: fusión automática en preparación, conflicto con decisión en compra y rechazo `MENU_LOCKED` sin bloquear la cola).

## Pendiente

- Arrastre también para los servicios: la lista reordenable del kit no admite listas anidadas (los platos van dentro de cada servicio), pedido a UI.
- Recorrido de aceptación en un Android real y con una cuenta real (hasta ahora todo se ha probado con Playwright y una API falsa, y con PGlite).
- `food.stock_entries`: en G4, con la proyección de compras de Invoices.

## Bloqueos

- Ninguno.

## Notas

- Las migraciones de Food las aplica el release de Core; `food.ikisai.com` lo ata Core tras la primera release con `apps/food`.
- Al reemplazar o quitar una foto, la app deja de referenciar el archivo y no lo borra (decisión de Core sobre P6).

Peticiones abiertas: `docs/food/PETICIONES.md` (P12, aceptada para `sync-client` 0.3).
