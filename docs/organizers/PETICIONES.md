# Organizers · peticiones a Core y a otras apps

Detalle en `API.md` §13 y §14. Core responde aquí y resume en `docs/core/RESPUESTAS.md`.

## Fase 1 · Preparación

| Id | Para | Petición | Estado |
|---|---|---|---|
| B1 | Booking | Detalle de la reserva para la ficha (horas, plazas confirmadas, lo que incluye), sin importes ni notas internas | hecha (#277, `booking.portal_reservation_detail`) |
| B2 | Booking | `declared` en `booking.portal_guests` | hecha (#277) |
| B3 | Booking | `portal_add_guest` idempotente ante un reintento con el mismo `guest_id` | hecha (#277) |
| B4 | Booking | (opcional) restricciones de cocina del grupo sin huésped, para el modo `ninguno` | aplazada |
| B5 | Booking | Campos booleanos en `portal_guests` (`is_minor`). Hoy `true` significa a la vez «rellenado por otro» y «vale `true`», y el `false` por defecto sale como rellenado. Propuesta: en los booleanos, el valor si lo escribió el organizador y `null` si nunca se escribió | hecha (Booking #770, 0490: `null` si nadie lo contestó). Organizers no lee ni escribe `is_minor` (lo que falta lo da Booking), así que no cambia nada aquí |
| B11 | Booking | Coorganizadores: lectura `booking.portal_organizers({reservation_id})` con los nombres para mostrar de quienes organizan el retiro, sin correo ni teléfono | hecha (#284; en la ficha del retiro) |
| C1 | Core | `sync-client`: `loginWithLink(token)` | hecha (#278) |
| C2 | Core | `portal-links`: reutilizar la cuenta del huésped y `replace: true` al reenviar | hecha (#278) |
| C3 | Core | `permanentAccount` en `GET auth/config` | hecha (#278) |
| C4 | UI | Entrada «Ayuda y sugerencias» del lanzador en portales y paso `signal` sin el interruptor | hecha (kit 0.18.5, #279) |
| C5 | Core | Alta de infraestructura con la primera PR de `apps/organizers` | hecha (publicada el 8-10-2026) |
| C6 | UI | `createAppShell({ nav: [] })` pinta la barra inferior vacía (`.nonav .nav`), que en móvil tapa los botones del pie. Organizers la oculta en su CSS | hecha (kit 0.20) |
| C7 | Central | `central.common_texts_projection` legible desde `organizers` (`organizers.declaration`, `portal.privacy`, `contact.email`, `contact.phone`) | hecha (#281) |
| C8 | UI | Icono propio de Organizers para la PWA (hoy usa el de Central) | hecha (icono de UI en `public/icons/`, manifiesto en berenjena; 8-10-2026) |
| U1 | UI | Capa de traducción del kit (español e inglés) con claves por app y textos del kit traducidos | hecha (kit 0.19, `createI18n`; Organizers en español e inglés) |
| U2 | UI | Indicador de guardado automático del kit: «Guardando…», «Guardado» y «No se ha guardado · Reintentar», por campo o por formulario | hecha (kit 0.20, `createSaveState`) |
| U3 | UI | Hoja «Instala la app»: `beforeinstallprompt` e instrucciones de iOS, con recuerdo de «ahora no» | hecha (kit 0.20, `createInstallPrompt`) |
| X1 | Central | Textos comunes por idioma (columna `lang` o claves `.es` y `.en`), con el español como reserva | hecha (#281: una fila por clave e idioma) |

## Fase 2 · Diseño desde el interesado

| Id | Para | Petición | Prioridad |
|---|---|---|---|
| B6 | Booking | **Disponibilidad:** `booking.portal_availability({from, to})` → por fin de semana (de viernes a domingo) y por día en las opciones entre semana: `libre`, `en_opcion` u `ocupado`, sin decir quién ni por qué. `ocupado` incluye los bloqueos manuales internos; la propia reserva no cuenta contra sí misma. Ventana de 18 meses | hecha (#303) |
| B7 | Booking | **Fechas definitivas y posibles.** (a) En `booking.reservations`, la fecha definitiva como dato explícito (`dates_definitive boolean`, o equivalente que marque el comercial; con ella, `start_date` y `end_date` son la fecha fija). (b) Tabla `booking.reservation_date_options`: reserva, inicio, fin, horas aproximadas, `proposed_by` (`ikisai` u `organizer`), `organizer_ok` (el organizador la marca como posible) y posición. La escribe el personal en Booking (propuestas de Ikisai) y el portal con B8. (c) Lectura `booking.portal_dates({reservation_id})` → `{definitive: {start, end, arrival_time, departure_time} | null, options: [{id, start, end, proposed_by, organizer_ok, availability}], mode: 'fixed' | 'ikisai_options' | 'calendar'}`. (d) Acción `booking.portal_update_draft({reservation_id, expectedRevision, fields})` solo con la reserva en `en_estudio` o `negociacion` y solo con campos de diseño: personas previstas, menores, régimen y estilo de menú pedidos, alojamiento, servicios (centro, exterior, piscina, montaje, apoyo técnico), extras pedidos y notas del organizador | hecha (#303 y #305) |
| B8 | Booking | **Fechas posibles del organizador:** acción `booking.portal_set_date_preferences({reservation_id, options})`, que sustituye lo que marcó el organizador. Con propuestas de Ikisai, `options = [{option_id, ok}]` y solo marca `organizer_ok`. Sin propuestas, `options = [{start, end}]` y crea filas `proposed_by: organizer`. Errores: `DATES_FIXED` si ya hay fecha definitiva, `DATE_UNAVAILABLE` si está ocupada, `DATE_NOT_OFFERED` si Ikisai propuso fechas y se marca otra. Avisa al comercial por la cola y el tick de Booking (Inicio de Booking y petición a Tasks, T3), no al instante. Nunca fija la fecha | hecha (#303) |
| B9 | Booking | **Tarifas para la calculadora** (cambia, aprobado): no hay cálculo en SQL. `booking.portal_rates({reservation_id})` publica las tarifas visibles, las condiciones (IVA incluido) y `minimum_total`; Organizers calcula en el dispositivo con `@ikisai/domain-booking` (`suggestLines`, `proposalTotals`). Sin tarifas: lista vacía y la calculadora dice «Ikisai te enviará el precio» | hecha (#305) |
| B10 | Booking | **Extras para el portal:** `public_name` y `public_description` en los extras visibles (incluidas las habitaciones de 2–4 plazas con baño); los pedidos del organizador van en `booking.reservation_extra_requests` | hecha (#305) |
| B14 | Booking | **Detalle para el diseño:** que `portal_reservation_detail` incluya `event_type` (la calculadora lo necesita para las tarifas por tipo; hoy usa «retiro»), `special_setup`, `technical_support`, `organizer_notes`, `revision` y `dates_definitive`, para pintar el borrador tal como está y no pisar nada | hecha (#310) |
| T3 | Tasks | Peticiones de sistema «Fechas posibles marcadas por un organizador» (B8) y «Quiere confirmar» o «Comentario sobre la propuesta» (B12), que lanza Booking, con regla de enrutado al área comercial | media |
| Fd1 | Food | Para el diseño basta con la orientación del menú de Booking (`menu_style`). Opcional: `food.portal_sample_menu({style})`, un menú de ejemplo público por orientación (platos con su nombre y descripción públicos, sin cantidades) para enseñarlo al interesado | baja |
| X2 | Central | Textos `organizers.dates_note` («Ikisai confirmará la fecha definitiva; lo que marques son posibilidades.»), `organizers.quote_note` (IVA incluido, mínimo, precio orientativo) y `organizers.proposal_note` («Para confirmar, pulsa «Quiero confirmar» y el equipo de Ikisai te contactará»), en los dos idiomas | hecha (central 0590; la app los lee desde el 27-10: Fechas, Diseño y Propuesta) |
| K1 | Core | Comprobación de ámbito de portal reutilizable por cualquier app (`core.portal_in_scope(portal, actor, reservation_id, guest_id)`), para que Finance y Food filtren sus lecturas de portal sin depender de una función de Booking | alta |

## Fase 3 · Formalización

| Id | Para | Petición | Prioridad |
|---|---|---|---|
| B12 | Booking | **Propuesta en el portal, sin aceptar** (decisión del usuario): lectura `booking.portal_proposals({reservation_id})` (propuestas `enviada` y `aceptada`, con líneas, condiciones, tramos de cancelación y validez). Acción `booking.portal_request({reservation_id, kind: 'quiere_confirmar' \| 'comentario', proposal_id?, message?})`, que deja la petición en una tabla de Booking (`booking.portal_requests`: reserva, tipo, propuesta, mensaje, quién, cuándo y estado `enviada`, `vista` o `respondida`, que cambia el personal) y avisa al comercial por la cola de Booking. Lectura de las propias peticiones con su estado. La aceptación sigue siendo de Booking (`accept_proposal`) | hecha (#305) |
| B13 | Booking | Al confirmar: pedir a Tasks el proyecto `AAAAMMDD-<título>` y, por cada extra contratado, su tarea (B13 depende de T1 y T2) | alta |
| F1 | Finance | **Dinero del retiro para el portal:** lectura `invoices.portal_reservation_money({reservation_id})` filtrada por ámbito (K1). Devuelve total contratado, señal requerida y pagada, saldo, vencimientos, cobros (fecha, importe, forma) y facturas emitidas (número, fecha, importe, estado), sin datos internos | hecha (#307) |
| F2 | Finance | Descarga del PDF de una factura desde el portal (URL firmada de corta duración), solo dentro del ámbito | en parte (#307): la copia congelada sí; el PDF guardado necesita la ruta firmada `portal-files` (Core) |
| F3 | Finance | Instrucciones de pago a Ikisai (IBAN, concepto y Bizum) como textos de Central o ajuste de Finance, en los dos idiomas | hecha (#308, texto `payment.instructions` de Central) |
| B15 | Booking | **Lo contratado para el portal:** total contratado, señal requerida y pagada según Booking, forma de pago y vencimientos (de `reservation_finance` y la propuesta aceptada), para que Organizers muestre el saldo como contratado − cobrado (Finance) | hecha (#312) |
| K2 | Core | **Ruta `portal-files`** en `organizers-api`: repite la lectura F2 con la sesión del portal y firma solo un `file_id` que esa lectura devuelva (PDF guardado de una factura registrada) | hecha el 27-10 sin ruta propia: Finance registra el resolutor `invoices.portal_invoice_file` (0249, #843) para `portal-files` del kit (C8), y Organizers pone «Abrir PDF» en la ficha de la factura |
| T1 | Tasks | **Proyecto por retiro por petición de sistema:** crear de forma idempotente (por `external_ref` = reserva) el proyecto `AAAAMMDD-<título>` en el área que fija la regla del owner, y renombrarlo si cambian la fecha o el título | alta |
| T2 | Tasks | Tareas de los extras contratados dentro de ese proyecto, idempotentes por línea (`external_ref` = línea de la propuesta) | media |

### K2 · propuesta (27-10-2026)

Por qué no lo hace Organizers solo:
- los PDF guardados son archivos de la app `invoices`, y `core_file_get` exige ser miembro de esa app;
- una función de Organizers que leyera `invoices.issued_invoice_files` sería una referencia a otro schema, que el lint no admite.

Reparto propuesto:
- **Finance (o Core):** `public.invoices_portal_invoice_file(p_actor, p_reservation_id, p_issued_invoice_id, p_file_id)`, solo para `service_role`, sin `allow_read`, para que el cliente nunca vea el bucket ni la ruta:
  - repite la comprobación de `invoices.portal_invoice_document`: `core.portal_in_scope('organizers', …)` y que la factura sea de la reserva;
  - comprueba que el `file_id` sea uno de sus `issued_invoice_files` vivos;
  - devuelve la fila de `core.files` (`bucket`, `path`, `storage_provider`, `filename`, `mime`, `status`).
- **Organizers:**
  - en `organizers-api`, `GET invoices/:invoiceId/files/:fileId?reservation_id=…`: llama a esa función y firma con `createStorage` durante 10 minutos, como los planos de `guests-api`;
  - en la app, cambiar «Pídenosla» por «Abrir PDF»;
  - una prueba PGlite que cubra que se abre dentro del ámbito y no fuera.

## Fases 4 y 5 · Experiencia de Guests y decisiones del huésped (G2 en API.md §15 y §16)

| Id | Para | Petición | Prioridad |
|---|---|---|---|
| B16 | Booking | **Programa del retiro:** tabla de Booking (reserva o evento, día, inicio, fin, título, espacio como texto o `space_id` público, nota pública, posición). Acciones de portal del organizador para añadir, editar, quitar y reordenar con guardado automático. Lectura `portal_program` para `organizers` y `guests`. El personal lo ve y lo corrige en Booking | alta |
| B17 | Booking | **Alojamiento delegable:** (a) lectura `portal_rooms` del inventario del evento: habitaciones con capacidad, baño, si es de 2–4 plazas con baño y su extra, camas libres y asignaciones con el `display_name`; (b) acción del organizador para asignar o quitar una cama a un huésped; (c) `booking.portal_room_settings` (habitaciones abiertas a elegir, con suplemento y modo de aprobación) con acción del organizador; (d) aprobar o rechazar una plaza pendiente; (e) el suplemento como extra facturable al organizador. `portal_choose_bed` la pide Guests | alta |
| Fd2 | Food | **Menú para los portales:** lectura `food.portal_menu({reservation_id})` para `organizers` y `guests`. Días, servicios y platos con su nombre y descripción públicos, dietas y alérgenos, y la marca «provisional»; sin cantidades ni datos internos | alta |
| Fd3 | Food | **Comentarios del organizador sobre el menú:** acción `food.portal_menu_comment({reservation_id, menu_item_id?, kind: 'prefiero_que_no' \| 'comentario', message?})` y lectura de los propios con su estado. Cocina los ve en Food | media |
| X3 | Central | Textos `portal.menu_note` («El menú puede cambiar para adaptarse a alergias e intolerancias») y `portal.practical` (información práctica general de Ikisai), en los dos idiomas. La dirección de la Entidad, legible para el cartel | hecha (central 0596: `portal.menu_note` en el menú, `portal.practical` y la dirección en `central.portal_place_projection`) |
| K3 | Core | **Archivos de un portal con ámbito:** que `files/:id` de un portal compruebe la visibilidad de la fila que referencia el archivo (los campos ya están declarados con `register_file_field`), para que un organizador no abra los materiales de otro retiro. Si no, una ruta propia de `organizers-api` | alta |
| K4 | Core | **Escritura de Guests en Organizers:** que `core.apply_portal_operations('organizers', ops)` funcione dentro de una acción de Organizers registrada para el portal `guests` (respuestas a las preguntas), con el huésped como actor y su ámbito `{reservation_id, guest_id}` | alta |
| K5 | Core | Alta del schema `organizers` en la publicación, bucket `organizers-materials` y `uploads` en `organizers-api` (imágenes ≤ 5 MB recomprimidas, PDF ≤ 15 MB) | media |
| O1 | Guests | Respuesta: de acuerdo. `guests-api` sirve `GET materials/:fileId`, comprobando con `organizers.guest_material_file`, y firma con `createStorage` | — |

## Fases 4 y 5 · construcción (8-10-2026)

| Id | Para | Petición | Prioridad |
|---|---|---|---|
| K6 | Core | `core.apply_portal_operations('organizers', …)` desde una acción del portal `guests`. Hoy falla con `target must be an internal app`, porque `organizers` es de tipo `portal`. Propuesta: admitir como destino un portal distinto del que invoca, si la acción es de la app destino (`organizers.guest_answer` registrada para `guests`). La prueba que lo cubre está en `experience.test.ts`, marcada `skip` | alta |
| B18 | Booking (o Core) | **Fin del retiro para borrar las respuestas a los 6 meses:** Organizers no puede leer `booking.reservations`. Dos opciones: (a) una proyección `booking.reservation_end_dates` (id, end_date, status) legible por el worker de Organizers, admitida en el lint como la P14 de Food; o (b) que la anonimización de Booking a los 6 meses llame a `organizers.purge_answers(reservation_id)` | media |
| K7 | Core | **Cuenta de servicio `organizers`** en `core.service_grants` (`displayName` «Organizers (sistema)», sin pertenencias), para que `worker/retention/tick` firme con `apply_system_operations` el borrado de las respuestas a los 6 meses (B18). Hoy `ensureServiceActor(supabase, 'organizers')` falla con `unknown service`. La prueba de `experience.test.ts` la simula en su base hasta que esté en main | alta |

K6 (#334), B18 (#335) y K7 (#353): hechas y aplicadas en Organizers (#339).

## Acceso que no caduca, dirección como coorganizadora y «Verlo como huésped» (encargo de VG por Core, 26-10-2026; plazo: jueves 29)

Reglas de VG:
- el acceso a Organizers no caduca: el organizador ve sus retiros pasados y los que está montando;
- al recibir acceso a Organizers recibe también Guests y aparece como huésped de su retiro (lo hace Booking);
- dirección figura como coorganizadora de cualquier evento y puede entrar en Organizers viéndolo así.

**Lo que hay hoy (revisado en `main` 95a1f1e):**
- El cliente de Organizers **no borra nada al terminar el evento**: la caché solo se borra al cerrar sesión o al entrar otra persona (`onSessionEnd`), y los retiros terminados ya salen en «Pasados».
- El permiso por reserva (`scopes.grants`) tampoco caduca en el servidor.
- Lo que corta el acceso está en dos sitios:
  - **El enlace.** `booking.portal_link_valid_until` lo da por bueno hasta el fin de la reserva más 3 días (90 días desde el alta si no hay fecha) y lo da por caducado (`null`) si la reserva está cancelada o perdida. En un móvil nuevo, tras «Cerrar sesión» o con el navegador limpio, el organizador ya no puede volver a entrar (`LINK_EXPIRED`), porque la cuenta permanente sigue pendiente de Workspace.
  - **El pase común** (`ikisai_sso`, 30 días). Solo se emite al canjear un enlace, al entrar con contraseña y al recuperar la contraseña, y solo se alarga al usarse en `auth/sso`. Renovar la sesión de Organizers (`auth/refresh`) no lo toca. Un organizador que solo usa Organizers lo pierde a los 30 días, y entonces «Verlo como huésped» le llevaría a la pantalla de entrada de Guests.

| Id | Para | Petición | Prioridad |
|---|---|---|---|
| B19 | Booking | **Enlace de organizador sin caducidad.** Un resolutor propio para `organizers` (`core.allow_portal_resolver('organizers', 'booking.portal_organizer_link_valid_until')`) que devuelva `'infinity'` mientras la reserva exista, también terminada, cancelada o perdida. Solo `null` si se borró. Guests sigue con el resolutor de hoy. Revocar sigue siendo lo que corta un enlace (`portal-links/:id/revoke`, `core.portal_revoke_scope`). El núcleo ya lo admite: `core.portal_link_resolve` compara con `now()` | alta |
| B20 | Booking | **Ámbito «todos» para dirección.** Booking define su forma (propuesta: una entrada `{"all": true}` en `scopes.grants` de `organizers`) y quién la da. Con ese ámbito:<ul><li>`booking.portal_reservations` devuelve todas las reservas no borradas;</li><li>el resto de lecturas y acciones de portal de Booking (`portal_in_scope`) las aceptan;</li><li>cada elemento de `portal_reservations` lleva `as: 'organizer' \| 'coorganizer'`. `coorganizer` significa que la reserva se ve por «todos» y no por un permiso propio, y con eso Organizers pinta la vista de coorganizadora.</li></ul>Hoy `booking.portal_in_scope` solo llama a `core.portal_in_scope` (ver K8) | alta |
| B21 | Booking | **El organizador como huésped de su retiro.** Al dar acceso a Organizers, Booking da también el de Guests (pertenencia `editor` con `{reservation_id, guest_id}`) y crea al organizador como huésped. Para el botón, `portal_reservations` añade a cada reserva `as_guest_id` (el `guest_id` del propio organizador en ella, o `null`). Organizers enseña «Verlo como huésped» solo si no es `null` | alta |
| K8 | Core | **`core.portal_in_scope` con «todos».** Que dé verdadero para cualquier reserva si la pertenencia del actor al portal tiene la entrada de B20. Solo en `organizers`: en Guests el huésped sigue mandando. Que una pertenencia con «todos» no pueda salir de un enlace de portal (`portal-links`): solo la da quien decida Booking o Central | alta |
| K9 | Core | **El pase común sigue vivo mientras se use una app.** Que `auth/refresh` alargue el pase del dispositivo (o emita uno si no lo hay), igual que `auth/sso`. Así, «Verlo como huésped» abre Guests con la misma cuenta aunque el organizador lleve más de 30 días usando solo Organizers | alta |
| Gu1 | Guests | **Entrar en un retiro concreto.** Formato del enlace para abrir Guests en la ficha de un retiro cuando la cuenta tiene varios (propuesta: `https://guests.ikisai.com/#/r/<reservation_id>`, o el `guest_id`). Es el equivalente, para la sesión común, del «por enlace, ese retiro» de C10. Sin sesión en Guests, la entrada por pase (`auth/sso`) tiene que respetar esa ruta | alta |

**Lo que hace Organizers (en este territorio y en la PR #718):**
1. Entrada y textos. El error de enlace caducado deja de decir «si tu retiro sigue en marcha»: con B19 solo deja de valer un enlace revocado o el de un retiro borrado. Ahora dice «Este enlace ya no está activo» y que con uno nuevo se vuelven a ver todos los retiros, también los pasados.
2. Ámbito «todos» en lo propio: `hasAllReservations` e `inReservationScope` en `_domain/organizers`, que usan `visibleRow` y `validateOperations` (prueba en `tests/organizers/scope.test.ts`). El gancho de la base de datos (`organizers.validate_batch`, 0700) ya pregunta a `core.portal_in_scope('organizers', …)`: con K8 queda cubierto, sin migración propia. Un coorganizador con «todos» lee y escribe la experiencia y las ofertas de cualquier retiro.
3. Mis retiros con «todos»:
   - la lista completa, con un buscador por título o código (sin acentos ni mayúsculas) y la marca «Coorganizas» cuando `as = 'coorganizer'`;
   - con «todos» no se abre sola la ficha;
   - las portadas de esos retiros se piden al buscar o al abrir su grupo.

   La ficha es la misma, con la línea «Lo ves desde dirección de Ikisai: coorganizas todos los retiros.»
4. «Verlo como huésped» en la cabecera de la ficha (`#viewAsGuest`), solo con `as_guest_id` y si el catálogo de apps (`GET apps`) incluye `guests`. Abre Guests en otra pestaña con la ruta de Gu1 (de momento la propuesta `#/r/<reservation_id>`, en un solo sitio: `app/guest-view.ts`), sin otro inicio de sesión.

**Respuesta de Booking (26-10):**
- Le encajan `as` (`'organizer' | 'coorganizer'`), `as_guest_id` y «todos» como `{"all": true}` en `scopes.grants`. El `{"all": true}` lo concede Core por el nivel de dirección, y Booking lo acepta en sus comprobaciones.
- B19 se hace como se pidió y vale también para Guests (regla 1 de VG).
- B21: la ficha de huésped del organizador lleva `booking.guests.portal_role = 'organizer'`. La crea la conciliación `booking.portal_access_sync` después de cada permiso de Organizers.
- Todo va en la migración 0481, en una PR aparte.

**Respuesta de Core (26-10):** K8 y K9 van en la migración 0095 y en el `_kit`.

**Respuesta de Guests (26-10, Gu1):** confirmada `https://guests.ikisai.com/#/r/<reservation_id>`, en minúsculas. Ya está en main: abre la familia del retiro, o la ficha si la cuenta solo tiene una persona; sobrevive a la entrada por pase común. Con «todos», Guests deja recorrer el retiro sin ficha (en su tanda).

**Respuestas de VG (26-10, por Core):**
- Dirección ve todos los retiros, pasados y futuros.
- Los cancelados se quedan en «Cancelados» para siempre.
- Dirección edita la experiencia y las ofertas de cualquier retiro como coorganizadora, **pero el cambio queda como «propuesta del equipo de Ikisai»** y quien organiza la acepta o la descarta desde su ficha. Se hace con las sugerencias del núcleo (contrato §3.10), en la migración 0703:
  - El gancho de ámbito pide **permiso propio** para escribir en `organizers.*`. Con solo «todos» responde `SUGGESTION_REQUIRED`. Si dirección también organiza ese retiro, escribe directo.
  - El tipo de sugerencia `propuesta_equipo` (experiencias, materiales, preguntas y ofertas) solo lo envía quien tiene el nivel de casa «dirección». `detail.reservation_id` dice de qué retiro es.
  - `suggestionVisible`: la ven, previsualizan y deciden solo quienes tienen permiso propio sobre ese retiro. Dirección no decide las suyas; las sigue con `scope=mine` y puede retirarlas.
  - En el cliente, lo que cambia dirección se junta en un borrador por retiro (`app/proposal-draft.ts`) que las pantallas ven encima del espejo. Se envía de una vez, como una sola sugerencia, desde «Propuesta para quien organiza». Así no sale una por campo ni se llega al límite de 30 pendientes.
  - Quien organiza ve «Propuestas del equipo de Ikisai» con lo que cambia cada una, y los botones «Aceptar» y «Descartar». Al aceptar, lo nuevo en materiales y preguntas pasa a su biblioteca (`owner_id`).
  - Archivos: desde el 27-10, por orden de VG, una propuesta puede llevar archivos. Dirección los sube al momento y la propuesta lleva su `file_id` (API.md §19.3).
  - Programa y Alojamiento (dentro de Experiencia) son datos operativos de Booking, y dirección es propietaria de Booking: con «todos» se escriben directo, sin propuesta (Core, 26-10).

**K8 y K9:** fusionadas en la #723 (Core, 26-10).

Preguntas para VG (por Core):
- Con «todos», ¿la dirección puede **escribir** en la experiencia y las ofertas de cualquier retiro, o solo verlas? Recomiendo verlo y escribirlo igual que un coorganizador (la regla dice «aparece como coorganizador»). Si es solo lectura, se marca en el ámbito.
- ¿Los retiros cancelados siguen en «Cancelados» para siempre? Con B19 sí. Recomiendo que sí, porque es lo que pasa hoy mientras dura la sesión.

## Comida que se ofrece (encargo de VG por Core, 27-10-2026)

| Id | Para | Petición | Estado |
|---|---|---|---|
| Fd4 | Food | **Ofertas de comida para el portal:** `food.portal_offers({reservation_id, from?, to?})`, para Organizers y Guests y con el ámbito de `portal_in_scope` (con «todos», K8). Lleva:<ul><li>el menú cerrado y las cartas, con quién paga: `payer` vale `'organizador'` o `'huesped'`, y para el huésped, `charge_when` vale `'barra'` o `'cuenta'`;</li><li>días, servicios y lugar;</li><li>las líneas de la carta, con su precio de venta en céntimos con IVA, alérgenos y dietas.</li></ul>Lo interno (`audience = 'interna'`) y las líneas no disponibles no salen. `food.event_offers_projection` es la vista para Booking, no para portales | aceptada (Food, migración 1111) |

## Indicadores para Dirección (P7 de Central, encargo de Core, 27-10-2026)

| Id | Para | Petición | Estado |
|---|---|---|---|
| F4 | Finance | **«Retiros con pagos pendientes de quien organiza»** para el panel de Dirección: la clave `invoices.organizer_reservations_pending` (unidad `count`), en `invoices.central_kpi_projection`, que ya es de Finance. Cuenta las reservas con facturas enviadas sin cobrar o con vencimientos pasados, sin importes por persona. Organizers no lee el schema `invoices` (lint), y los demás indicadores de quien organiza ya están en `organizers.central_kpi_projection` (0705) | hecha (Finance #993): reservas con alguna factura emitida enviada y sin cobrar, solo el número; los vencimientos pasados son de Booking (B15) |

## Pagos en línea (fase 6; decisión de VG del 27-10-2026: después del sábado)

| Id | Para | Petición | Estado |
|---|---|---|---|
| F5 | Finance | **Enlace de pago por factura** en `invoices.portal_reservation_money`: en cada factura sin cobrar, `payment_link: {url, provider, expires_at}` o `null`. Lo crea Finance (Stripe Payment Links o Redsys del banco) y lo da por caducado cuando deje de valer. Organizers solo enseña «Pagar ahora» si la URL es `https` de una pasarela conocida (`buy.stripe.com`, `checkout.stripe.com`, `sis.redsys.es`, `sis-t.redsys.es`; para otra, se añade a `app/pay-link.ts`). Ningún dato de tarjeta pasa por Ikisai; lo cobrado lo sigue registrando Finance (y, si la pasarela avisa, Finance lo marca solo) | en análisis en Finance (`MUELA/equipo/feedback/finance/PAGOS_EN_LINEA_finance-18.md`), a la espera de VG. Cambio propuesto por Finance y aceptado: `payment_link` solo trae un enlace abierto y vigente, o `null`; al pulsar «Pagar ahora» sin enlace, Organizers llamará a la acción `invoices.portal_payment_link {reservation_id, issued_invoice_id}`, que lo crea (Stripe Checkout, 24 h), para que una lectura nunca cree cobros. Con Stripe, `checkout.stripe.com` ya está admitido; con Redsys, la página intermedia de Finance y su dominio. Organizers ya enseña el enlace que llegue |

