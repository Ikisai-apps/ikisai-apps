# Food · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 aprobada de forma provisional por Core. En construcción.**

## Hecho

- `docs/food/API.md`: modelo, procedimientos, hooks, rutas, proyecciones, archivos, pantallas, offline, aceptación F–H y reparto. Aprobado por Core con sus seis decisiones (`API.md` §14.1).

## En curso

- Base de backend: `supabase/functions/_domain/food/`, migración `food_catalog` (recetas, ingredientes, maquinaria) y `food-api` sobre `_kit` con conformidad.

## Pendiente

- Vertical de menú (migración `food_menus`, lectura de eventos, estados, avisos), vertical de compra y preparación, y `apps/food` con `@ikisai/ui-kit`.
- Core publicará `food.ikisai.com` cuando exista el esqueleto con login.

## Bloqueos

- Ninguno para la base ni para el recetario.
- `food_menus` lleva FK a `booking.events`, que todavía no existe en la secuencia de migraciones (P7). Mientras Booking no publique su proyección se usa una vista de pruebas en `food`.

Peticiones abiertas: `docs/food/PETICIONES.md`.
