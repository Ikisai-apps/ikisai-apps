# Food · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada de forma provisional por Core. Backend del recorrido F–H construido; falta la interfaz.**

## Hecho

- `docs/food/API.md`: modelo, procedimientos, hooks, rutas, proyecciones, archivos, pantallas, offline, aceptación F–H y reparto. Aprobado por Core con sus seis decisiones (`API.md` §14.1).
- Base y catálogo (PR 15): `supabase/functions/_domain/food/` (vocabularios, unidades, validación), migración `20261006_0100_food_catalog.sql` (recetas, ingredientes, maquinaria, reglas de fila y proyecciones para Invoices) y `food-api` sobre `_kit` con la conformidad del núcleo en verde.
- Menú (PR 19): migración `20261006_0110_food_menus.sql` (`menus` con FK a `booking.events`, `menu_services`, `menu_items`, bloqueo de menú validado o cerrado, receta en uso), rutas `GET events` y `GET events/:id`, propuesta de servicios y cálculo de qué cambió en el evento.
- Estados y avisos (PR 24): migración `20261006_0120_food_menu_procedures.sql` con `food.set_menu_status`, `food.acknowledge_event` y `food.validate_menu`, la lectura registrada `food.menu_graph` y los avisos de restricciones (`menuWarnings`), exigidos por la Edge al validar.
- Eventos por la proyección real de Booking (PR 29): `food-api` lee `booking.food_event_projection`; las pruebas siembran reservas, eventos y restricciones en `booking.*`.
- Compra y preparación (PR 32): migración `20261006_0130_food_planning.sql` (`shopping_lists`, `shopping_list_items`, `preparation_items`, `food.regenerate_shopping`, `food.regenerate_preparation`) y `planning.ts` en el dominio, con paridad comprobada entre el cálculo SQL y el de TypeScript y obsolescencia por conjunto de revisiones.

## Pendiente

- `packages/domain-food` (reexporta `_domain/food`) y `apps/food` con `@ikisai/ui-kit` (Inicio · Eventos · Menús · Recetario · Maquinaria). Añadir un workspace cambia `package-lock.json`, que es de la raíz: la PR del esqueleto con login necesita el visto bueno de Core, que después publicará `food.ikisai.com`.
- Cachés de eventos y de fotos, recompresión de fotos en cliente, vista del organizador con impresión y pruebas Playwright offline (`API.md` §10 y §11.2).
- `food.stock_entries`: en G4, con la proyección de compras de Invoices.

## Bloqueos

- Ninguno para seguir.
- **Las 42 pruebas de `tests/food/` no corren en la CI (P9, urgente).** Se ejecutan en local con `npx tsx --test tests/food/*.test.ts`.

## Notas

- **Incidencia del 6 de octubre.** Al fusionarse la proyección de Booking, 7 de las entonces 37 pruebas de Food quedaron en rojo en `main`: sembraban la vista de pruebas y `food-api` ya leía la real, como estaba previsto. La CI siguió en verde porque no ejecuta `tests/food/`. Corregido en la PR 29.
- La vista de pruebas `food.event_projection_stub` y su tabla `food.stub_events` ya no se usan; siguen en el schema, vacías y solo visibles para `owner`, hasta que Core ofrezca cómo dar de baja una tabla registrada (P11).
- Ninguna migración de Food está aplicada todavía en Supabase: eso lo hace el release de Core.

Peticiones abiertas: `docs/food/PETICIONES.md` (P6, P8, P9, P10, P11).
