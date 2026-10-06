# Respuestas de Core a los equipos

Resumen de decisiones y cambios del núcleo en respuesta a las peticiones de los equipos. Cada equipo registra las suyas en `docs/<app>/PETICIONES.md`.

## 6 de octubre de 2026 · ronda G2

### Para todos

- **Handoff V3 disponible** en `C:\Users\34606\Documents\Ikisai\App\CORE_IKISAI_APPS_V3\` (`02_HANDOFF_TECNICO_CORE_V3.md`, `03_IKISAI_INVOICE_IMPORT_V1.schema.json`, `04_EJEMPLO…json`, `08_CANON_FUNCIONAL_BOOKING_FOOD.md`, `sources/`). Quien lo escribió de memoria (Invoices: schema del JSON) debe cotejar y ajustar.
- **CI en rojo en las PR 1, 2 y 3:** no es un fallo de `main`. Esas ramas nacieron antes de que el `package-lock.json` se regenerara (PR #4). Basta con `git fetch && git rebase origin/main` y volver a hacer push. `main` tiene la CI en verde desde la PR #4.
- **Puerta G2: aprobación provisional para los cuatro equipos.** Podéis empezar a construir lo que no dependa de peticiones abiertas: paquete de dominio, migraciones de vuestras tablas (en PR separada, con lint y conformidad), rutas de lectura, pantallas. Las PR de `API.md` se fusionan en cuanto estén rebasadas y en verde; los puntos que yo discuta irán como comentarios en la PR, no bloquean.
- **Peticiones:** a partir de ahora en `docs/<app>/PETICIONES.md` (evita conflictos entre PR en `docs/core/PETICIONES.md`).
- **Código de dominio:** vive en `supabase/functions/_domain/<app>/` para que el despliegue lo empaquete con la función; `packages/domain-<app>` solo reexporta (`export * from '../../supabase/functions/_domain/<app>/mod.ts'`). Resuelve la P2 de Booking.
- **Hecho en el núcleo (PR `core/g2-nucleo`):**
  - Lecturas registradas `core.allowed_reads` + `core.allow_read()` + ruta `GET/POST /api/v1/read/:name` (contrato §5.1). Resuelve P1 de Booking, P1 de Food y (3) de Invoices: una Edge ejecuta funciones de lectura de su schema y consulta proyecciones de otras apps.
  - Errores SQL definitivos como 422 con `sqlstate` (`CONSTRAINT_VIOLATION`, `INVALID_VALUE`, `DOMAIN_ERROR`, `SQL_ERROR`), nunca 503. Resuelve C4 de Tasks y P2 de Food.
  - `RequestContext.token` (bearer del usuario) para hooks que llaman a otra API. Resuelve (1) de Invoices.
  - `POST /api/v1/members/invite`: alta de cuenta con contraseña temporal y pertenencia, solo owner. Resuelve la mitad de C7 de Tasks (la lista de sesiones queda para después).
  - Lint: las migraciones de app pueden leer `core.memberships`, `core.changes`, `core.files`, `core.synced_tables` y llamar a `core.allow_read`. Resuelve C1 de Tasks y P4 de Food. Triggers y columnas generadas: el lint no los restringe (confirmado a Invoices).
  - Despliegue de funciones incluye `_domain/<app>/`.
- **En curso en `sync-client` 0.2 (PR aparte):** marcador `{"$blob": sha}` → `file_id` (C5 Tasks, P3 Food, (2) Invoices, P13 Booking); `clearOnLogout` y borrado del espejo al cambiar de usuario (C3 Tasks, huéspedes de Booking); re-snapshot cuando cambian los ámbitos (C2 Tasks); lotes rechazados visibles con reintento o descarte en vez de desaparecer o bloquear la cola (C6 Tasks).
- **Contrato §8 ampliado:** la revisión de una proyección puede ser un contador propio del dueño; el lector puede guardar `source_revisions`. Acepta P10 de Booking y los puntos de Food sobre `event_revision` y `source_revisions`.
- **`npm:fflate` en la Edge:** sí, Supabase Edge resuelve especificadores `npm:`; el despliegue sube el TypeScript tal cual.

### Tasks

- D1 (catálogo de etiquetas para invitados por proyecto, solo lectura de toda el área): **aprobado**.
- D5 (adjuntos hasta 25 MB y lista cerrada de tipos): **aprobado**; usa `core.files` y el flujo de `uploads`.
- D6 (invitados como cuentas con ámbitos; claves solo para agentes): **aprobado**. Usa `members/invite`.
- Sube la rama y abre la PR de `docs/tasks/API.md`.

### Invoices

- Coteja §3.1, §2.12 y §11 con `03_IKISAI_INVOICE_IMPORT_V1.schema.json`, `04_EJEMPLO…` y `05_PROMPT_EXTRACCION_FACTURA.md` del handoff; el contrato de importación debe ser exactamente `ikisai.invoice.v1` (es lo que ChatGPT producirá).
- Ruta `targets` en la API de Tasks: se pide al equipo Tasks como lectura registrada o ruta propia; mientras tanto, usa `GET /api/v1/snapshot` de Tasks con el token del usuario.

### Booking

- `calendar_links` colgando de la reserva: **aprobado**. `reservation_finance` separada e invisible para `reader`: **aprobado**. Contador de proyección en vez de `events.revision`: **aprobado** (ya en el contrato).
- Decisiones del usuario incorporadas (día de salida incluido, 3 años de conservación, sin tarjeta ni IBAN, firmas en pantalla o papel, SES por especificación v3.1.2, calendario real para la prueba, arranque desde cero).

### Food

- `source_revisions` por artefacto, cinco procedimientos, `stock_entries` definida pero sin migración en V1, `allergens_checked` y miniatura: **aprobado**.
- La proyección de Booking se lee con `GET /api/v1/read/booking.food_event_projection` en cuanto Booking la registre con `core.allow_read('food', …)`.

### UI

- v0.2: **adelante**. Prioriza hoja inferior y diálogo con foco atrapado y el componente de conflicto campo a campo, que Invoices necesita primero; después lista «pendiente», selector de tema y paleta.
