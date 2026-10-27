# Booking · estado

Actualizado: 26 de octubre de 2026. **Las cuatro pantallas construidas, Calendar real probado contra Google por Core y escenarios sin red automatizados; falta el recorrido de aceptación del usuario en producción.**

## Hecho

- `docs/booking/API.md` (PR 3): modelo, validación, visibilidad, rutas, proyección, Calendar, pantallas, offline y aceptación; decisiones del usuario en §14.
- **B1 · reservas base** (PR 16): migración `20261006_0005_booking_base.sql`, `booking.confirm_reservation`, `_domain/booking`, `booking-api`.
- **B2 · huéspedes y proyección** (PR 20): migración `20261006_0006_booking_guests.sql`, `booking.food_event_projection` con `core.allow_read` para `food` y `booking`, `booking.guest_summary`.
- **Esqueleto de `apps/booking`** (PR 28): login, shell, Inicio y Reservas sin red, PWA.
- **Tanda 4** (PR 40): ficha de la reserva, papelera en cascada con restauración, Huéspedes (datos del anexo I, firma en pantalla o en papel, cola de SES), checklist, y cola de Calendar con adaptador falso (migración `20261006_0400_booking_calendar.sql`).
- **Tanda 5** (PR 52):
  - **Calendar real**: `booking-api/calendar/google.ts` con cuenta de servicio (JWT RS256 con WebCrypto, token en memoria, API v3). Se activa solo con los secretos `GOOGLE_SERVICE_ACCOUNT_JSON` y `BOOKING_CALENDAR_ID`.
  - **Bloqueo por acceso** (migración `20261006_0401_booking_calendar_blocked.sql`): con credenciales rechazadas o el calendario sin compartir, el trabajo sigue `pending` sin gastar intentos, con código legible, y el tick hace un solo intento por vuelta. `calendar/status` lo expone como `health`.
  - **Cómo avanza la cola**: `afterCommit` tras cada guardado, el planificador de Core cada 5 minutos en `POST /api/v1/worker/calendar/tick`, y `POST calendar/tick` a mano.
  - Si Google ya no acepta el id de un evento (borrado a mano), el worker sube la generación y lo crea de nuevo.
  - **Pantalla Calendario**: vista mensual con `createCalendar` del kit, sin franjas horarias, tramos de día completo que incluyen el día de salida y colores por estado; panel «Google Calendar» con el estado, pendientes, errores y «Reintentar».
  - **Ficha**: en móvil quedan visibles «Editar» y «Confirmar» y el resto pasa a un menú «Más»; icono de la app `bed`.
  - **Huéspedes**: justificante de envío a SES como archivo (PDF o imagen recomprimida) con marcador `$blob`; restricciones alimentarias desde la ficha del huésped.
  - Limpieza de `reservations.ts` (la hoja de alta ya no arrastra la edición).
  - Pruebas: `tests/booking/*.test.ts` 57 de 57; humo de Playwright ampliado a Calendario, justificante, restricción del huésped y menú «Más».

- **Tanda 6** (PR 77):
  - Pastilla de Calendar en la cabecera de la ficha (misma caché que la pantalla Calendario).
  - Confirmar sin red: marca «Confirmación pendiente de enviar», aviso con el motivo si el servidor la rechaza, y retirada de marcas huérfanas.
  - Huéspedes: hoja «Datos para SES» con un botón Copiar por dato (viajero y transacción); aviso en Inicio de huéspedes sin comunicar a SES cuando el evento empieza en menos de 24 horas.
  - Escenarios sin red en Playwright (`tests/booking/offline.spec.ts`): O1 crear sin red y recargar, O3 confirmar sin red (y rechazo), O4 conflicto disjunto, O5 conflicto solapado, O6 firma diferida, O7 borrado local al cerrar sesión, más el aviso de Inicio. O2 (editar sin red) ya estaba en el humo.
  - `docs/booking/ACEPTACION.md`: recorrido paso a paso para hacerlo con la cuenta del usuario en producción.
  - Prueba real de Calendar contra Google: hecha por Core, 12 de 12 (ronda 5).

