# Food · estado

Actualizado: 6 de octubre de 2026. **Puerta G2 pendiente: `docs/food/API.md` entregado para revisión de Core.**

## Hecho

- `docs/food/API.md`: dominio, once tablas de V1 y `stock_entries` (V2), obsolescencia por revisiones, cinco procedimientos, hooks y triggers, rutas, proyecciones, archivos, pantallas, offline, aceptación F–H y reparto.

## Pendiente

- Revisión de Core y respuesta a las peticiones P1–P8 y a las seis decisiones de `API.md` §14.
- Tras la aprobación: base (migración `food_catalog`, `food-api` con conformidad, esqueleto de `domain-food` y de `apps/food`) y después los tres verticales de `API.md` §12.

## Bloqueos

- **P1** (leer la proyección de Booking desde la Edge): sin ella no hay `GET events` ni validación de menú.
- **P5 y P7** (columnas y semántica de `booking.food_event_projection`; `booking.events` antes que `food_menus`): bloquean el vertical de menú, no el de recetario.
- **P2 y P3** (errores de restricción como 422; enlace blob → `file_id` en `sync-client`): no bloquean el arranque, pero sí el offline tal como está descrito.

## Notas

- El handoff `CORE_IKISAI_APPS_V3` no está en `C:\Users\34606\Documents\Ikisai\App\CORE_IKISAI_APPS_V3`, la ruta que citan los mensajes de arranque. Solo existe como zip subido en una sesión anterior de Core. Los demás equipos lo van a necesitar en esa ruta.
