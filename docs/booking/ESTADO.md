# Booking · estado

Actualizado: 6 de octubre de 2026. Rama `booking/api-doc`. **Puerta G2 pendiente de revisión de Core.**

## Hecho

- `docs/booking/API.md`: modelo de datos, procedimiento `booking.confirm_reservation`, validación, visibilidad de huéspedes, rutas propias, proyección para Food, Calendar con cuenta de servicio, pantallas, offline, aceptación y reparto.

## Pendiente

- Revisión y aprobación de Core (G2).
- Respuesta a las peticiones P1–P12 de `API.md` §13 y a las preguntas de §14.
- Tras la aprobación: fases B1–B4 (`API.md` §12).

## Bloqueos

- **P1**: una Edge de app no puede invocar funciones de su propio schema (PostgREST solo expone `public` y el lint prohíbe wrappers `public.*` en migraciones de app). Bloquea Calendar, `guest-summary` y la lectura de la proyección.
- **P2**: el despliegue no empaqueta `packages/domain-booking` con la función.
- Nada de código hasta que Core apruebe el documento.