- **Tanda 7** (PR 84): botón «Vaciar papelera» para el propietario en Reservas → Papelera, con recuento y confirmación; llama a `POST trash/purge` con las tablas de hijos a padres y explica los dos motivos por los que puede negarse (evento aún vivo en Google Calendar, menú de Food ligado al evento). Probado en el humo y, sobre PGlite, con una reserva completa (evento, huésped, restricción, checklist).
- **Invoices lee `booking.food_event_projection`** (PR 80): migración `20261006_0402_booking_invoices_read.sql`, fusionada junto con el ajuste de la prueba de Invoices.
- **Tanda 8** (PR 94):
  - **Checklist reordenable** con `createSortableList` del kit: al mover una tarea solo viaja ese ítem (`position` entre sus vecinos); se renumera la lista entera solo si no hay hueco.
  - **Bloque «Coste real»** en Cobro (solo quien ve importes): total asignado en Invoices a la reserva y a su evento, desglose por categoría y asignaciones con su código de factura, leído de `invoices.booking_cost_projection`. Última respuesta guardada en el dispositivo y borrada al cerrar sesión.
  - Retirado el parche `[hidden]` (lo trae el kit 0.8.0).
- **Tanda 9** (PR 102): las listas reordenables del checklist se conservan entre repintados y se actualizan con `setItems`; el foco del asa se recupera tras cada guardado. El humo prueba el reorden con teclado (foco conservado) y con arrastre de ratón.
- **Tanda 10** (PR 109):
  - «Coste real» con `renderMoneyBreakdown` del kit 0.9.0: total frente a lo presupuestado (marca «excede»), una línea por categoría con su número de facturas y enlace a las compras de la reserva en Invoices; cada asignación enlaza a su factura (`#/facturas/<código>`).
  - Agentes de IA: hook `agentRisk` (cancelar o dar por perdida una reserva, archivarla, tocar huéspedes o importes exigen aprobación humana) y `booking.calendar_retry` marcada segura (migración `20261006_0403_booking_agent_safe.sql`).
  - O1 baja a 15 s de margen con `sync-client` 0.2.3.
  - El arnés de Playwright pide un puerto libre al sistema: un puerto al azar caía a veces en los rangos que Windows reserva (`EACCES`) y era la intermitencia que se veía de vez en cuando.

- **Tanda 11** (PR 116): prueba de agentes de extremo a extremo (`tests/booking/agents.test.ts`): alta del agente por el owner, política con `booking.calendar_retry` segura, lo cotidiano sin aprobación, 428 con el motivo al confirmar, cancelar o tocar importes, y confirmación aplicada con propuesta aprobada.

