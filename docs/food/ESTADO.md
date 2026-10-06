# Food · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada de forma provisional por Core. En construcción.**

## Hecho

- `docs/food/API.md`: modelo, procedimientos, hooks, rutas, proyecciones, archivos, pantallas, offline, aceptación F–H y reparto. Aprobado por Core con sus seis decisiones (`API.md` §14.1).
- Base de backend y catálogo (PR 15): `supabase/functions/_domain/food/` (vocabularios, unidades, validación), migración `20261006_0100_food_catalog.sql` (recetas, ingredientes, maquinaria, reglas de fila y proyecciones para Invoices) y `food-api` sobre `_kit` con la conformidad del núcleo en verde.
- Menú, primera parte: migración `20261006_0110_food_menus.sql` (`menus` con FK a `booking.events`, `menu_services`, `menu_items`, bloqueo de menú validado o cerrado, receta en uso), rutas `GET events` y `GET events/:id`, y en el dominio la propuesta de servicios, la foto del evento y el cálculo de qué cambió.
- Menú, segunda parte: migración `20261006_0120_food_menu_procedures.sql` con `food.set_menu_status`, `food.acknowledge_event` y `food.validate_menu`, la lectura registrada `food.menu_graph`, y los avisos de restricciones (`menuWarnings`) calculados en el dominio y exigidos por la Edge al validar.

## Pendiente

- Compra y preparación: migración `food_planning`, `food.regenerate_shopping`, `food.regenerate_preparation`, `source_revisions` y casos de paridad SQL–TypeScript.
- `packages/domain-food` (reexporta `_domain/food`) y `apps/food` con `@ikisai/ui-kit`: añadir un workspace cambia `package-lock.json`, que es de la raíz; irán en una PR con visto bueno de Core. Core publicará `food.ikisai.com` cuando exista el esqueleto con login.

## Bloqueos

- Ninguno para el backend.
- Las pruebas de `tests/food/` (37) todavía no corren en la CI (P9); se ejecutan en local con `npx tsx --test tests/food/*.test.ts`.

## Notas

- **Eventos mientras Booking no publique su proyección.** `food-api` intenta leer `booking.food_event_projection` y, si Booking aún no la ha registrado para Food, usa la vista de pruebas `food.event_projection_stub` con las mismas columnas. Sus filas (`food.stub_events`, solo escribible por `owner`) describen eventos reales de Booking, porque comparten `id` con `booking.events`; así `menus.event_id` conserva su FK desde el primer día. Cuando Booking registre su vista, el cambio es automático y la tabla de pruebas se retira en otra migración.

Peticiones abiertas: `docs/food/PETICIONES.md`.
