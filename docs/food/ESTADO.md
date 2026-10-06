# Food · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada de forma provisional por Core. En construcción.**

## Hecho

- `docs/food/API.md`: modelo, procedimientos, hooks, rutas, proyecciones, archivos, pantallas, offline, aceptación F–H y reparto. Aprobado por Core con sus seis decisiones (`API.md` §14.1).

- Base de backend y catálogo: `supabase/functions/_domain/food/` (vocabularios, unidades, validación), migración `20261006_0100_food_catalog.sql` (recetas, ingredientes, maquinaria, reglas de fila y proyecciones para Invoices) y `food-api` sobre `_kit`. Conformidad del núcleo en verde y 13 pruebas propias en `tests/food/`.

## Pendiente

- `packages/domain-food` (reexporta `_domain/food`) y `apps/food`: añadir un workspace cambia `package-lock.json`, que es de la raíz; irán en una PR con visto bueno de Core.
- Vertical de menú (migración `food_menus`, lectura de eventos, estados, avisos), vertical de compra y preparación, y `apps/food` con `@ikisai/ui-kit`.
- Core publicará `food.ikisai.com` cuando exista el esqueleto con login.

## Bloqueos

- Ninguno para el recetario.
- Las pruebas de `tests/food/` todavía no corren en la CI (P9); se ejecutan en local con `npx tsx --test tests/food/*.test.ts`.
- `food_menus` lleva FK a `booking.events`, que todavía no existe en la secuencia de migraciones (P7). Mientras Booking no publique su proyección se usa una vista de pruebas en `food`.

Peticiones abiertas: `docs/food/PETICIONES.md`.