- **Tanda 12** (rama `booking/tanda-12`, incidencia del usuario en Android, V1): al confirmar, el registro del procedimiento (`call`, sin id) que devuelve el servidor no se podía guardar en IndexedDB y el lote se atascaba con «2 pendientes». La causa está en `sync-client` y la corrige Core (0.2.5, PR #133). Por parte de Booking: los fallos del dispositivo se avisan con «No se pudo guardar en este dispositivo. Reintenta; si sigue, cierra y abre la app» y el texto técnico plegado; la API falsa de las pruebas devuelve ese registro como el servidor real (por eso el humo no lo había visto), y el humo confirma y recarga. Con el `sync-client` de `main` el humo falla igual que el móvil; con la PR #133 pasa.

- **Ampliación V2 · bloque 1: espacios y alojamiento** (rama `booking/espacios`; diseño en `API.md` §15, que vive en la PR 142): migración `20261006_0410_booking_spaces.sql` con `booking.spaces` (código `ESP_…`), `booking.beds` y `booking.room_assignments`; hook SQL `booking.check_space_invariants` (huérfanos, cama de otro espacio, huésped de otro evento y la regla dura `BED_OVERBOOKED`: una cama, una ocupación por noche entre reservas vivas; la salida de uno puede ser la entrada del siguiente); vista `booking.tasks_space_projection` para Tasks (sin ocupación ni huéspedes). Interfaz: pantalla «Espacios y camas» (inventario por zonas, reordenable, camas por habitación) y bloque «Alojamiento» en la ficha (asignar huésped o grupo, aviso de sobreocupación que no bloquea, aviso previo de cama ocupada también sin red). Pruebas: `tests/booking/spaces.test.ts` y pasos nuevos en smoke y offline.

- **Ampliación V2 · bloque 2: personal en eventos** (rama `booking/personal`, sobre la de espacios; diseño en `API.md` §15.3): migración `20261006_0430_booking_staff.sql` con `booking.staff_assignments` (solo el nombre de la persona; función de C05; día opcional; horas previstas y reales no negativas y como máximo 24 en un turno de un día; enlace tipado futuro a Central (`person_ref_app = 'central'`, migración 0431)) y `booking.staff_needs` (refuerzos que se cubren a mano); hook `booking.check_staff_invariants` (sin huérfanos); vista `booking.invoices_staff_hours_projection` para Invoices **sin nombres** (`staff_ref` estable). Interfaz: bloque «Personal» en la ficha (turnos por día reordenables, totales, refuerzos con cambio rápido a cubierto), fila «Personal» en Operación, aviso de turnos sin horas reales al anotar el cierre y aviso en Inicio de refuerzos sin cubrir en 7 días. Horas reales las apunta el responsable al cerrar (propuesta (a), a la espera del usuario). Pruebas: `tests/booking/staff.test.ts` y pasos en smoke y offline.

- **Ampliación V2 · bloque 3: tarifas y propuestas** (rama `booking/tarifas`, sobre la de personal; diseño en `API.md` §15.2 y decisiones en §15.6): migración `20261006_0420_booking_rates.sql` con `booking.rates` (código `TAR_…`, cuatro capas de C03 más `extra`; solo el owner escribe), `booking.conditions` (señal, plazos, IVA incluido 10 % por defecto, una por defecto) y `booking.cancellation_tiers` (inmutables si una propuesta enviada usa las condiciones: `CONDITIONS_IN_USE`), `booking.proposals` versionadas y `booking.proposal_lines` (descuento en % por línea). Una propuesta enviada es inmutable (`PROPOSAL_LOCKED`); `booking.new_proposal_version`, `booking.send_proposal` (fija totales y señal en SQL, igual que `proposalTotals` del dominio) y `booking.accept_proposal` (único punto que escribe `final_amount`, `deposit_required` y, si faltaba, `budget_amount`). Interfaz: `#/tarifas` (tarifas por capa, extras, condiciones y tramos), bloque «Propuesta» en la ficha, editor con «Sugerir desde el tarifario» y «Añadir extra» (las supletorias activadas se sugieren solas), y documento A4 para el organizador con «Imprimir / Guardar PDF». Las cinco tablas se borran del dispositivo al cerrar sesión. Pruebas: `tests/booking/rates.test.ts` y pasos en smoke y offline.
- **Espacios, ajustes de la ronda 18:** `spaces.bookable` («No reservable»), supletorias fuera de la capacidad base, alta de una habitación con N camas y M supletorias en un lote, «Duplicar» y «Crear distribución inicial» (6 habitaciones, 58 camas, con confirmación).

- **Portales, parte 1 (#191):** caducidad de los enlaces ligada a la reserva (`booking.portal_link_valid_until`, migración 0432), `portalIssuer` en `booking-api` y bloque «Portal del organizador» en la ficha. Parte 2 (datos de huéspedes) en propuesta: `API.md` §16 (PR #188).
- **Entidad en la propuesta:** `GET /api/v1/entity` lee `central.common_entity_projection` y firma el logotipo (bucket privado de Central, 10 min, sin guardarlo); el documento para el organizador lleva cabecera con logotipo, razón social, NIF/CIF y domicilio, o el aviso «Faltan los datos de la entidad en Central».

- **Portales, parte 2 · datos de huéspedes (§16, migración 0433):** procedencia por campo, consentimiento, aviso legal y firma solo del huésped, declaración del organizador, lecturas y acciones para Organizers y Guests (con `core.apply_portal_operations` y `core.portal_revoke_scope`), baja por el organizador en cualquier momento salvo entrada o SES, y `GET /api/v1/guest-signature/:guestId`. Interfaz del personal en Huéspedes: completitud según el modo de la reserva, origen de cada dato (huésped, organizador, personal), consentimiento y aviso legal, «Copiar recordatorio» al huésped y al organizador, «Ver firma» de Guests y papelera de huéspedes con «Dado de baja por el organizador».

- **SES.HOSPEDAJES, paso 1 (§17):** interruptores por reserva (migración 0440; bloque «Registro de viajeros» en la ficha, modos `ses`/`operativo`/`ninguno` en huéspedes y portales), ajuste global PRE/PROD y «Pausar envíos» (`#/ses`, solo owner), y cliente SES-1 (`_domain/booking/ses/`, validado contra los XSD oficiales; transporte con el intermedio de la FNMT; `POST /api/v1/worker/ses/ping` para comprobar TLS en la Edge). **SES-2 (migración 0441):** «Comunicar reserva a SES» con botón cuando hay pago registrado (`payment_registered_at` = momento legal), estados (preparada, en proceso, aceptada con código, rechazada con el texto de SES, anulada, error con reintento), pausa, anulación, aviso de cambio de fechas o personas, avisos de 12/18/24 h en la ficha y en Inicio, y aviso a Tasks (`booking.ses_deadline`, prioridad `critical`) a las 12 h; `POST /api/v1/worker/ses/tick` para el planificador. Pendiente: crear la cuenta de servicio con `ensureServiceActor` cuando esté en el kit; SES-3 hecho: llegada (`arrived_at`), «Documento comprobado» (a la vista, sin copia), parte de viajeros con los huéspedes listos (datos de SES, documento si es adulto, firma desde 14 años), «Cerrar la entrada y comunicar», tardíos, estado del parte por huésped y `SES_ALREADY_REGISTERED`. **SES-4 hecho (migración 0448):** anonimización diaria (`retention/tick`, sonda `booking.retention_has_work`) a los 3 años del fin de la estancia con SES y a los 6 meses sin SES, nunca en curso; firma y justificante a `temporary` y sin referencia; restricciones a la papelera; en un lote del sistema que llega a los dispositivos. Siguiente: SES-5 (pruebas reales en PRE cuando lleguen las credenciales).

- **Piloto del feedback (fase 3):** kit 0.16 adoptado en la cáscara (formulario, revisor, «Señalar para comentar» en el lanzador, «Sugerencias y QA» en la cabecera, borrado al cerrar sesión); 335 `data-feedback-id` estables (`booking.<pantalla>.<sección>.<elemento>`) con su etiqueta en todos los controles con significado, `data-feedback-ignore` en contactos, documentos, firmas y códigos; prueba del recorrido del §27 y prueba estática de ids.
- **Facturar desde una reserva:** lectura `booking.reservation_invoice_source` para Finance (§19).
- **Fase 4 de los portales (§23, migración 0459):** programa del retiro (`program_items`, lectura `portal_program` para Organizers y Guests, acciones del organizador para guardar, quitar y ordenar; bloque «Programa» en la ficha) y huésped de muestra para la vista previa (`portal_preview_guest`, fuera de totales, cocina y SES; `PREVIEW_READ_ONLY`). El aviso del plazo interno del saldo compara con lo cobrado de Finance (`invoices.reservation_collected`).
- **R2 de Recursos (§24, migraciones 0464 y 0465):** interruptor `spaces_source` (apagado), escritura doble con Recursos, vista previa y «Enlazar», espejo de espacios y camas (plazas fijas y supletorias) con tick y desde la app del owner, árbol del kit en «Espacios y camas» con el interruptor encendido; crear, cambiar o quitar espacios y camas, solo el owner. Pendiente: encender con el visto bueno del usuario, tras el ensayo con los recuentos reales.
- **Supletorias por retiro (§25, migración 0466):**
  - el organizador activa cuántas quiere por habitación (`portal_extra_beds`): al momento si la propuesta no está aceptada, y pendiente con aviso al comercial si ya lo está;
  - se cobra la activada (y la ocupada sin activar);
  - Guests elige entre las activadas (BG13: aparte en `extra_total` y `extra_free`);
  - el reparto del organizador (B17) también las usa;
  - la ficha tiene «− / +» y «Confirmar / Rechazar»;
  - caracterización previa en `tests/booking/extra-beds-characterization.test.ts`.
- **O2, parte 1 · estancias (§26, migración 0467):**
  - estancias de outsider y del staff, con personas, cama por defecto y notas con hora;
  - un choque con un retiro es un aviso (`stay_clashes`, `stays_clashing`), nunca un bloqueo;
  - lecturas y acciones de outsider para Guests, con su ámbito por `core.house_levels`;
  - clave de persona estable (`guests.person_key`, `portal_person_link`) y `portal_my_retreats`;
  - arreglo de `bed_free` con huésped nulo;
  - caracterización previa en `tests/booking/o2-characterization.test.ts`; pruebas en `tests/booking/stays.test.ts`.
- **O2, parte 2 (§26.1, migración 0468):** retiros visibles para huéspedes (`guests_visible`, `public_summary` y `portal_open_retreats`, sin precio) y estancias en Google (outsiders en el segundo calendario y staff en el tercero, con su cola, y «Marta (+1)»). Pruebas en `tests/booking/stays-calendar.test.ts`.
- **O2, pantallas (§26.2, migración 0469):** Estancias (`#/estancias`), capas del calendario, aviso en Inicio, «Visible para huéspedes» en la ficha y la chip en Reservas, y el aviso de la estancia en Alojamiento. Escenario `tests/booking/stays.spec.ts`.
- **O2, «Apuntarme» (§26.3, migración 0470):** sugerencias del núcleo de tipo `apuntarme`. Al aceptar, fichas y entrada en Guests para la cuenta autora (`core.suggestion_author()` y `portal_grant`). «Pasar al organizador» deja `join_requests`, que el organizador decide desde su portal. En la ficha, «Solicitudes para apuntarse», y en Inicio, el aviso. Pruebas en `tests/booking/join.test.ts` y `stays.spec.ts`.
  - Pendiente de O2: que Core configure los dos calendarios (P25). Las pantallas de Guests (O4) y la de Organizers para las solicitudes son de sus equipos.
- **FB_2026_014 · nombres que ya existen:** en «Nuevo espacio» y su edición, la zona ofrece las existentes en una lista con búsqueda (se puede escribir una nueva) y avisa «Nuevo: no existe todavía» o «Ya existe «X»» con «Usar «X»» si solo cambian mayúsculas, tildes o espacios; el nombre del espacio avisa si ya hay uno igual o parecido; «Otro lugar» del programa, igual que la zona. Con `attachSuggestions` del kit 0.27 (`suggestions` y `suggestMode` en `FieldSpec`).
- **Cierre de la 067 (20-10-2026):** «Movimientos» del extracto de la ficha, con las emitidas de Finance una a una (`invoices.reservation_movements`, #643). Van por meses y las rectificativas restan. Sin red se ve la última copia del dispositivo, que también da lo cobrado; se borra al cerrar sesión (`forgetMovements`). Prueba en `tests/booking/extract-moves.spec.ts`.
- **Tanda 36 (20-10-2026, MUELA-049):** Espacios y camas con plano y ficha, y «Monta el dormitorio» en cuadrantes (migración 0477, API.md §27). Cualquier estancia con camas cuenta sus plazas. Pruebas en `tests/booking/dorm-layout.test.ts`, `space-layout.test.ts` y `spaces.spec.ts`.
- **Feedback de Espacios y Tarifas (26-10-2026, La Muela desarrolla; migración 0479):**
  - **FB_2026_051 y FB_2026_050:** «Monta el dormitorio» dibuja piezas (`dorm.pieces`): la cama de Recursos que el espejo (0465) guarda en dos filas, fija y supletoria, es una sola pieza («1 + 1»), y las dos filas guardan el mismo sitio.
  - **FB_2026_047:** las camas inactivas (archivadas) no se dibujan y se nombran aparte (`#dormInactive`); las supletorias tienen su color (además del borde discontinuo), la fija + supletoria va mitad y mitad, con leyenda.
  - **FB_2026_046:** el texto de la cama va siempre en horizontal, también a lo largo; en la pieza, el nombre corto en dos líneas como mucho (`dorm.shortName`); el completo, en la barra, en `title` y en la etiqueta accesible.
  - **FB_2026_048:** los campos de casillas múltiples (p. ej. «Tipos de reserva» de Nueva tarifa) son chips de 46 px que se activan; la casilla sigue dentro.
  - **FB_2026_049 (decisión de VG):** el espejo cuenta 1 plaza fija en una cama de Recursos sin plazas declaradas, como el árbol del kit (migración 0479, `booking.resource_seats`); antes contaba 0 y la cama no llegaba a Booking.
  - **FB_2026_052 (decisión de VG, opción a):** tamaño fijo por tipo; la doble ocupa 2×2 cuadrantes y las demás, 2×1 (`dorm.sizeOfKind`).
  - La prueba del Calendario del humo pasa de mes cuando la reserva (dentro de 10 días) cae en el siguiente.
  - Pruebas en `tests/booking/dorm-layout.test.ts` y `r2-mirror.test.ts`.
- **MUELA-065, PR 3 (20-10-2026):** `audience` en las actividades del programa (migración 0475, API.md §23). Lo usan Organizers, que pone el selector, y Guests, que hace el Programa de la familia por columnas. Por defecto, «todos». Prueba en `tests/booking/portal-program.test.ts`.
- **Tanda 30 (20-10-2026, MUELA-086 §3):** el lector ve los precios en «Fines de semana libres» del Calendario, con la lectura `booking.price_calendar_source` (migración 0474, API.md §17.7), sin motivos ni textos internos. Prueba en `tests/booking/price-calendar.test.ts`.
- **Tanda 27, interfaz de una pasada (20-10-2026, MUELA-067 con 009, 020, 038 y 052):** sin migraciones ni escrituras nuevas.
  - **Capa pura** `_domain/booking/experience.ts` (fase, etapa comercial, recorrido de cinco etapas, preparación por áreas, «Siguiente: …», «Corre prisa» y el orden de «Lo primero»), que usan Inicio, Reservas y la ficha. Lo que el rol no ve no decide («Nada pendiente de lo que puedes ver»). Prueba en `tests/booking/experience.test.ts`.
  - **Cáscara:** menú lateral del kit (columna en el ordenador; Estancias, Espacios, Tarifas, SES y Por resolver con entrada fija), búsqueda con la paleta (Ctrl K) y «‹ Volver a…».
  - **Inicio:** cifras que filtran, avisos de SES y del portal siempre a la vista (los demás, en «Otros avisos»), «Lo primero» con la acción de la fase y la cola numerada, utilidades y cuenta plegadas. Las 10 claves `data-notice` se mantienen. El aviso de SES lee B2 con red.
  - **Reservas:** portada de las próximas con flechas (`#nextCover`), «Corre prisa», lista por fases con «Siguiente» y áreas ✓ / !, grupo comercial como embudo y tablero, filtros en dos líneas con recuento, búsqueda sin tildes en todas, y «Vaciar papelera» desactivado sin red o con cambios sin enviar, con su motivo (`#emptyTrashWhy`). El alta acepta fechas puestas desde el Calendario.
  - **Ficha:** portada (logo o color de la fase, personas con su nombre, noches, días, firmados y caras), foco con «Siguiente ›» y `#phaseAction`, recorrido común (`#reservationJourney`) y pestañas Resumen · Comercial · Operación · Huéspedes · Dinero, más «Todo» (la ficha entera, se recuerda en el dispositivo). Mapa de los 17 bloques en `ui/fichaLayout.ts`. Extracto (`#financeExtract`) con lo cobrado de Finance; «Editar cobro» sigue en Dinero. «Asignar camas» es `#addAssignment`; `#openSpaces`, «Espacios y camas». El evento ya no enseña su código.
  - **SES:** `#/ses` como bandeja por estado (`renderTray`), veredicto (`#sesVerdict`), franjas de pruebas y pausa, «Comunicar las n» una a una con confirmación (entorno, reservas y pausa), ajustes plegados; pausar sin red sí, pasar a real solo con red. Plazo con hora en la ficha, en la bandeja y en el parte de Huéspedes.
  - **Tarifas:** tres pasos (Reglas → Probar un caso → Lo que ve el organizador), «Cambiar importe» en una hoja de un campo, y el calendario de precios en la llegada del caso (`#caseDates`). **Calendario:** `#freeWeekends` con la misma hoja, «Nueva reserva con estas fechas» y «Bloquear» (el lector no ve precios). **Estancias:** portada, tres grupos con su cifra y «Tu año».
  - Pruebas: `tests/booking/ficha-tabs.spec.ts` (nueva) y las e2e de siempre ajustadas (las de bloques abren «Todo» desde el arnés).
- **Tanda 27, logotipo del retiro:** `GET /api/v1/logos` firma el logotipo de cada retiro desde `organizers.booking_logo_projection` (API.md §17.8). Prueba en `tests/booking/entity.test.ts`.
- **Tanda 27, versiones de la propuesta (migración 0473):** `portal_proposals` con `include_history` da también las sustituidas y caducadas (con `superseded_by_version`) para «Comparar versiones» de Organizers. Prueba en `tests/booking/proposal-versions.test.ts`.
- **Tanda 27, servidor (19-10-2026, migración 0472):** B2 (`GET ses`, la bandeja de SES de varias reservas en una lectura, sin datos de huéspedes), las reglas puras de SES en el dominio (`deadlineOf`, `sesErrorTarget`, `sesOverview`) y `GET/POST ses/:id/pv` solo para quien ve huéspedes (API.md §17.6). Calendario de precios en el dominio (`_domain/booking/priceCalendar.ts`): `rangeAvailability` da lo mismo que `booking.range_availability` y `priceCalendar` calcula los fines de semana con `suggestLines` → `proposalTotals` → `applyMinimum`, también sin red. Pruebas en `tests/booking/ses-overview.test.ts` y `price-calendar.test.ts`.
- **K3 para miembros (19-10-2026):** `uploads.membersK3` activado. El justificante y la firma de un huésped solo se leen por su id si se ve al huésped (API.md §8). Pruebas en `tests/booking/members-k3.test.ts`.
- **Marcadores del texto de las condiciones (§23.3, migración 0462):** `{{condiciones.…}}` y bloques condicionales, resueltos en la propuesta, la tarjeta y el portal; lista de tramos generada; vista previa y ayuda en el editor.
- **Actualizaciones (kit 0.23):** `initAppUpdates` del kit en lugar del `updates.ts` propio: al abrir, o al volver tras más de un minuto, la versión nueva se aplica sola si es seguro (`safeToUpdate`); si no, el banner de siempre.
- **Fase 5 de los portales (§23.1, migración 0460):** alojamiento delegable: inventario del retiro, ajustes y habitaciones abiertas (solo con baño), elección atómica de cama (`BED_TAKEN`, `CHOICE_CLOSED`, `NOT_OFFERED`), petición con aprobación, reparto del organizador y preferencias de compañeros.

- **Flow, hito 1 (26-10-2026, encargo de VG; migración 0480):** `booking.event_projection` (evento con nombre, tipo, estado, fechas y aforo) y `booking.event_staff_projection` (turnos con cuenta, ficha de Central y nombre corto), abiertas a Flow (API.md §28). Pruebas en `tests/booking/flow-projections.test.ts`. Siguiente: «Servicio de barra» en la ficha, leyendo `flow.booking_service_projection`.
- **Reglas de acceso a los portales (26-10-2026, encargo de VG; migración 0481):**
  - enlaces sin caducidad, y la conservación ya no revoca;
  - organizador y personal con cuenta como huéspedes de su retiro (`portal_role`, `portal_access_run` con tick);
  - dirección con «todos»: coorganizador, se apunta y elige cualquier cama.
  - Detalle en API.md §29; pruebas en `tests/booking/portal-access.test.ts` y `portal.test.ts`.

- **Tipos de reserva (26-10-2026, encargo de VG; migración 0482):** retiro, jornadas abiertas y familiar, con el mapeo de los valores viejos (también en las tarifas). API.md §30. Siguiente: el alta y la ficha según el tipo.

- **Tipos de reserva, hito 2 (migración 0484):** la ficha según el tipo. Jornadas abiertas: cartas de Food y «Alojar a alguien»; familiar: sin dinero ni alojamiento y con menú de casa. API.md §30; pruebas en `tests/booking/open-days.spec.ts`.

- **Servicio de barra (Flow):** la ficha del evento enseña los cierres del día de Flow (`flow.booking_service_projection`): pedidos, ventas por método, devoluciones pendientes, horas punta y lo más vendido. API.md §28.3; prueba en `open-days.spec.ts`.

- **Grupo de comensal y llegada y salida desde Flow (0485 y 0486):** `meal_group` para las ofertas de Food; `flow_guests_projection`, `guest_arrive` y `guest_leave` para recepción en Flow. API.md §31; pruebas en `meal-groups.test.ts` y `flow-checkin.test.ts`.

- **Cobro del alojamiento a la carta (0487):** precio por noche de la tarifa, cobro en el momento (efectivo, Bizum o tarjeta) o pendiente, envío a Finance (`invoices.record_app_entry`) con la sesión de la persona, y lo cobrado y lo pendiente en la ficha. API.md §32; pruebas en `walkin-finance.test.ts` y `open-days.spec.ts`.

- **Código público del evento (0488):** `public_code` para el QR de visitantes a ven.ikisai.com y la lectura pública `booking_event`; «QR de entrada» en la ficha (imprimir y regenerar). API.md §33; prueba en `public-code.test.ts`. El QR, con `renderQr` del kit 0.60.

## Pendiente

- **Recorrido de aceptación en producción** por el usuario, en PC y Android (`docs/booking/ACEPTACION.md`).
- La reactivación de un evento borrado a mano en Google solo está probada en simulación.
- En el calendario mensual en móvil los tramos no llevan título (mejora menor pedida a UI por Core).
- Sin verificar: a partir de qué edad firma el huésped (regla por defecto: 14 años).
- Las restricciones alimentarias no son reordenables: no tienen columna de orden y son pocas por evento.
- Peticiones a Core abiertas, sin bloquear: P3, P5, P6 y P9.

## Avisos para otros equipos

- **Food:** `GET /api/v1/read/booking.food_event_projection?where[event_id]=…`. Columnas en `API.md` §7.1.

## Bloqueos

- Ninguno.
