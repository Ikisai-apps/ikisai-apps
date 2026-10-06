# Booking · estado

Actualizado: 6 de octubre de 2026. Rama `booking/api-doc`. **Puerta G2 pendiente de revisión de Core.**

## Hecho

- `docs/booking/API.md`: modelo de datos, procedimiento `booking.confirm_reservation`, validación, visibilidad de huéspedes, rutas propias, proyección para Food, Calendar con cuenta de servicio, pantallas, offline, aceptación y reparto.
- Decisiones del usuario del 6 de octubre incorporadas a `API.md` (§14): día de salida incluido en Calendar; conservación de huéspedes tres años (art. 5.3 del RD 933/2021, verificado en el BOE); importes en `booking.reservation_finance`, fuera del alcance de `reader`; `guests` ampliada a la lista del anexo I del decreto; Apps Script y calendario sin uso (sin corte que coordinar); prueba real sobre «Agram Camp - Reservas».
- Segunda ronda de decisiones, también incorporada: no se guardan número de tarjeta ni IBAN; las firmas del parte se recogen en pantalla o en papel (`API.md` §2.3.2); se empieza de cero, sin carga desde C03 (P11 retirada). Los campos obligatorios de SES.Hospedajes salen de la especificación oficial del servicio web v3.1.2.

## Pendiente

- Revisión y aprobación de Core (G2).
- Respuesta a las peticiones de `API.md` §13 (P1–P10, P12 y P13).
- Sin verificar: a partir de qué edad firma el huésped (regla por defecto: 14 años).
- Tras la aprobación: fases B1–B4 (`API.md` §12).

## Bloqueos

- **P1**: una Edge de app no puede invocar funciones de su propio schema (PostgREST solo expone `public` y el lint prohíbe wrappers `public.*` en migraciones de app). Bloquea Calendar, `guest-summary` y la lectura de la proyección.
- **P2**: el despliegue no empaqueta `packages/domain-booking` con la función.
- Nada de código hasta que Core apruebe el documento.
- **CI en rojo en la PR 3, por una causa ajena a Booking**: `npm ci` falla en `checks.yml` porque el `package-lock.json` de `main` no incluye los workspaces `@ikisai/invoices@0.1.0` y `@ikisai/sync-client@0.1.0`. Falla igual en las PR 1 (Food) y 2 (Invoices). El archivo es de Core; se arregla regenerando el lock en `main` (`npm install`) y relanzando los checks.
