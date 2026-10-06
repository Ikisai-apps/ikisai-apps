# Food · estado

Actualizado: 6 de octubre de 2026. **Backend del recorrido F–H en `main`. Interfaz: esqueleto con login, Recetario con foto y Maquinaria.**

## Hecho

- `docs/food/API.md`: modelo, procedimientos, hooks, rutas, proyecciones, archivos, pantallas, offline, aceptación F–H y reparto. Aprobado por Core con sus seis decisiones (`API.md` §14.1).
- Backend (PR 15, 19, 24, 29, 32): `supabase/functions/_domain/food/`, `food-api`, migraciones `20261006_0100` a `0130` (catálogo, menús, estados y avisos, compra y preparación), eventos por `booking.food_event_projection`.
- Retirada de la vista de pruebas de eventos: migración `20261006_0140_food_retire_event_stub.sql`.
- `packages/domain-food`: reexporta `_domain/food` para Vite.
- `apps/food`: PWA con login sobre `@ikisai/ui-kit` y las cinco entradas (Inicio · Eventos · Menús · Recetario · Maquinaria); service worker con activación coordinada, conflictos y lotes rechazados, como `apps/invoices`.
  - **Recetario**: rejilla de tarjetas con foto, búsqueda y filtros (categoría, dieta, alérgeno, estado), ficha en lectura y edición por bloques (Foto, Presentación, Ingredientes, Cocina, Seguridad, Maquinaria). Un ingrediente nuevo se crea en el mismo lote que la línea que lo usa. Papelera: la receta se va y vuelve con sus líneas.
  - **Foto**: se recomprime en el dispositivo a 1600 px y a una miniatura de 480 px (WebP, o JPEG si el navegador no codifica WebP); el original no se guarda. Viaja con el marcador `$blob`, así que puede hacerse sin red. Se guarda en Cache Storage para verla sin conexión y se borra al cerrar sesión.
  - **Maquinaria**: lista, edición y papelera.
- Pruebas: 42 en PGlite (`tests/food/*.test.ts`, ya en la CI) y una de extremo a extremo en Playwright (`tests/food/smoke.spec.ts`) con una API falsa propia: login, receta con ingrediente nuevo y foto, edición sin red, sincronización y papelera.

## Pendiente

- Eventos y Menús en la interfaz: lista de eventos con su caché local, constructor de menú, avisos de restricciones, validación y aviso de evento cambiado.
- Compra, Preparación, vista de cocinero y vista del organizador con impresión.
- Inicio con los eventos próximos y lo que falta por preparar (hoy enseña accesos y estado del dispositivo).
- Escenarios offline restantes de `API.md` §11.2 y recorrido de aceptación en Android.
- `food.stock_entries`: en G4, con la proyección de compras de Invoices.

## Bloqueos

- Ninguno.

## Notas

- Las migraciones de Food las aplica el release de Core; `food.ikisai.com` lo ata Core tras la primera release con `apps/food`.
- Al reemplazar o quitar una foto, la app deja de referenciar el archivo y no lo borra (decisión de Core sobre P6).
- La comprobación de tipos de `apps/food` no está en la CI (P13): `npm run typecheck -w @ikisai/food`.

Peticiones abiertas: `docs/food/PETICIONES.md` (P12, P13).
