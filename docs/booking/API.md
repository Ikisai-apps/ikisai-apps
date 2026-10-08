# Ikisai Booking · API y modelo de datos (puerta G2)

Fecha: 6 de octubre de 2026. Autor: agente Booking (backend). Estado: **puerta G2 aprobada por Core de forma provisional** (`docs/core/RESPUESTAS.md`, ronda G2). Las respuestas a las peticiones de §13 están en `docs/booking/PETICIONES.md`.

Dos cambios de ubicación tras esa ronda, que valen para todo el documento: donde dice `packages/domain-booking`, el código vive en `supabase/functions/_domain/booking/` y el paquete solo lo reexporta; y las funciones de lectura de `booking.*` se exponen registrándolas con `core.allow_read` (ruta `/api/v1/read/:name`).

Fuentes: `AGENTS.md`, `docs/core/PLAN.md`, `docs/core/CONTRATO_SINCRONIZACION.md` (v0.1), `docs/core/PLANTILLA_API_APP.md`; handoff V3 (`02_HANDOFF_TECNICO_CORE_V3.md` §3–§11, §25, §26, §32), canon funcional (`08_CANON_FUNCIONAL_BOOKING_FOOD.md` §2–§12), `C03.md`, `C04.md`, protocolos 8 y 9 de C09 y el script `C03_C04_CalendarSync_LEGACY.gs`. Contrastado con la implementación real del núcleo en `main` (`20261006_0001_core_base.sql`, `_kit`, `sync-client`, `scripts/lint_migrations.mjs`).

Donde el handoff V3 y el plan de Core se contradicen manda el plan (repo único, núcleo común, offline, Calendar por cuenta de servicio). Las desviaciones respecto al handoff están marcadas con **[desviación]** y resumidas en §14.

---

## 0. Resumen para quien revisa

- Seis tablas sincronizables (`reservations`, `reservation_finance`, `events`, `guests`, `dietary_restrictions`, `checklist_items`) y tres tablas cerradas que el cliente nunca lee ni escribe (`calendar_links`, `calendar_sync_jobs`, `event_food_state`).
- Un único procedimiento `call`: `booking.confirm_reservation`. Todo lo demás son operaciones de fila, para que funcione sin red y se pueda deshacer.
- Un `validate_hook` (`booking.check_invariants`) sostiene las invariantes entre tablas (reserva confirmada ⇒ evento; nada huérfano).
- Huéspedes: tabla que `reader` no recibe nunca y que un `editor` solo ve con `scopes.guests = true`. Importes y datos de pago en tabla aparte que `reader` tampoco recibe.
- Decisiones del usuario del 6 de octubre de 2026 ya incorporadas: ver §14.
- Calendar: proyección de una sola dirección con cuenta de servicio. Cola en SQL alimentada por triggers, worker en la Edge, id de evento determinista, reintentos con espera creciente.
- `booking.food_event_projection` con las columnas normativas del contrato §8. `event_revision` solo cambia cuando cambia algo que a Food le importa.
- Los dos bloqueos iniciales (P1 y P2 de §13) quedaron resueltos por Core en la ronda G2. El resto de peticiones tienen alternativa descrita.

---

## 1. Dominio y límites

**Qué resuelve.** El ciclo de una estancia de grupo en Agram Camp: reserva comercial → pre-reserva → confirmación → evento operativo (preparación, ejecución, cierre) → huéspedes y registro de viajeros → restricciones alimentarias, con Google Calendar como espejo de solo salida.

**Qué no hace (V1).** CRM, tabla de clientes, histórico de propuestas, facturación emitida, cobros bancarios, turnos, envío automático a SES.Hospedajes, sincronización bidireccional con Calendar, formulario público de auto-registro de huéspedes, copias de documentos de identidad.

**Propiedad de datos.**

| Dato | Dueño | Cómo lo ven otros |
|---|---|---|
| Reserva, evento operativo, huéspedes, restricciones, checklist, enlace con Calendar | Booking | Food e Invoices: `booking.food_event_projection` (sin huéspedes) |
| Recetas, menús, compra, preparación | Food | Booking no los lee en V1 |
| Facturas y coste por retiro | Invoices | Booking no los lee en V1 |
| Tareas permanentes | Tasks | «Crear tarea» queda para V2 |

Booking no escribe en ningún otro schema y no lee de ninguna otra app en V1.

**Zona horaria.** Fechas (`date`) y horas (`time`) son locales de `Europe/Madrid`. Solo los sellos técnicos son `timestamptz`.

---

## 2. Tablas (`booking.*`)

Todas llevan las columnas del contrato §2.1 (`id`, `revision`, `created_at`, `updated_at`, `updated_by`, `deleted_at`) y se registran con `core.register_table` en la migración que las crea. No las repito en cada tabla.

Roles: `R` = `reader`, `E` = `editor`, `O` = `owner`.

| Tabla | Lee | Escribe | Purga | En el espejo local |
|---|---|---|---|---|
| `reservations` | R E O | E O | sí | sí |
| `reservation_finance` | E O | E O | sí | solo E y O |
| `events` | R E O | E O (alta solo por `confirm_reservation`; baja solo O) | sí | sí |
| `guests` | O, y E con `scopes.guests` | O, y E con `scopes.guests` | sí | solo si la ve |
| `dietary_restrictions` | R E O | E O | sí | sí |
| `checklist_items` | R E O | E O | sí | sí |
| `calendar_links` | nadie (cerrada) | nadie | — | no |
| `calendar_sync_jobs` | nadie (cerrada) | nadie | — | no |
| `event_food_state` | nadie (cerrada) | nadie | — | no |

«Cerrada» = registrada con `readable_roles '{}'` y `writable_roles '{}'`: cumple el lint (toda tabla se registra) pero no sale en `snapshot`, `changes` ni `history`, y `core.commit` no la toca. Solo la escriben triggers y funciones del propio schema.

### 2.1 `booking.reservations`

Una fila = una reserva (regla madre de C03 §2). Es la parte comercial.

```text
code                  text unique            -- RSV_AAAA_NNN, lo pone el trigger; no escribible
title                 text not null          -- 1..200; nombre visible del grupo o evento
event_type            text not null default 'retiro'
                      check in (retiro, convivencia, formacion, encuentro, actividad_divulgativa, alquiler_grupo, otro)
status                text not null default 'en_estudio'
                      check in (en_estudio, negociacion, pre_reservada, confirmada, en_ejecucion, cerrada, cancelada, perdida)
priority              text not null default 'media' check in (alta, media, baja)

start_date            date null
end_date              date null              -- check end_date >= start_date
expected_guests       integer null           -- check >= 0
minors_count          integer not null default 0   -- check >= 0

contact_name          text null
contact_phone         text null
contact_email         text null
customer_type         text null check in (particular, empresa, asociacion, colectivo, organizador_recurrente)

uses_accommodation          boolean not null default true
requires_meals              boolean not null default false
meal_plan_requested         text null check in (no_aplica, desayuno, media_pension, pension_completa, segun_programa)
menu_style_requested        text null check in (vegetariano, vegano, mixto, otro)
meal_notes                  text null
uses_interpretation_center  boolean not null default false
uses_outdoors               boolean not null default false
uses_pool                   boolean not null default false
special_setup               boolean not null default false
technical_support           boolean not null default false
customer_notes              text null

briefing_received     boolean not null default false

internal_notes        text null
archived_at           timestamptz null       -- archivado explícito por el usuario
```

Restricción de coherencia: `status in ('en_estudio','negociacion','cancelada','perdida') or (start_date is not null and end_date is not null and expected_guests is not null)`. Una reserva en estudio puede no tener fechas; desde pre-reserva las necesita (Calendar las exige).

`writable_columns`: todas las anteriores salvo `code`.

Índices: `(start_date) where deleted_at is null`, `(status) where deleted_at is null`, `lower(title)`.

Derivados que **no** se guardan (reglas puras en `domain-booking`, C03 §7):

- `nights = end_date - start_date`.
- `archivada = archived_at is not null`. **[desviación]** C03 lo calculaba (cerrada, cancelada o perdida); el handoff §9.3 lo hace explícito y lo sigo.

### 2.1.1 `booking.reservation_finance`

Importes y datos de pago de la reserva, separados para que `reader` no los reciba (decisión del usuario). **[desviación]** El handoff §4.1 los tenía dentro de `reservations`.

```text
id                    uuid primary key references booking.reservations(id)   -- mismo id que la reserva
budget_amount         numeric(12,2) null     -- check >= 0 en los cuatro importes
final_amount          numeric(12,2) null
deposit_required      numeric(12,2) null
deposit_paid          numeric(12,2) null
payment_type          text null check in (efectivo, tarjeta, transferencia, plataforma_pago, otro)
payment_date          date null
payment_holder        text null              -- titular del medio de pago
```

`writable_columns`: todas. Registro: `readable_roles '{editor,owner}'`, `writable_roles '{editor,owner}'`.

Relación 0..1 con el mismo `id` que la reserva, así que no puede haber dos filas para una reserva (la segunda alta recibe `ROW_EXISTS`). La app la crea en el mismo lote que la reserva; una reserva sin fila de importes es válida y se lee como «sin importes». Al borrar la reserva hay que borrar la fila en el mismo lote: el hook no admite importes vivos de una reserva en la papelera (§4.2).

Derivado, no guardado: `deposit_status` (C03 §7): `deposit_required` nulo o 0 → `no_aplica`; `deposit_paid` nulo o 0 → `pendiente`; `< required` → `parcial`; `>= required` → `completado`.

`payment_type`, `payment_date` y `payment_holder` son los «datos del pago» del anexo I del RD 933/2021 (§2.3.1) y se refieren al pago del organizador: Agram Camp no cobra a los huéspedes. La identificación del medio de pago (número de tarjeta o IBAN) y la caducidad **no se guardan** (decisión del usuario); SES.Hospedajes los marca como opcionales. `payment_type` sí es obligatorio en el parte, así que la cola de envío avisa si falta.

### 2.2 `booking.events`

El evento operativo. Relación `reservation 1 ── 0..1 event`. No duplica título, fechas, contacto ni servicios: la ficha se compone leyendo ambas filas.

```text
code                  text unique            -- EVT_AAAA_NNN, lo pone el trigger; no escribible
reservation_id        uuid not null unique references booking.reservations(id)
                                             -- escribible en el alta, inmutable después (trigger)
responsible_name      text null
arrival_time          time null
departure_time        time null
final_guests          integer null           -- check >= 0

meal_plan_confirmed   text null check in (no_aplica, desayuno, media_pension, pension_completa, segun_programa)
menu_style_confirmed  text null check in (vegetariano, vegano, mixto, otro)

room_distribution     text null              -- texto libre («2p x3 · 4p x2 · Posada 2p x1»)
rooms_count           integer null           -- check >= 0; nº de habitaciones (dato del parte de viajeros)
setup_style           text null check in (no_aplica, basico, circulo, formacion, escenario, personalizado)
technical_needs       text null check in (ninguna, wifi, sonido, proyeccion, mixto, personalizado)
reinforced_cleaning   boolean not null default false
extra_support         boolean not null default false

preparation_status    text not null default 'pendiente' check in (pendiente, en_proceso, hecha)
accommodation_status  text not null default 'pendiente' check in (no_aplica, pendiente, en_proceso, hecho)
kitchen_status        text not null default 'pendiente' check in (no_aplica, pendiente, en_proceso, hecho)
cleaning_status       text not null default 'pendiente' check in (pendiente, en_proceso, hecha)
traveler_registration_status text not null default 'pendiente' check in (no_aplica, pendiente, en_curso, completo)

operational_notes     text null
closed_at             timestamptz null       -- cierre operativo
incidents             text null
post_event_notes      text null
```

`writable_columns`: todas salvo `code`. `reservation_id` tiene que estar en la lista porque `core.apply_row_op` valida la lista blanca también dentro de los procedimientos; un trigger `before update` impide cambiarlo.

El `unique(reservation_id)` es la única barrera a «varios eventos por reserva». Si algún día hiciera falta, se quita con una migración (handoff §5.1).

Derivado, no guardado: la fase del evento (`pendiente_preparacion`, `preparado`, `en_ejecucion`, `cerrado`, `cancelado` de C04) se calcula con `reservations.status`, los estados operativos y `closed_at`.

### 2.3 `booking.guests`

Una fila = una persona alojada en un evento. Los datos son exactamente los «datos de los viajeros» del anexo I, apartado A, del RD 933/2021 (texto consolidado del BOE, consultado el 6 de octubre de 2026), ni uno más (C09 protocolos 8 y 9). **No se guardan imágenes ni copias de documentos, y la tabla no tiene columna para ello.**

```text
code                  text unique            -- HSP_AAAA_NNN, trigger; no escribible
event_id              uuid not null references booking.events(id)   -- inmutable tras el alta
first_name            text not null          -- 1..120
last_name_1           text null
last_name_2           text null
sex                   text null check in (H, M, X)
document_type         text null check in (DNI, NIE, Pasaporte, TIE, Otro)
document_number       text null              -- normalizado: sin espacios, mayúsculas
document_support_number text null            -- número de soporte del documento
nationality           text null              -- ISO 3166-1 alfa-3 (ESP, FRA…)
birth_date            date null
residence_address     text null              -- residencia habitual: calle, número, piso…
residence_postal_code text null
residence_city        text null              -- municipio o ciudad
residence_country     text null              -- ISO 3166-1 alfa-3
phone                 text null
email                 text null
is_minor              boolean not null default false
guardian_name         text null              -- solo si is_minor
kinship               text null              -- relación de parentesco con quien le acompaña; solo si is_minor

signed_at             timestamptz null       -- firma del parte de entrada
signed_by_name        text null              -- quién firma: el huésped o, si es menor, su acompañante
signature_file_id     uuid null              -- imagen de la firma en core.files; nulo si firmó en papel

data_status           text not null default 'pendiente_datos'
                      check in (pendiente_datos, datos_incompletos, datos_recibidos, datos_revisados, no_aplica)
ses_status            text not null default 'pendiente_envio'
                      check in (pendiente_envio, listo_para_envio, enviado_SES, incidencia_envio, no_aplica)
ses_sent_at           timestamptz null
ses_sent_by           text null              -- nombre de quien envió
ses_receipt_ref       text null              -- número de referencia o enlace del justificante
ses_receipt_file_id   uuid null              -- justificante PDF en core.files (ver §8 y P5)
notes                 text null
```

`writable_columns`: todas salvo `code`. Registro: `readable_roles '{editor,owner}'`, `writable_roles '{editor,owner}'`; el filtro fino por `scopes` lo aplica la Edge (§5).

Índice: `(event_id) where deleted_at is null`.

**[desviación]** Respecto a C04 §15 se añaden los datos que el anexo I pide y la hoja no tenía: número de soporte, residencia habitual (dirección, localidad, país), teléfono y correo por separado (antes un único `telefono_email_si_aplica`), parentesco de los menores y el tipo de documento `TIE`.

Coherencias (en `beforeCommit`): `ses_status = 'enviado_SES'` exige `ses_sent_at`; `listo_para_envio` exige `data_status = 'datos_revisados'`; `datos_revisados` exige lo que SES.Hospedajes marca como obligatorio en el parte de viajeros. Reglas tomadas de la especificación oficial del servicio web (`MIR-HOSPE-DSI-WS` v3.1.2, apartados 3.1.1.1, 4.1 y 4.2):

| Dato | Obligatorio en SES |
|---|---|
| Nombre, primer apellido, fecha de nacimiento | siempre |
| Segundo apellido | si el documento es DNI |
| Tipo y número de documento | si es mayor de edad |
| Número de soporte | si el documento es DNI o NIE |
| Dirección, código postal, municipio y país de residencia | siempre |
| Teléfono o correo | al menos uno |
| Parentesco | si es menor de edad |
| Nacionalidad, sexo | opcionales en la plataforma; el anexo I los lista y la app los pide sin bloquear |

Viven como reglas en `domain-booking`, no como `check`, para poder ajustarlas sin migración si la plataforma cambia. La firma no forma parte de estas reglas: SES no la recibe (§2.3.2).

Para un futuro envío automático (fuera de V1) harían falta además el código INE del municipio cuando el país es España y los códigos de los catálogos de la plataforma (tipo de documento, parentesco, tipo de pago); son derivables de lo que se guarda.

Conservación y borrado: ver §5.3.

### 2.3.1 Parte de viajeros: de dónde sale cada dato

El anexo I pide, además de los datos de cada viajero, los de la transacción. No se duplican en `guests`:

| Dato del anexo I (A.3 y A.4) | Origen en Booking |
|---|---|
| Datos de cada viajero | `guests` |
| Número de viajeros | recuento de `guests` del evento |
| Contrato: número de referencia | `reservations.code` |
| Contrato: fecha | alta del evento (`events.created_at`, el momento de confirmar) |
| Contrato: firmas | `guests.signed_at`, `signed_by_name`, `signature_file_id` (§2.3.2) |
| Fecha y hora de entrada y de salida | `reservations.start_date` + `events.arrival_time`; `end_date` + `departure_time` |
| Inmueble: dirección, conexión a Internet | constantes del establecimiento (configuración de la app) |
| Inmueble: número de habitaciones | `events.rooms_count` |
| Pago: tipo, titular, fecha | `reservation_finance.payment_type`, `payment_holder`, `payment_date` |
| Pago: identificación del medio y caducidad de la tarjeta | no se guardan (decisión del usuario; opcionales en SES) |

En el parte, SES exige referencia, fecha del contrato, fecha y hora de entrada y de salida, número de personas y tipo de pago; habitaciones, Internet y el resto de datos del pago son opcionales.

Plazos del decreto: comunicación inmediata y como máximo en 24 horas desde la reserva o formalización y desde el inicio del servicio (art. 6.3); conservación del registro durante tres años desde la finalización del servicio (art. 5.3).

### 2.3.2 Firma del parte de entrada

El anexo I lista «firmas» entre los datos del contrato. La especificación de SES.Hospedajes no tiene ningún campo de firma: no se envía, se conserva en el registro del establecimiento. Dos formas de recogerla, a elegir en cada llegada:

- **En pantalla** (la normal). «Firmar» en la ficha del huésped abre a pantalla completa un resumen de sus datos, el texto informativo de protección de datos y un recuadro para firmar con el dedo. Se guarda como imagen pequeña en `booking-documents` y se anotan `signed_at`, `signed_by_name` y `signature_file_id`. Funciona sin red: la imagen espera en la cola de adjuntos.
- **En papel.** «Imprimir parte» genera una hoja A4 con los datos y la línea de firma (CSS de impresión, sin servicio de PDF). El equipo archiva el papel y marca «Firmado en papel»: `signed_at` y `signed_by_name` con `signature_file_id` nulo. No se escanea.

Quién firma es una regla de `domain-booking`. Por defecto la app pide firma a partir de los 14 años y, por debajo, la del acompañante; es el criterio que dan las guías del sector, pero **no lo he podido verificar en el texto del BOE**.

La imagen de la firma es un dato personal: solo la ve quien ve huéspedes, se conserva los mismos tres años y se elimina al anonimizar (§5.3).

### 2.4 `booking.dietary_restrictions`

Restricciones alimentarias de un evento. Pueden colgar de un huésped concreto o representar a varias personas todavía sin identificar.

```text
event_id              uuid not null references booking.events(id)   -- inmutable tras el alta
guest_id              uuid null references booking.guests(id)
restriction_type      text not null
                      check in (alergia, intolerancia, vegetariano, vegano, sin_gluten, sin_lactosa, preferencia, otra)
subject               text null              -- alérgeno o producto («pistacho»); obligatorio en alergia, intolerancia y otra
severity              text null check in (grave, moderada, leve)   -- solo en alergia e intolerancia
servings              integer null           -- nº de personas cuando no hay guest_id; check >= 1
kitchen_notes         text null              -- sin nombres de personas (lo avisa la UI)
active                boolean not null default true
```

Regla: o `guest_id` (cuenta como 1 y `servings` es nulo) o `servings >= 1`. `writable_columns`: todas.

Lectura abierta a los tres roles a propósito: es lo que cocina y operación necesitan ver. `guest_id` es un uuid opaco para quien no puede leer `guests`. Una alergia nunca se registra como `preferencia` ni al revés: el tipo es cerrado y `severity` solo se admite en alergia e intolerancia.

### 2.5 `booking.checklist_items` (checklist ligero)

```text
event_id              uuid not null references booking.events(id)   -- inmutable tras el alta
checklist_type        text not null check in (preparacion_general, alojamiento, cocina_comedor, salas, salida_rotacion)
label                 text not null          -- 1..200
status                text not null default 'pendiente' check in (pendiente, hecho, no_aplica)
responsible_name      text null
reviewed_on           date null
notes                 text null
position              numeric not null default 0
```

`writable_columns`: todas. Sin tabla de plantillas: los veinte ítems base de C04 §8 viven como constante en `packages/domain-booking` y el botón «Añadir checklist base» genera las altas en un lote normal (funciona sin red y se deshace).

### 2.6 Tablas cerradas

**`booking.calendar_links`**: un enlace por reserva con su evento de Google.

```text
reservation_id              uuid not null unique references booking.reservations(id) on delete cascade
provider                    text not null default 'google_calendar'
calendar_id                 text not null
provider_event_id           text null
generation                  integer not null default 1
html_link                   text null
source_reservation_revision bigint null
source_event_revision       bigint null
sync_status                 text not null default 'pending' check in (pending, synced, error, deleted)
payload_hash                text null
last_synced_at              timestamptz null
last_error                  text null          -- código corto, nunca datos personales
```

**[desviación]** El handoff §11 cuelga el enlace de `event_id`. No puede ser: Calendar muestra la reserva desde `pre_reservada`, cuando todavía no hay evento operativo. La clave es `reservation_id`, igual que en el script legacy (`[[ID_RESERVA=…]]`).

**`booking.calendar_sync_jobs`**: cola de trabajos.

```text
reservation_id              uuid not null references booking.reservations(id) on delete cascade
desired_action              text not null check in (upsert, delete)   -- informativo: el worker recalcula
source_reservation_revision bigint not null
source_event_revision       bigint null
status                      text not null default 'pending' check in (pending, running, done, error, superseded)
attempts                    integer not null default 0
available_at                timestamptz not null default now()
locked_until                timestamptz null
last_error                  text null
```

Índice único parcial `(reservation_id) where status = 'pending'`: como mucho un trabajo pendiente por reserva; un cambio nuevo actualiza el pendiente en vez de apilar otro.

**`booking.event_food_state`**: una fila por evento (`id` = `events.id`, FK con `on delete cascade`), sin columnas propias. Su `revision` es el `event_revision` de la proyección (§7.1).

### 2.7 Códigos humanos

Prefijos `RSV`, `EVT`, `HSP` (ya reservados en el contrato §2.3). Los asigna un trigger `before insert` del schema con `core.next_code(prefijo, año)`, usando el año de alta en `Europe/Madrid`. El cliente nunca envía `code`: una fila creada sin red se muestra «sin código, pendiente de sincronizar» hasta que el servidor confirma. El reintento con el mismo `requestId` devuelve el recibo, así que no consume otro número.

### 2.8 Borrado y papelera

- Una reserva real que cae **no se borra**: pasa a `cancelada` o `perdida`. El borrado lógico es para errores y pruebas.
- Borrar una reserva con evento exige borrar en el mismo lote el evento y sus hijos (lo impone el hook §4.2). El lote lo construye la UI con operaciones de fila, así que se deshace desde el historial.
- «Vaciar papelera»: la UI llama a `trash/purge` con la lista ordenada de hijos a padres (`checklist_items, dietary_restrictions, guests, events, reservation_finance, reservations`). El orden por defecto del núcleo es alfabético y rompería las FK (ver P9).
- Un trigger `before delete` en `reservations` impide la purga física mientras su `calendar_links` conserve un evento vivo en Google.
- Food declara `food.menus.event_id` con `on delete restrict`: un evento con menú no se puede purgar físicamente. Es correcto; la UI lo explica en vez de fallar en silencio.

---

## 3. Procedimientos (`call`)

### 3.1 `booking.confirm_reservation`

Único procedimiento de Booking. Pasa una reserva a `confirmada` y garantiza que existe su evento operativo, en la misma transacción.

Firma real del núcleo: `booking.confirm_reservation(p jsonb) returns jsonb`, con `p = { app, actor, role, requestId, cursor, args }`. Se registra con `core.allow_procedure('booking', 'booking.confirm_reservation')`.

`args`:

```json
{ "reservation_id": "uuid", "event_id": "uuid", "from_status": "pre_reservada", "expectedRevision": 7 }
```

- `event_id`: uuid v4 generado por el cliente para el evento nuevo. Se ignora si la reserva ya tiene evento.
- `from_status`: el estado que el usuario veía al pulsar «Confirmar».
- `expectedRevision`: opcional. Si se envía, modo estricto por revisión de fila.

Pasos:

1. Leer la reserva con `for update`. No existe → `NOT_FOUND`. Borrada → `ROW_DELETED`.
2. Estado actual `cancelada` o `perdida`, o reserva archivada → `INVALID_TRANSITION` (hay que reabrirla antes).
3. Estado actual distinto de `from_status` y distinto de `confirmada` → `STATUS_CHANGED` (409) con el estado actual: otra persona la movió y el usuario decide.
4. Faltan `start_date`, `end_date` o `expected_guests` → `CONFIRM_REQUIREMENTS` (422) con la lista de campos.
5. Evento: si hay uno vivo, se reutiliza. Si hay uno en la papelera, `restore`. Si no hay, `insert` de `booking.events` con `id = event_id` y `fields = { reservation_id }`; el trigger le pone `EVT_AAAA_NNN` y crea su `event_food_state`.
6. Si el estado no es ya `confirmada`, `update` de `status` con la revisión leída bajo bloqueo (o con `expectedRevision` en modo estricto → `VERSION_CONFLICT`).
7. Devuelve `{ reservation_id, event_id, event_code, created, status: "confirmada" }`.

Todas las escrituras van por `core.apply_row_op(app, actor, role, requestId, cursor, op)`, así que salen en `core.changes` y en la respuesta de `commands`.

Idempotencia: mismo `requestId` → recibo. `requestId` nuevo sobre una reserva ya confirmada → cero operaciones de fila y `created: false`. Dos dispositivos que confirman a la vez → un solo evento; el segundo recibe el `event_id` real.

Por qué compara el estado y no la revisión de la fila: confirmar es una decisión sobre el estado. Que otra persona haya corregido un teléfono mientras tanto no debe tumbarla, y el cliente no sabe rebasar un `VERSION_CONFLICT` dentro de un `call`.

Errores propios: `INVALID_TRANSITION 422`, `STATUS_CHANGED 409`, `CONFIRM_REQUIREMENTS 422`. Más los del núcleo (`NOT_FOUND`, `ROW_DELETED`, `ROW_EXISTS` si `event_id` ya existe para otra reserva, `VERSION_CONFLICT`).

Deshacer: el núcleo no deshace lotes con `call` (`UNDO_UNAVAILABLE`). Una confirmación se revierte cambiando el estado; el evento se conserva con su mismo id y código.

### 3.2 Lo que deliberadamente no es un procedimiento

| Acción | Cómo se hace |
|---|---|
| Resto de cambios de estado (`negociacion`, `pre_reservada`, `en_ejecucion`, `cerrada`, `cancelada`, `perdida`, reabrir) | `update` de `status`; el hook exige evento donde toca |
| Cierre operativo | `update` de `events` (`closed_at`, `incidents`, `post_event_notes`) |
| Archivar / desarchivar | `update` de `archived_at` |
| Checklist base | lote de `insert` generado en cliente |
| Borrar reserva con evento | lote de `delete` (hijos y padre), solo `owner` |

Las transiciones son abiertas: es una herramienta de un equipo pequeño y un estado mal puesto se corrige. Solo se protege lo que rompería datos.

### 3.3 Funciones internas (no `call`)

Solo `service_role`; las invoca la Edge (requiere P1):

| Función | Uso |
|---|---|
| `booking.calendar_claim(p_limit int, p_reservation_ids uuid[])` | reclama trabajos vencidos (`for update skip locked`) y devuelve cada uno con las filas de reserva y evento necesarias para construir el payload |
| `booking.calendar_report(p_job uuid, p_outcome jsonb)` | anota el resultado en el trabajo y en `calendar_links`; calcula la siguiente espera |
| `booking.calendar_status(p_reservation_ids uuid[])` | estado de los enlaces para la UI |
| `booking.calendar_retry(p_reservation uuid)` | reencola a mano |
| `booking.guest_summary(p_event uuid)` | recuentos sin identificar (§6) |

---

## 4. Validación

### 4.1 `beforeCommit` (Edge, reglas compartidas con el cliente en `domain-booking`)

- Tipos, longitudes, enumerados, enteros e importes no negativos, `end_date >= start_date`, `minors_count <= expected_guests`, horas `HH:MM`, correo con forma de correo.
- `booking.events`: `insert` directo rechazado (`INVALID_OPERATION`: «usa confirmar»); `delete` y `restore` solo `owner`; `reservation_id` no admitido en `update`.
- `booking.guests`: cualquier operación exige ver huéspedes (§5.1) → si no, `FORBIDDEN`. Coherencias de §2.3. `ses_receipt_file_id` y `signature_file_id`, si vienen, deben existir en `core.files` de la app.
- `event_id` de huéspedes, restricciones y checklist no admitido en `update`.
- `dietary_restrictions`: regla `guest_id` / `servings`; `subject` obligatorio según tipo; `severity` solo en alergia e intolerancia.

El deshacer del núcleo salta este hook (`skipHooks`), por eso lo estructural está también en SQL.

### 4.2 `validate_hooks` (SQL)

`booking.check_invariants(p jsonb)`, registrado con `core.add_validate_hook`. Corre al final de cada lote. Son anti-joins indexados sobre tablas de cientos de filas.

| Invariante | Error |
|---|---|
| Reserva viva en `confirmada`, `en_ejecucion` o `cerrada` ⇒ tiene evento vivo | `EVENT_REQUIRED 422` |
| Fila de `reservation_finance` viva ⇒ su reserva está viva | `ORPHAN_FINANCE 422` |
| Evento vivo ⇒ su reserva está viva | `ORPHAN_EVENT 422` |
| Huésped, restricción o ítem de checklist vivo ⇒ su evento está vivo | `ORPHAN_CHILD 422` |
| Restricción con `guest_id` ⇒ huésped vivo y del mismo evento | `GUEST_MISMATCH 422` |

El lint de migraciones no deja leer `core.changes` desde una migración de app, así que el hook comprueba el estado global y no «las filas tocadas en este lote». Con estos volúmenes da igual.

Además, triggers del schema: asignación de códigos, inmutabilidad de `reservation_id` y `event_id`, alta de `event_food_state`, avance de `event_food_state` (§7.1) y encolado de Calendar (§7.3).

---

## 5. Visibilidad y permisos

### 5.1 Ámbitos

`core.memberships.scopes` para `booking`:

```json
{ "guests": true }
```

- `owner`: ve y edita huéspedes siempre.
- `editor`: solo con `scopes.guests === true` («responsable operativo designado» del protocolo 9 de C09). Por defecto, no.
- `reader`: nunca; el núcleo ya no le entrega la tabla.

```ts
function visible(table, row, ctx) {
  if (table !== 'booking.guests') return true;
  return ctx.membership.role === 'owner'
      || (ctx.membership.role === 'editor' && ctx.membership.scopes?.guests === true);
}
```

`_kit` aplica el hook en `snapshot`, `changes` e `history`. El resto de tablas se ven con la membresía.

Los importes y datos de pago viven en `reservation_finance`, que el núcleo no entrega a `reader` (`readable_roles '{editor,owner}'`); no hace falta hook. Un lector ve la reserva sin el bloque Cobro.

### 5.2 Qué sale del dominio y qué no

| Destino | Recibe | Nunca recibe |
|---|---|---|
| Food (proyección) | recuentos, régimen, restricciones agregadas sin identificar | huéspedes, documentos, fechas de nacimiento, nacionalidad, SES, contacto |
| Google Calendar | título, fechas, contacto de la reserva, datos operativos | huéspedes, restricciones, datos SES |
| Registros y `last_error` | códigos de error | cualquier dato personal |

### 5.3 Datos personales de huéspedes

- **En el dispositivo.** Quien ve huéspedes los tiene en su IndexedDB. Al cerrar sesión, y cuando `bootstrap` indique que perdió el permiso, la app borra la base local `ikisai-booking-v1`. Hoy `sync-client.logout()` solo borra la sesión (ver P4); mientras tanto lo hace la app con `client.stop()` + `indexedDB.deleteDatabase`. Si hay cambios pendientes de enviar, avisa antes.
- **En el historial.** `core.changes` guarda el antes y el después de cada huésped para siempre. Anonimizar la fila con un `update` no limpia esas imágenes.
- **Conservación: tres años desde `reservations.end_date`.** Es el plazo del art. 5.3 del RD 933/2021 («tres años a contar desde la finalización del servicio o prestación contratada»), comprobado en el texto consolidado del BOE. Vencido el plazo, C09 pide anonimizar dejando un rastro mínimo: se vacían nombre, apellidos, número de documento y de soporte, fecha de nacimiento, residencia, teléfono, correo, tutor, parentesco y firmante, se elimina la imagen de la firma, y quedan código, evento, tipo de documento, nacionalidad, sexo y estados de envío. La pantalla Huéspedes muestra al `owner` los huéspedes con plazo vencido. Para anonimizar de verdad hace falta P6 (redactar columnas en el historial); con lo que hay hoy, la única opción es el borrado total con `core.purge_row_history`, que pierde también el rastro. Salvo que se carguen estancias antiguas, ningún dato vence antes de octubre de 2029, así que P6 no bloquea V1.
- **Derecho de supresión.** A petición, por Core, con `core.purge_row_history`, dejando constancia fuera de la app.
- **Copias de seguridad.** Van cifradas (ya resuelto por Core).

---

## 6. Rutas propias (`/api/v1/...`)

Casi toda la lectura se resuelve en el cliente contra el espejo local (Inicio, listas, ficha, calendario, búsqueda), que es lo que permite trabajar sin red. Por eso las rutas del handoff §25 no existen como tales: `GET/POST/PATCH reservations`, `events`, `guests` y `dietary-restrictions` son `snapshot`, `changes` y `commands` del núcleo. Solo quedan en el servidor las rutas que necesitan algo que el cliente no tiene.

| Método y ruta | Entrada | Salida | Rol mínimo |
|---|---|---|---|
| `POST calendar/tick` | `{ limit?, reservationIds? }` opcional | `{ processed, failed, pending, health }`: reclama y procesa un lote de la cola | editor |
| `GET calendar/status` | `?reservationIds=a,b` opcional | `{ configured, calendarId, health, items: [{ reservationId, syncStatus, lastSyncedAt, lastError, htmlLink, pendingJob, attempts, nextAttemptAt }] }` | reader |
| `POST calendar/:reservationId/retry` | — | `{ queued: true }` | editor |
| `POST read/booking.guest_summary` | `{ event_id }` | `{ eventId, total, bySex: { H, M, X, sinDato }, minors, signed, dataStatus: {…}, sesStatus: {…} }` | reader |
| `GET read/booking.food_event_projection?where[event_id]=…` | filtros de igualdad, `limit`, `offset` | `{ rows, total }` con las columnas de §7.1 | reader |

- **Cómo avanza la cola:** (1) tras cada commit que toca una reserva o su evento, `afterCommit` procesa en segundo plano los trabajos de esas reservas; (2) el planificador de Core llama cada 5 minutos a `POST /api/v1/worker/calendar/tick` con `X-Ikisai-Worker-Key` (ruta de sistema, sin usuario); (3) un editor puede empujarla a mano con `POST calendar/tick`. Sin los secretos de Google el tick no reclama nada y responde `health: 'not_configured'`.
- **Bloqueo por acceso.** Si Google rechaza las credenciales o el calendario no está compartido con la cuenta de servicio (o lo está solo para lectura), el trabajo vuelve a `pending` sin gastar intentos y con `last_error` `GOOGLE_AUTH_ERROR`, `CALENDAR_NOT_SHARED` o `CALENDAR_READ_ONLY`; el tick deja de llamar a Google hasta la siguiente vuelta. No es un fallo del trabajo: lo arregla una persona y, en cuanto se arregla, la cola se vacía sola.
- En SQL, `booking.calendar_claim` y `booking.calendar_report` son acciones registradas sin roles de usuario (solo sistema); `booking.calendar_retry` es acción de editor y propietario; `booking.calendar_status` es lectura para todos los roles.
- `health` ∈ `ok | not_configured | auth_error | calendar_not_shared`. Se deriva de lo que la cola dejó anotado, así que la app lo enseña aunque nadie esté lanzando el tick.
- `booking.guest_summary` da a quien no ve huéspedes los recuentos del canon §10 («24 huéspedes · 13 mujeres · 10 hombres · 2 menores»). Quien sí los ve lo calcula en local. Es una lectura registrada con `core.allow_read` (contrato §5.1), no una ruta propia.
- La proyección de Food también está registrada para la propia app `booking`, para poder comprobar desde Booking qué está viendo cocina.
- Errores: los del núcleo más `NOT_FOUND` si la reserva o el evento no existen.

Sin exportación de huéspedes en V1: un CSV con documentos es justo lo que el protocolo 9 quiere evitar. La pantalla ofrece copiar campo a campo para el envío manual a SES.

---

## 7. Proyecciones, enlaces e integración con Calendar

### 7.1 `booking.food_event_projection`

Columnas normativas del contrato §8, en este orden:

| Columna | Origen |
|---|---|
| `event_id` | `events.id` |
| `event_code` | `events.code` |
| `reservation_code` | `reservations.code` |
| `title` | `reservations.title` |
| `event_type` | `reservations.event_type` |
| `start_date`, `end_date` | `reservations` |
| `arrival_time`, `departure_time` | `events` |
| `guest_count` | `coalesce(events.final_guests, reservations.expected_guests)` |
| `minors_count` | `reservations.minors_count` |
| `meal_plan` | `coalesce(events.meal_plan_confirmed, reservations.meal_plan_requested)` |
| `menu_style` | `coalesce(events.menu_style_confirmed, reservations.menu_style_requested)` |
| `dietary_restrictions` | `jsonb`: lista de `{ type, subject, severity, servings, kitchen_notes }` |
| `event_revision` | `event_food_state.revision` |

Filas: eventos vivos de reservas vivas. `grant select` solo a `service_role`.

`dietary_restrictions` sale agregado y sin identificar: restricciones activas y vivas, agrupadas por tipo, sujeto normalizado, gravedad y nota, sumando `coalesce(servings, 1)`. Dos huéspedes veganos y «2 veganos» sin identificar dan lo mismo: `{ "type": "vegano", "servings": 2 }`. No lleva `guest_id` ni el id de la restricción.

**`event_revision` [desviación, a coordinar con Food].** El handoff §19 usa `events.revision`. No sirve tal cual por dos motivos:

1. Las fechas viven en `reservations` y las restricciones en su tabla: cambiarlas no mueve `events.revision`, y Food no se enteraría.
2. `events.revision` sube con cualquier campo operativo. Marcar «limpieza hecha» pondría el menú en «revisar».

Por eso `event_revision` es el contador de `event_food_state`, que avanza por trigger solo cuando cambia algo que afecta a cocina:

- `reservations`: `title`, `event_type`, `start_date`, `end_date`, `expected_guests`, `minors_count`, `requires_meals`, `meal_plan_requested`, `menu_style_requested`, `meal_notes`, `status`, `deleted_at`.
- `events`: `arrival_time`, `departure_time`, `final_guests`, `meal_plan_confirmed`, `menu_style_confirmed`, `deleted_at`.
- `dietary_restrictions`: cualquier alta, cambio, baja o restauración.

Para Food no cambia nada: guarda `source_event_revision` y compara. El contador es monótono y no retrocede con la purga. `food.menus.event_id` sigue apuntando a `booking.events`.

**Ampliación propuesta (P10).** Cuatro columnas más, sin datos personales:

| Columna | Origen | Para qué |
|---|---|---|
| `reservation_status` | `reservations.status` | que Food distinga un evento cancelado de uno activo y deje de pedir menú y compra |
| `guest_count_is_final` | `events.final_guests is not null` | distinguir personas finales de previstas |
| `requires_meals` | `reservations.requires_meals` | no proponer menú a un grupo sin comidas |
| `meal_notes` | `reservations.meal_notes` | notas de alimentación del cliente |
| `reservation_id` | `reservations.id` | abrir la ficha de la reserva desde Food (migración 0404) |

Las dos primeras las pide Food en su documento (`docs/food/API.md` §7.1, su petición P5), igual que el `event_revision` monótono descrito arriba y los catálogos cerrados de `meal_plan` y `menu_style`, que son los `check` de §2.1 y §2.2. Si Core prefiere la lista exacta del contrato, las cuatro se quedan fuera y la vista filtra a `confirmada`, `en_ejecucion` y `cerrada`.

### 7.2 Lo que lee Invoices

Invoices asigna líneas de compra a un evento de Booking. Decisión de Core (ronda 5): **reutiliza `booking.food_event_projection`**, registrada también para la app `invoices` (migración `20261006_0402`). No se crea una vista aparte: la proyección no lleva huéspedes ni datos personales, y sus columnas de identificación (`event_id`, `event_code`, `reservation_code`, `title`, fechas, `reservation_status`, `event_revision`) son las que Invoices necesita. Solo hay eventos en la proyección, así que una reserva sin confirmar no es asignable.

**Coste real por retiro (fase 2).** Booking lee `invoices.booking_cost_projection`, que Invoices registra para la app `booking` (`GET /api/v1/read/invoices.booking_cost_projection?where[target_id]=…`). Columnas: `allocation_id, target_kind, target_id, invoice_code, invoice_date, supplier_name, expense_category, is_investment, allocated_amount, allocation_revision`. La ficha de la reserva la consulta para el id de la reserva y el de su evento y muestra, dentro de Cobro y solo a quien ve importes, el total asignado, el desglose por categoría y las asignaciones con su código de factura. Se guarda la última respuesta en el dispositivo (se borra al cerrar sesión) para verla sin red. Booking no escribe nada en Invoices ni guarda estos importes en sus tablas. Enlaces (`docs/invoices/API.md` §9.6): factura `https://invoices.ikisai.com/#/facturas/<código>`; compras de la reserva `#/compras?destino=booking:reservation:<id>` (o `booking:event:<id>`).

**Agentes de IA** (contrato §3.1). Además de lo que el núcleo ya exige aprobar (borrados, `booking.confirm_reservation`, lotes de 10 o más filas), el hook `agentRisk` de Booking pide aprobación humana para cancelar o dar por perdida una reserva, archivarla, cualquier cambio en huéspedes y cualquier cambio en importes. La única acción marcada segura es `booking.calendar_retry`.

### 7.3 Google Calendar

Supabase manda; Calendar es una proyección de una sola dirección. Una edición manual en Google no cambia la reserva y se sobrescribe en la siguiente sincronización.

**Acceso. [desviación]** El handoff §10 proponía un puente Apps Script firmado con HMAC. El plan de Core lo sustituye por una cuenta de servicio de Google; el puente queda como plan B documentado en `integrations/calendar/`. La Edge firma un JWT RS256 con la clave de la cuenta (WebCrypto), lo cambia por un token de acceso (ámbito `https://www.googleapis.com/auth/calendar`), lo guarda en memoria hasta poco antes de caducar y llama a la API v3. Implementado en `booking-api/calendar/google.ts`; se activa solo si existen los dos secretos. Secretos de la función: `GOOGLE_SERVICE_ACCOUNT_JSON` (la clave JSON completa de la cuenta de servicio, la carga Core) y `BOOKING_CALENDAR_ID` (ver P7). El calendario «Agram Camp - Reservas» se comparte con la cuenta de servicio con permiso de modificar eventos. Sin secretos, la integración queda apagada: los trabajos esperan y la UI dice «Calendar no configurado».

**Estado deseado** (regla pura en `domain-booking`):

| Situación de la reserva | En Calendar |
|---|---|
| `pre_reservada`, `confirmada`, `en_ejecucion` | presente |
| `cerrada` | se conserva como está (ni se actualiza ni se borra) |
| `en_estudio`, `negociacion` | ausente |
| `cancelada`, `perdida` | ausente (se borra) |
| archivada (`archived_at`) o en la papelera | ausente (se borra) |

**[desviación menor]** El script legacy no retiraba el evento si una pre-reserva volvía a `negociacion`. Como proyección, lo coherente es que el evento exista solo en los estados publicables.

**Payload.**

- Título: `[PRE] <title>` en `pre_reservada`; `<title>` en el resto.
- Color (`colorId`): `pre_reservada` → `5` amarillo; `confirmada` → `10` verde; `en_ejecucion` → `9` azul. Son los mismos que usaba `CalendarApp.EventColor`.
- Fechas, con `timeZone: Europe/Madrid`:
  - Con hora de llegada **y** de salida: evento con horario, de `start_date + arrival_time` a `end_date + departure_time`. Si el fin no es posterior al inicio, se suma un día (regla legacy).
  - En cualquier otro caso, día completo. Con una sola hora no se inventa la otra.
  - Día completo: `start.date = start_date`, `end.date = end_date + 1` (el fin es exclusivo en Google). Una estancia de viernes a domingo ocupa viernes, sábado y domingo. **[desviación, decisión del usuario]** El script legacy no incluía el día de salida.
- Descripción, texto plano en este orden: marcadores `[[IKISAI_CALENDAR_SYNC]]` y `[[ID_RESERVA=RSV_…]]`; reserva (código, estado, contacto, personas previstas y finales); operación si hay evento (código, responsable, llegada y salida, montaje, número de habitaciones, estados de preparación, alojamiento, cocina y limpieza); alimentación (régimen solicitado y confirmado, tipo de menú); notas (`customer_notes`, `operational_notes`). La distribución de habitaciones (`room_distribution`) y las notas de alimentación quedan fuera: son texto libre y pueden llevar nombres de huéspedes.
- Nunca: huéspedes, documentos, fechas de nacimiento, SES, restricciones alimentarias, importes, notas internas.
- `extendedProperties.private`: `ikisaiReservationId`, `ikisaiReservationCode`.

**Identidad e idempotencia.** El evento se crea con id elegido por nosotros: `iki` + uuid de la reserva sin guiones + `g` + `generation` (caracteres válidos de base32hex). Crear dos veces no puede duplicar: la segunda devuelve 409 y se convierte en actualización. `calendar_links.provider_event_id` guarda el id efectivo.

Primera sincronización de una reserva (sin enlace): antes de crear se busca por `[[ID_RESERVA=<code>]]` en ±1 año y, si aparece un evento con ese marcador, se **adopta** (se guarda su id y se actualiza). Es el respaldo que pide el handoff §9.7. No se espera encontrar nada: el usuario confirma que el Apps Script y el calendario están hoy sin uso, así que no hay transición que coordinar.

Si alguien borró el evento a mano en Google, la actualización lo reactiva (`status: confirmed`); si Google no lo permite (el id queda ocupado), el worker sube `generation` y crea el evento de nuevo. El segundo camino está probado contra un Google simulado; **falta comprobarlo contra Google real**.

**Cola y reintentos.**

1. Un trigger en `reservations` y otro en `events` encolan dentro de la misma transacción del guardado, cuando el estado es publicable o ya existe enlace. El guardado no depende de Google.
2. Tras un commit correcto, `afterCommit` lanza el worker para las reservas tocadas sin retrasar la respuesta.
3. El worker reclama trabajos, construye el payload con las filas **actuales** y calcula su hash. Si coincide con `payload_hash` y el enlace está `synced`, no llama a Google. Así «guardar sin cambios» no hace nada.
4. Éxito → trabajo `done`, enlace `synced` (o `deleted`) con las revisiones de origen.
5. Fallo recuperable (red, 5xx, 429, tiempo agotado) → `attempts + 1` y espera `min(6 h, 1 min · 4^(n-1))`. A los 8 intentos, trabajo y enlace en `error`.
6. Fallo no recuperable (403 sobre el calendario, calendario inexistente, credenciales inválidas) → `error` inmediato y `health` global distinto de `ok`.
7. Reintento manual: `POST calendar/:reservationId/retry`.
8. Los trabajos `done` y `superseded` de más de 30 días los limpia el propio worker.

Como red de seguridad, la obsolescencia se ve comparando `source_reservation_revision` y `source_event_revision` del enlace con las revisiones actuales (contrato §8); `calendar_status` lo devuelve como `pendingJob`.

**Qué va en cada sitio.**

| Lugar | Contenido |
|---|---|
| `packages/domain-booking` | `calendarProjection(reservation, event)` → estado deseado y payload; reglas puras con pruebas |
| `supabase/functions/booking-api/calendar/` | cliente de Google (JWT, token, llamadas), worker, rutas. Tiene que vivir aquí porque el despliegue solo empaqueta la carpeta de la función y `_kit` |
| `integrations/calendar/` | instrucciones de alta (proyecto GCP, cuenta de servicio, compartir calendario), servidor falso de Calendar para pruebas, script de la prueba real, plan B Apps Script |

---

## 8. Archivos

Bucket `booking-documents` (ya creado por Core, 15 MB). Dos usos en V1:

- El justificante de envío a SES (`guests.ses_receipt_file_id`). PDF tal cual; imagen recomprimida en cliente según el contrato §6.2 (punto 5). Alternativa sin archivo: `ses_receipt_ref` con el número de referencia.
- La imagen de la firma del parte (`guests.signature_file_id`, §2.3.2): WebP o PNG de pocos KB generado en el propio recuadro de firma.

Ambos contienen datos personales: los sirve `GET files/:id` con URL firmada de 10 minutos y la app solo los ofrece a quien ve huéspedes. `_kit` comprueba la membresía, no el ámbito; lo anoto en P5.

Para que el comando lleve el `file_id` de un adjunto que todavía está en cola hace falta el enlace adjunto → `file_id` en `sync-client` (P13).

Nunca se suben copias ni fotos de DNI o pasaporte: la UI no lo ofrece y `uploads` de Booking solo se usa desde el recuadro de firma y la pantalla de envío a SES.

---

## 9. Pantallas y navegación

Cuatro entradas: **Inicio · Reservas · Calendario · Huéspedes**. Barra inferior en móvil, lateral en escritorio. Regla del canon: primero el estado, después el detalle; lectura antes que formulario. Componentes de `packages/ui-kit` (barra de sincronización, banner de conflicto, lista con «pendiente de sincronizar»).

### 9.1 Inicio

Responde a «¿qué viene?» y «¿qué requiere atención?». Todo se calcula en local.

- **Próximas**: reservas en `pre_reservada`, `confirmada` o `en_ejecucion` por fecha. Tarjeta con fecha, título, personas, noches y estado.
- **Avisos**, una línea cada uno y solo si hay algo: pre-reservas pendientes de confirmar; señales pendientes o parciales (solo `editor` y `owner`); eventos a menos de 30 días sin número final; reservas próximas sin briefing; Calendar con error; huéspedes sin comunicar a SES de eventos que empiezan en menos de 24 horas o ya empezados (solo quien los ve).

Sin gráficas ni indicadores decorativos.

### 9.2 Reservas

- Lista de tarjetas: título, fechas, personas, tipo y régimen, estado.
- Filtros: Próximas · Activas · Pre-reservas · Confirmadas · Cerradas · Canceladas. Las archivadas quedan fuera salvo en «Archivadas» del menú.
- Búsqueda por nombre, contacto y código.
- **Ficha**, en modo lectura: cabecera (título, fechas, personas, `RSV_…`, estado, indicador de Calendar), acción principal «Editar», acciones secundarias en `⋮` (cambiar estado, confirmar, archivar, historial, papelera). Bloques:
  - **Resumen**: fechas y noches, personas previstas y finales, tipo, contacto, servicios, régimen, estado comercial y operativo.
  - **Operación** (si hay evento): llegada, salida, responsable, estados, montaje, distribución, checklist por tipo, cierre. Las tareas de cada lista del checklist se reordenan a mano (`position`).
  - **Huéspedes**: recuentos; lista completa solo para quien los ve.
  - **Comidas**: régimen solicitado y confirmado, tipo de menú, notas, restricciones («1 alergia a pistacho · 2 veganos»).
  - **Cobro** (solo `editor` y `owner`): presupuesto, importe final, señal y su estado derivado, tipo, titular y fecha del pago. Debajo, **Coste real**: lo que Invoices tiene asignado a la reserva y a su evento (§7.2).
- **Edición**, por bloques: datos principales; contacto; servicios (interruptores; «Comidas» despliega régimen, tipo y notas); alimentación; comercial; más información (plegado). «Guardar» y «Cancelar»; en móvil «Guardar» queda fijo abajo mientras hay cambios.
- «Confirmar» es un botón propio con resumen de lo que va a pasar («se crea el evento operativo») y la lista de lo que falta si no se puede.

### 9.3 Calendario

Vista propia de la app, no un Google incrustado: mes y agenda con las reservas del espejo local y los mismos colores que en Google. Funciona sin red. Tocar una reserva abre su ficha.

Panel plegable «Google Calendar»: estado general, reservas con sincronización pendiente o con error, «Reintentar» y enlace «Abrir en Google Calendar».

### 9.4 Huéspedes

- Selector de evento (próximos primero) y recuentos.
- Quien ve huéspedes: lista con estado de datos y de envío; alta y edición en formulario por bloques (identidad, documento, residencia y contacto, menor con tutor y parentesco), que marca en cada momento qué falta para SES según el tipo de documento y la edad; restricciones alimentarias de la persona en la misma ficha.
- Firma del parte: «Firmar» en pantalla o «Imprimir parte» y «Firmado en papel» (§2.3.2). La lista muestra quién ha firmado.
- Cola «Pendientes de envío SES» (`datos_revisados` + `listo_para_envio`), con el plazo de 24 horas a la vista, copia campo a campo (incluidos los datos de la transacción de §2.3.1) y registro del envío (fecha, responsable, justificante).
- Para `owner`: lista de huéspedes con el plazo de conservación vencido (§5.3).
- Quien no los ve: solo recuentos y el texto «Acceso restringido a responsables designados».
- Recordatorio fijo en el formulario: no se guardan copias de documentos.

---

## 10. Offline

**Espejo local**: `reservations`, `events`, `dietary_restrictions`, `checklist_items`; `reservation_finance` solo para `editor` y `owner`; `guests` solo para quien la ve. Las tablas cerradas no se piden (`options.tables` explícito).

**Sin red se puede**: crear y editar reservas, cambiar estados, editar la operación, marcar checklist, dar de alta y editar huéspedes y restricciones, archivar, borrar. Cada cambio queda «pendiente de sincronizar» y la barra muestra red, pendientes y conflictos (contrato §6.4).

**Confirmar sin red.** El `call` se encola, pero `sync-client` no aplica nada en local para un `call`. La app guarda una marca propia por `requestId` y muestra «Confirmación pendiente de enviar» en la ficha; el bloque Operación aparece cuando el servidor responde. Si el servidor la rechaza (`STATUS_CHANGED`, `CONFIRM_REQUIREMENTS`), la marca pasa a aviso con el motivo. Con P3 sería optimista del todo.

**Códigos.** Una reserva o un huésped creados sin red no tienen código hasta sincronizar; la UI muestra el título y «código pendiente».

**Calendar.** El trabajo se encola en el servidor cuando llega el commit. Sin red, el indicador dice «se actualizará al reconectar». El último `calendar/status` se guarda para pintar el indicador.

**Conflictos.** Campos distintos se fusionan solos con aviso discreto (por ejemplo, una persona cambia el teléfono y otra las fechas). El caso típico de solape es que dos personas cambien `status` o `final_guests`: va al banner de conflicto con ambas versiones. Borrar contra una fila modificada pide confirmación siempre.

**Adjuntos.** La firma en pantalla y el justificante SES entran en la cola de adjuntos; el comando que los referencia no se envía hasta que la subida se verifica (P13).

**Cierre de sesión.** Borra la base local (§5.3).

---

## 11. Aceptación

### 11.1 Recorrido (handoff §32 A–E e I, adaptado)

En PC y en Android. Calendar con el servidor falso en CI y una pasada real al final.

**A. Reserva**

1. Iniciar sesión.
2. Crear la reserva «Retiro Test».
3. Fechas de viernes a domingo.
4. 20 personas previstas.
5. Alojamiento y pensión completa.
6. Estado `negociacion`.
7. Comprobar que **no** hay evento en Calendar ni trabajo encolado.

**B. Pre-reserva**

8. Cambiar a `pre_reservada`.
9. Calendar crea un único evento.
10. Título `[PRE] Retiro Test`, color amarillo.
11. Evento de día completo que ocupa viernes, sábado y domingo.
12. Guardar otra vez sin cambios: ni otro evento ni llamada a Google (mismo hash).

**C. Confirmación**

13. «Confirmar».
14. Se crea `EVT_…` una sola vez; repetir la orden no crea otro.
15. Calendar actualiza el mismo evento.
16. Desaparece `[PRE]`.
17. Color verde.

**D. Operación**

18. Llegada 17:00.
19. Salida 12:00.
20. 22 personas finales.
21. Calendar pasa a horario real (viernes 17:00 → domingo 12:00).
22. La proyección devuelve `guest_count = 22` y `event_revision` ha subido. Hasta que exista Food se verifica contra la vista.

**E. Restricciones**

23. Añadir 1 alergia a pistacho y 2 veganos.
24. La proyección las devuelve agregadas, sin `guest_id` ni datos de huésped; `event_revision` sube.

**I. Cancelación**

50. Cancelar la reserva.
51. Calendar elimina el evento.
52. La reserva y el evento siguen en PostgreSQL.

**Añadidos de Booking**

- G1. Un `editor` sin `scopes.guests` no recibe huéspedes en `snapshot`, `changes` ni `history`, y no puede escribirlos; un `reader`, tampoco.
- G2. Alta de huésped con todos los datos del anexo I; la app no deja marcar `datos_revisados` a un adulto con DNI sin segundo apellido ni número de soporte, ni a un menor sin parentesco; firma en pantalla; registro del envío a SES con justificante.
- G4. «Imprimir parte» produce una hoja A4 correcta y «Firmado en papel» deja constancia sin imagen.
- G3. Un `reader` no recibe `reservation_finance` en `snapshot`, `changes` ni `history`, y su ficha no muestra el bloque Cobro.
- K1. Google caído: la reserva se guarda, el indicador pasa a pendiente y luego a error, y «Reintentar» lo resuelve al volver.
- K2. Archivar una reserva cerrada retira su evento de Calendar.
- V1. Conflicto 409 visible con dos sesiones sobre el mismo campo.

### 11.2 Automatización

- **Conformidad del núcleo** (`packages/test-kit`): los 13 escenarios contra `booking-api`, antes de cualquier ruta propia.
- **SQL en PGlite**: checks de estado y fechas, unicidad del evento, códigos sin duplicar en reintentos, las cuatro invariantes del hook, `confirm_reservation` (idempotencia, carrera entre dos confirmaciones, `STATUS_CHANGED`, `CONFIRM_REQUIREMENTS`), avance de `event_revision` solo con campos relevantes, proyección sin datos personales (lista de columnas comprobada).
- **Calendar con servidor falso**: crear, actualizar, borrar, idempotencia por id, adopción de evento legacy, tiempo agotado, error recuperable y no recuperable, trabajo pendiente, reintento, sustitución de trabajos.
- **Playwright sin red** (batería compartida más propios):
  - O1. Crear una reserva sin red, recargar, reconectar: se sincroniza y recibe código.
  - O2. Editar la operación sin red y reconectar.
  - O3. Confirmar sin red: marca de pendiente y evento al reconectar.
  - O4. Conflicto disjunto (teléfono contra fechas): fusión automática.
  - O5. Conflicto solapado en `status`: decisión humana.
  - O6. Firma en pantalla y justificante SES subidos en diferido.
  - O7. Cerrar sesión borra la base local.
- **Prueba real** al final: una pasada sintética completa contra «Agram Camp - Reservas» (hoy sin uso, decisión del usuario), borrando el evento al terminar.
- Datos siempre sintéticos. Ningún huésped real en fixtures ni capturas.

---

## 12. Reparto entre agentes

Tras la aprobación de este documento:

| | Backend | Frontend |
|---|---|---|
| Directorios | `supabase/migrations/*_booking_*`, `supabase/functions/booking-api`, `packages/domain-booking`, `integrations/calendar`, `tests/booking/api`, `tests/booking/sql` | `apps/booking`, `tests/booking/e2e` |
| Compartido | `packages/domain-booking` lo escribe backend; frontend propone cambios por PR | `docs/booking/ESTADO.md` lo mantienen ambos |

Orden y verticales (fases 2–4 del handoff §34):

| Fase | Backend | Frontend |
|---|---|---|
| B1 · Reservas base | migración `booking_base` (app, `reservations`, `reservation_finance`, `events`, códigos, `confirm_reservation`, hook), `booking-api` sobre `_kit`, conformidad | shell, login, Reservas (lista, ficha, edición), Inicio |
| B2 · Huéspedes y restricciones | migración `booking_guests` (`guests`, `dietary_restrictions`, `checklist_items`, `event_food_state`, proyección), `visible`, `guest-summary` | Huéspedes, restricciones, checklist, borrado local al salir |
| B3 · Calendar | migración `booking_calendar` (enlaces, cola, triggers, funciones), cliente de Google, worker, rutas, servidor falso | Calendario, indicador y panel de sincronización |
| B4 · Publicación | prueba real, documentación de despliegue y recuperación | recorrido en PC y Android, `booking.ikisai.com` |

Backend puede adelantar B2 y B3 aunque la UI vaya detrás. Cada migración toca solo `booking` y usa únicamente los helpers de `core` que admite el lint.

La migración de B1 va la primera y cuanto antes: Food necesita que `booking.events` exista en la secuencia antes de su migración de menús (su petición P7).

---

## 13. Peticiones a Core

El estado de cada una y la respuesta de Core se llevan en `docs/booking/PETICIONES.md`; esta tabla conserva el planteamiento original. Tres coinciden con lo que ya piden otros equipos: P1 con la P1 de Food y la petición 3 de Invoices; P5 con la P4 de Food; P10 con la P5 de Food. Me sumo además a la P2 de Food (traducir los SQLSTATE de clase 23 a 422): sin ella, una violación de `unique` o de FK que se escape de `beforeCommit` bloquea la cola del dispositivo.

| Nº | Petición | Por qué | Si no se hace |
|---|---|---|---|
| **P1** | Poder invocar funciones `booking.*` (y leer la vista de proyección) desde la Edge con la service key | PostgREST solo expone `public` y el lint prohíbe wrappers `public.*` en migraciones de app. Hoy una Edge de app no puede ejecutar nada propio en su schema | **Bloquea** el worker de Calendar, `guest-summary` y la lectura de la proyección por Food |
| **P2** | Empaquetar `packages/domain-booking` en el despliegue de la función | `deploy_supabase_function.py` solo sube `<app>-api/` y `_kit/`; el contrato §7 dice que Edge y frontend comparten el paquete | **Bloquea** la validación compartida; habría que duplicar reglas |
| P3 | `sync-client`: efectos locales declarados para un `call` (filas a pintar como pendientes hasta la respuesta) | Confirmar sin red no se refleja en el espejo | Marca propia de la app (§10) |
| P4 | `sync-client`: borrar el espejo local al cerrar sesión o al perder permiso | Huéspedes en IndexedDB | La app llama a `indexedDB.deleteDatabase` |
| P5 | Lint: permitir `references core.files(id)`. Opcional: que `files/:id` pueda consultar un hook de visibilidad | Justificante SES; Invoices lo necesitará igual | Columna sin FK, validada en la Edge |
| P6 | `core.redact_row_history(app, table, id, columns[])` y una forma de eliminar un archivo de `core.files` y del bucket | Anonimizar huéspedes al vencer el plazo dejando rastro mínimo (C09 protocolo 9) y borrar la imagen de su firma. No hay ruta de borrado de archivos (Food lo plantea en su P6) | Solo borrado total con `purge_row_history`; las firmas quedarían en el bucket |
| P7 | Secretos de `booking-api` en el despliegue (`GOOGLE_SA_CLIENT_EMAIL`, `GOOGLE_SA_PRIVATE_KEY`, `BOOKING_CALENDAR_ID`), proyecto GCP y cuenta de servicio | Plan §7 | Calendar apagado («no configurado») |
| P8 | Rutas de sistema en `_kit` (secreto, sin usuario) y un planificador | Reintentos de Calendar cuando nadie tiene la app abierta | Reintento oportunista en `calendar/status` y `afterCommit` |
| P9 | `trash/purge` sin `tables`: ordenar por dependencias FK | El orden alfabético purga `events` antes que `guests` | Booking envía siempre la lista ordenada |
| P10 | Aprobar la semántica de `event_revision` y las cuatro columnas extra de la proyección (§7.1); cerrar con Food | Contrato §8 es normativo | Columnas exactas del contrato y filtro por estado |
| ~~P11~~ | Retirada: el usuario confirma que se empieza de cero, sin carga inicial desde C03/C04 | — | — |
| P12 | Confirmar que las tablas cerradas (`readable_roles '{}'`) son aceptables | Aparecen en `bootstrap` con `readable: false` | Marcador de tabla interna en el lint |
| P13 | `sync-client`: que un comando pueda referenciar un adjunto en cola y reciba su `file_id` al subirse (es la P3 de Food y la petición 2 de Invoices) | Firma en pantalla y justificante SES sin red | Firma y justificante solo con red: subir primero y escribir después |

---

## 14. Desviaciones y preguntas abiertas

**Desviaciones respecto al handoff V3** (todas justificadas arriba):

1. Membresía en `core.memberships` y no en `booking.members` (plan de Core).
2. Edición offline completa (plan de Core); el handoff la dejaba fuera.
3. Calendar por cuenta de servicio; el puente Apps Script queda como plan B.
4. `calendar_links` y `calendar_sync_jobs` cuelgan de la reserva, no del evento.
5. Sin `request_id` en los trabajos: la idempotencia la da el id determinista del evento de Google.
6. `event_revision` es un contador de cambios relevantes para Food, no `events.revision`.
7. Las rutas REST por recurso del handoff §25 se sustituyen por `snapshot`, `changes` y `commands`.
8. `setup_style` y `technical_needs` con los valores cerrados de C04 en vez de texto libre.
9. Se añaden `guests.ses_sent_by`, `ses_receipt_ref` y `ses_receipt_file_id` (C04 tenía `responsable_envio` y `justificante_envio_url`), `dietary_restrictions.servings` y `checklist_items`.
10. Importes y datos de pago en `reservation_finance`, fuera de `reservations`.
11. `guests` se amplía a la lista completa del anexo I del RD 933/2021; `events.rooms_count` y los datos de pago cubren los de la transacción.
12. El evento de día completo en Calendar incluye el día de salida.

**Decisiones del usuario (6 de octubre de 2026), ya incorporadas:**

| Tema | Decisión | Dónde |
|---|---|---|
| Día completo en Calendar | incluye el día de salida | §7.3 |
| Plazo de conservación de huéspedes | el del decreto: tres años desde el fin del servicio (art. 5.3, verificado en el BOE) | §5.3 |
| Importes | en tabla aparte que `reader` no recibe | §2.1.1 |
| Alta de huéspedes | la hace el equipo en V1; auto-registro, si acaso, en V2 | §1 |
| Apps Script legacy | no se usa; no hay corte que coordinar | §7.3 |
| Prueba real de Calendar | sobre «Agram Camp - Reservas», que está sin uso | §11.2 |
| Número de tarjeta o IBAN | no se guardan; solo se cobra a organizadores | §2.1.1 |
| Firmas del parte | se recogen: en pantalla o en papel | §2.3.2 |
| Carga inicial | se empieza de cero; P11 retirada | §13 |
| Campos obligatorios en SES | tomados de la especificación oficial del servicio web v3.1.2 | §2.3 |

**Lo único que queda sin verificar:**

1. **Quién debe firmar.** La app pide firma a partir de los 14 años por defecto. Es una regla, no una columna: se cambia sin migración si la revisión de C09 dice otra cosa.

---

## 15. Ampliación V2 · propuesta para revisión de Core

Fecha: 6 de octubre de 2026. Estado: **propuesta, sin código**. Aprobada por el usuario en alcance (ronda 14 de Core): habitaciones y camas, tarifas y propuestas, personal en eventos. Referencias funcionales: `C03` (`Doc_C03_Reservas_Condiciones_y_tarifas.md` §8–§10) y `C05` (`asignaciones`, `refuerzos`). Todo sigue el contrato: tablas tipadas con las seis columnas, escrituras por `core.commit`, offline con `sync-client`, pruebas en PGlite.

Principios comunes a los tres bloques:

- **Nada sustituye de golpe lo que ya funciona.** `events.room_distribution`, `reservation_finance` y el checklist siguen igual; lo nuevo convive y, cuando hay datos estructurados, la ficha los prefiere.
- **Lo calculado se calcula en el dominio** (`_domain/booking`), igual en la Edge y en el navegador; en la base solo se guardan los importes que un documento ya enviado no puede cambiar.
- **Proyecciones solo con lo necesario** para la app lectora, sin datos personales.
- **Todo lo que tiene orden lleva `position`** y se reordena a mano (decisión del usuario).

### 15.1 Habitaciones, camas y espacios

**Tablas** (migración `0410_booking_spaces`):

```text
booking.spaces                      inventario de espacios (cambia poco)
  code        text unique           ESP_NNN — trigger, no escribible
  name        text not null         «Habitación 4», «Sala grande», «Pinar»
  kind        text not null         habitacion | sala | zona_exterior | otro
  zone        text null             edificio o zona («Posada», «Casa principal»)
  capacity    integer null          personas (salas y zonas); en habitaciones se deriva de las camas
  accessible  boolean default false accesible para movilidad reducida
  active      boolean default true  un espacio fuera de uso no se ofrece al asignar
  position    numeric
  notes       text null
  lectura: todos · escritura: editor/owner

booking.beds
  space_id    uuid not null → booking.spaces   (solo kind = 'habitacion'; inmutable tras el alta)
  label       text not null          «Cama 1», «Litera A arriba»
  kind        text not null          individual | doble | litera | sofa_cama | supletoria
  capacity    integer not null       1 o 2
  active      boolean default true
  position    numeric

booking.room_assignments           quién duerme dónde en un evento
  event_id    uuid not null → booking.events     (inmutable)
  space_id    uuid not null → booking.spaces
  bed_id      uuid null     → booking.beds       (cama concreta, del mismo espacio)
  guest_id    uuid null     → booking.guests     (persona concreta) …
  group_label text null                          … o grupo sin identificar («Equipo de cocina»)
  persons     integer not null default 1         personas que ocupa (1 si guest_id)
  from_date   date null                          por defecto, las fechas de la reserva
  to_date     date null
  notes       text null
```

**Reglas** (`check`, `beforeCommit` e invariantes):

- `guest_id` o `group_label`, uno de los dos; con `guest_id`, `persons = 1`.
- **Nunca dos ocupaciones de la misma cama** en noches que se solapen entre eventos vivos de reservas no canceladas, perdidas ni archivadas (`BED_OVERBOOKED`). La salida de un grupo puede ser la entrada del siguiente.
- La suma de personas de una habitación frente a la capacidad de sus camas activas: **aviso en la interfaz, no bloqueo** (supletorias, niños con sus padres). El bloqueo es solo por cama.
- El huésped asignado es del mismo evento (`GUEST_MISMATCH`).
- Espacios o camas con asignaciones vivas no se borran (`ORPHAN_CHILD`).

**Visibilidad:** las asignaciones las ven todos los miembros (limpieza y acogida las necesitan). `guest_id` es opaco para quien no ve huéspedes: la interfaz le muestra «Huésped asignado» o el `group_label`.

**Interfaz:**

- **Ficha → «Alojamiento»** (dentro de Operación): habitaciones con sus camas, asignar huéspedes o grupos, ocupación «12 / 14 camas». Si hay asignaciones, el resumen sustituye a `room_distribution`; si no, se sigue viendo el texto libre (no se migra nada).
- **Inventario** (`#/espacios`, desde «Más» en Inicio): espacios por zona, reordenables, con sus camas.
- Vista de ocupación por espacio en el Calendario: más adelante, fuera de esta fase.

**Proyección para Tasks** (incidencias de mantenimiento ligadas a un espacio):

```text
booking.tasks_space_projection   (core.allow_read('tasks', …, 'view'))
  space_id, code, name, kind, zone, active, revision
```

Sin ocupación ni huéspedes. Tasks guardaría un enlace tipado `target_app='booking', target_kind='space', target_id`.

**«Espacio bloqueado»** (fuera de esta fase): cuando Tasks publique `tasks.booking_space_blocks_projection(space_id, from_date, to_date, reason, task_ref)`, Booking lo leerá para avisar al asignar y en el calendario. Queda definida la forma esperada; no crea dependencia ahora.

### 15.2 Tarifas y propuestas

**Tablas** (migración `0420_booking_rates`; todas con `readable_roles '{editor,owner}'`, como `reservation_finance`):

```text
booking.rates                       tarifario (C03 §8.5–§8.6)
  code         text unique          TAR_NNN — trigger
  name         text not null        «Grupo con pernocta», «Jornada sin pernocta»
  layer        text not null        recinto | por_persona | servicio | ajuste        (las cuatro capas de C03 §8.5)
  unit         text not null        persona_noche | persona_dia | dia | noche | estancia | unidad | porcentaje
  amount       numeric(12,2)        importe unitario, o porcentaje con signo (descuentos) si unit = porcentaje
  min_persons  integer null          tramo de personas (C03 §8.5 B)
  max_persons  integer null
  event_types  text[] null           tipos de reserva a los que aplica; null = todos
  valid_from   date null             temporada o vigencia
  valid_to     date null
  includes     text null             qué incluye (C03 §8.7: nunca un precio «pelado»)
  excludes     text null
  active       boolean
  position     numeric

booking.conditions                  condiciones comerciales (C03 §9–§10)
  name                 text           «Condiciones generales 2026»
  deposit_percent      numeric(5,2)   30
  deposit_minimum      numeric(12,2)  300
  deposit_days         integer        5   plazo de abono
  deposit_days_short   integer        2   plazo si la entrada está próxima
  short_notice_days    integer        15  desde cuándo es «entrada próxima»
  text                 text           texto legible que acompaña a la propuesta
  is_default           boolean        una sola por defecto (índice único parcial)
  active               boolean

booking.cancellation_tiers          tramos de cancelación (C03 §10.3)
  conditions_id        uuid → booking.conditions
  min_days_before      integer        60, 30, 15, 3, 0
  deposit_refund_pct   numeric(5,2)   100, 50, 0…
  extra_costs          boolean        «podrán repercutirse costes directos»
  position             numeric

booking.proposals                   propuestas por reserva, versionadas
  reservation_id   uuid → booking.reservations         (inmutable)
  version          integer                              1, 2, 3… (único por reserva; trigger)
  status           text   borrador | enviada | aceptada | rechazada | caducada | sustituida
  nature           text   orientativa | cerrada         (C03 §8.2)
  conditions_id    uuid → booking.conditions
  start_date, end_date, persons      copia de lo presupuestado (la reserva puede cambiar después)
  subtotal, adjustments, total       numeric(12,2): calculados por el dominio, verificados en beforeCommit
  deposit_amount   numeric(12,2)     calculado con las condiciones
  valid_until      date null
  includes, excludes, notes   text
  sent_at, decided_at         timestamptz null

booking.proposal_lines
  proposal_id   uuid → booking.proposals   (inmutable)
  rate_id       uuid null → booking.rates  (origen; la línea guarda su propio importe)
  description   text
  unit          text
  quantity      numeric
  unit_amount   numeric(12,2)
  amount        numeric(12,2)   = quantity × unit_amount, redondeado a céntimos; verificado
  position      numeric
```

**Cálculo** (dominio, puro):

- `suggestLines(reservation, rates)` propone líneas desde el tarifario según tipo de reserva, personas, noches, temporada y servicios marcados (alojamiento, comidas, salas…). La persona las acepta o corrige.
- `proposalTotals(lines, conditions)`: subtotal, ajustes, total y señal (`max(total × porcentaje, mínimo)`; el 50 % de jornadas pequeñas como opción manual).
- `refundFor(proposal, cancelledOn, tiers)`: cuánto de la señal se devuelve. Se mostrará al cancelar una reserva con propuesta aceptada.

**Ciclo:**

- `borrador` se edita libremente.
- **`enviada` es inmutable** (trigger `PROPOSAL_LOCKED`): solo cambian `status`, `decided_at` y `notes`. Para cambiar algo, `booking.new_proposal_version(reservation_id, from_proposal_id, proposal_id)` copia cabecera y líneas en un `borrador` nuevo.
- `booking.send_proposal(proposal_id, expectedRevision)`: `borrador → enviada`, fija `sent_at` y pasa a `sustituida` la enviada anterior.
- `booking.accept_proposal(proposal_id, expectedRevision)`: `enviada → aceptada`, el resto de versiones vivas a `sustituida`, y **escribe en `reservation_finance`** `final_amount = total` y `deposit_required = deposit_amount` (y `budget_amount` si estaba vacío). Es el único punto en que la propuesta toca los importes de la reserva, y queda en `core.changes`.
- `rechazada` y `caducada` se marcan a mano (la caducidad por `valid_until` solo se avisa en la interfaz).
- Los tres procedimientos **exigen aprobación si los lanza un agente** y `agentRisk` añade `booking:proposal` a cualquier escritura en propuestas.

**Interfaz:**

- **Ficha → «Propuesta»** (encima de Cobro, solo editor/owner): versión vigente, estado, total y señal; «Nueva versión», «Marcar enviada», «Aceptada», «Rechazada»; historial plegado.
- **Editor de propuesta**: líneas sugeridas, editables y reordenables; total y señal en vivo; condiciones elegidas.
- **Documento para el organizador**: vista A4 con «Imprimir / Guardar PDF» (como el menú de Food): qué incluye, qué no, orientativa o cerrada, señal, plazos y tramos de cancelación. Sin envío de correo en esta fase.
- **Tarifario y condiciones** (`#/tarifas`, desde «Más»; solo owner escribe).

**Invoices:** el importe acordado vive en Booking (`reservation_finance`) y los cobros reales en Invoices. Si Invoices quiere comparar acordado frente a cobrado, Booking publicará `booking.invoices_agreed_projection(reservation_id, code, final_amount, deposit_required, accepted_proposal_version)` cuando lo pida.

### 15.3 Personal en eventos

**Tablas** (migración `0430_booking_staff`; lectura todos los miembros, escritura editor/owner):

```text
booking.staff_assignments           C05 «asignaciones»
  event_id        uuid → booking.events        (inmutable)
  person_name     text not null                «Marga»: solo el nombre, sin teléfono ni documento
  member_user_id  uuid null → auth.users       si la persona es miembro de Booking
  person_ref_app  text null                    enlace tipado futuro a la ficha de personal (Central; `encarna` es solo su alias de dominio):
  person_ref_id   text null                    target_app = 'central', target_kind = 'person'
  function        text not null    coordinacion_general | acogida_grupo | cocina | apoyo_cocina | limpieza_previa |
                                   limpieza_rotacion | mantenimiento_guardia | soporte_tecnico | apoyo_logistico |
                                   cierre_evento | otra                                           (C05 §5)
  work_date       date null        día del turno (null = todo el evento)
  planned_hours   numeric(5,2) null
  actual_hours    numeric(5,2) null
  status          text   prevista | confirmada | realizada | cancelada
  notes           text null
  position        numeric

booking.staff_needs                 C05 «refuerzos»
  event_id      uuid → booking.events
  need_type     text   cocina | limpieza | mantenimiento | tecnico | acogida | mixto
  persons       integer   ≥ 1
  priority      text   baja | media | alta | urgente
  status        text   detectado | buscando | cubierto
  notes         text null
```

**Reglas:** horas no negativas; al anotar el cierre operativo la ficha avisa de turnos sin horas reales. Una necesidad pasa a `cubierto` a mano (en C05 son cosas distintas y no se cruzan solas).

**Proyección para Invoices** (coste de personal por evento):

```text
booking.invoices_staff_hours_projection   (core.allow_read('invoices', …, 'view'))
  assignment_id, event_id, event_code, reservation_id, reservation_code,
  function, staff_ref, work_date, planned_hours, actual_hours, status, revision
```

`staff_ref` es un identificador estable sin nombre (`member_user_id`, `person_ref_id` o el id de la asignación). **El nombre no sale de Booking**; Invoices calcula el coste con tarifas por función que serán suyas.

**Interfaz:** **Ficha → «Personal»** (dentro de Operación): turnos por día y función con horas previstas y reales, reordenables; necesidades de refuerzo con su prioridad. **Inicio:** aviso «N refuerzos sin cubrir en los próximos 7 días».

### 15.4 Lo transversal

- **Migraciones:** `0410_booking_spaces`, `0420_booking_rates`, `0430_booking_staff`, cada una con sus tablas registradas, invariantes añadidas a `booking.check_invariants`, procedimientos y `allow_read`.
- **Offline:** todo va al espejo local; las tablas de importes se borran al cerrar sesión, como `reservation_finance`. Asignar camas y apuntar turnos funciona sin red; enviar o aceptar una propuesta es un `call` y queda «pendiente de enviar» como la confirmación.
- **Papelera:** las tablas nuevas entran en el orden de hijos a padres de «Vaciar papelera»; espacios y tarifas en uso no se purgan (FK).
- **Agentes:** aprobación para cualquier escritura en propuestas y para borrar espacios o camas; asignar camas y apuntar horas, no.
- **Pruebas:** dominio (sugerencia de líneas, totales, señal, devolución por tramos, solape de camas), SQL en PGlite (invariantes, propuesta enviada inmutable, procedimientos), proyecciones sin datos personales, humo y un escenario sin red por bloque.

### 15.5 Orden propuesto

1. **Espacios y camas**: lo más operativo; desbloquea el enlace con Tasks.
2. **Personal en eventos**: pequeño; desbloquea el coste de personal en Invoices.
3. **Tarifas y propuestas**: el mayor (tarifario, editor y documento imprimible).

Una PR por bloque.

### 15.6 Decisiones del usuario (rondas 16–18)

1. **Alojamiento por habitación** con número de personas y cama opcional (cubre también el «por cama»).
2. **Habitaciones reales** (las mete el usuario en la app, no van en Git): una doble de 2 plazas reservada de antemano y **no reservable**; tres de 12 plazas con 4 supletorias; dos de 2 plazas con 2 supletorias; una séptima que no se ofrece nunca. De ahí:
   - `booking.spaces.bookable`: un espacio activo pero no reservable existe, pero no se ofrece para asignar ni cuenta en la disponibilidad.
   - Camas `kind = 'supletoria'`: no cuentan en la capacidad base; se activan al asignarlas en una reserva y la propuesta las cobra como extra (`extraBedsInUse`).
   - Alta fácil en «Espacios y camas»: habitación con N camas y M supletorias de una vez, duplicar una habitación y «Crear distribución inicial» (con confirmación) cuando no hay ninguna.
3. **Precios con IVA incluido** (10 % en alojamiento; `prices_include_vat` y `vat_rate` en las condiciones, cambiables sin migración). El IVA por categoría en facturas es de Invoices.
4. **La app sugiere la tarifa** y el equipo aplica un **descuento en %** por línea (`proposal_lines.discount_pct`) o cambia el importe a mano.
5. **Extras** con precio (equipo de sonido, camas supletorias, cambios de camas, movimientos de mobiliario…): capa `extra` del tarifario, por evento (`estancia`), por noche, por persona o por unidad. Se añaden a mano a la propuesta; solo el de servicio `cama_supletoria` se sugiere, por cama activada.
6. **Horas reales del personal:** las apunta el responsable al cerrar el evento.

## 16. Portales Organizers y Guests · datos de huéspedes

Diseño de producto en `coordinacion/ampliacion/PORTALES.md`; núcleo en el contrato §3.6. **Booking es la dueña de los datos**: Organizers y Guests no tocan `booking.*` directamente; leen funciones de Booking filtradas por el ámbito del enlace y escriben con acciones estrechas (`invoke`) que fijan la procedencia. Aprobado por Core (ronda §16) con las respuestas de §16.7; construido en la migración `20261007_0433_booking_portal_guests.sql`.

### 16.1 Enlaces (hecho)

- `booking.portal_link_valid_until(p_scope)` registrada con `core.allow_portal_resolver` para `organizers` y `guests`: **fin de la reserva + 3 días** (hasta el final de ese día, hora de Madrid), recalculado en cada canje; sin fecha de salida, 90 días desde el alta de la reserva; `null` (caducado) si la reserva no existe, está borrada, cancelada o perdida. Migración `20261007_0432_booking_portal_links.sql`.
- `booking-api` con `portalIssuer: true`: editor y owner emiten, listan, amplían y revocan.
- Ficha → **«Portal del organizador»**: generar el enlace con el contacto de la reserva (editable), URL mostrada una sola vez con «Copiar» y «Compartir», lista con «Revocar» y «Ampliar hasta…».

### 16.2 Procedencia por campo

En `booking.guests` (y en `booking.dietary_restrictions`) una columna nueva, no escribible por clientes:

```text
field_sources  jsonb not null default '{}'   {"<campo>": {"by": "guest"|"organizer"|"staff", "at": "<timestamptz>"}, …}
```

- La rellena el **trigger** `booking.guest_track_sources` (`before insert or update`): para cada campo de datos (identidad, documento, residencia, contacto, tutor) cuyo valor cambia, anota quién lo escribió. Quién es lo marca la transacción: las acciones de portal fijan `set_config('booking.writer', 'organizer'|'guest', true)` antes de escribir con `core.apply_row_op` y lo restauran; sin marca, `staff` (Booking y agentes).
- **«Si el huésped cambia un valor, pasa a ser suyo»** sale solo: su escritura deja `by: guest` en ese campo.
- **El organizador no sobrescribe lo que escribió el huésped**: la acción de organizador rechaza con `422 FIELD_OWNED_BY_GUEST` un campo cuyo origen es `guest` (no ve el valor; pisarlo a ciegas sería peor). El personal sí puede (corrige con el documento delante).
- `core.changes` sigue guardando quién y cuándo; `field_sources` es la vista rápida por campo que necesitan los portales y la ficha.

### 16.3 Lo que ve cada uno

| Dato | Organizador (Organizers) | Huésped (Guests) | Personal (Booking) |
|---|---|---|---|
| Nombre e inicial del primer apellido | sí | sí | todo |
| Campo escrito por el organizador | el valor | el valor (puede corregirlo) | el valor y su origen |
| Campo escrito por el huésped o el personal | «rellenado ✓» (nunca el valor) | el valor | el valor y su origen |
| Estado del huésped (completo / falta X) | sí | sí (lo suyo) | sí, con «Copiar recordatorio» |
| Alergias e intolerancias del huésped | solo con su consentimiento; si no, agregadas sin nombres | las suyas | todas |
| Firma del parte | «firmado ✓ / pendiente» | firma él | ve la firma |
| Estado SES, notas internas, recibos | no | no | sí |

### 16.4 Consentimiento, aviso legal y firma

Columnas nuevas en `booking.guests`, escribibles solo por la acción del huésped:

```text
allergies_visible_to_organizer  boolean not null default false   interruptor «¿Quieres que el organizador sepa tus alergias o intolerancias?», revocable
privacy_ack_at                   timestamptz null                  el huésped vio la información legal al abrir su enlace (versión en privacy_ack_version)
privacy_ack_version              text null
```

- **Firma:** solo el huésped, en Guests (acción `booking.portal_guest_sign`, que escribe `signature_file_id`, `signed_at`, `signed_by_name`) o en la llegada en el dispositivo del personal (como hoy). El organizador **nunca** firma: ninguna acción de organizador toca esos campos.
- **Declaración del organizador:** la primera vez que rellena datos de otros confirma «Facilito estos datos con conocimiento de mis huéspedes» (casilla y texto informativo en Organizers). La acción exige `declaration: true` y deja constancia en `core.access_log` (o en una tabla `booking.portal_declarations(reservation_id, user_id, text_version, at)` si Core prefiere tenerlo en Booking).
- **Plazo:** el de hoy para el registro de viajeros (3 años, RD 933/2021 art. 5.3), pendiente de confirmar con la gestoría como dice el diseño.

### 16.5 Completitud y recordatorio (personal)

- Dominio: `guestCompleteness(guest)` → `{ complete, missing: [campo…], signed }` sobre la lista de campos de SES que ya usa `missingForSes`, y `reservationCompleteness(guests)` → totales.
- Ficha → Huéspedes: por huésped, «completo» o «falta: documento, fecha de nacimiento…», el origen de cada campo (icono de huésped, organizador o personal), y **«Copiar recordatorio»** con un texto listo para pegar (al huésped: lo que le falta y su enlace si se acaba de generar; al organizador: cuántos huéspedes tienen datos incompletos). Sin envío de correo desde la app en esta fase.

### 16.6 Lo que publica Booking para los portales

Todas las funciones reciben `{app, actor, role, args}` y sacan el ámbito de `core.memberships.scopes.grants` del actor en ese portal; un `reservation_id` o `guest_id` fuera del ámbito → `403 OUT_OF_SCOPE` (también si no existe: un portal no averigua qué huéspedes hay). Lo que se pide y la completitud salen de `guestMissing(guest, mode)` del dominio (`_domain/booking/portal.ts`), replicada en `booking.guest_missing(g, mode)` y comprobada por prueba; el modo de la reserva lo da `booking.guest_mode(reservation_id)` (hoy siempre `ses`; `operativo` llegará con la propuesta de SES.HOSPEDAJES).

Lecturas (`core.allow_read('<portal>', 'booking.fn', 'function')`):

| Función | Portal | Devuelve |
|---|---|---|
| `booking.portal_reservations` | organizers | sus reservas: código, título, fechas, personas previstas, estado, si tiene evento, completitud agregada |
| `booking.portal_guests` | organizers | huéspedes de una reserva con la regla de §16.3 (valor si `by = organizer`, `true` si rellenado por otro, `null` si vacío), estado y lo que falta; `declared` dice si el organizador ya hizo la declaración en esa reserva (B2) |
| `booking.portal_reservation_detail` | organizers | detalle de una reserva para su ficha (B1): horas de llegada y salida, plazas previstas y finales, menores, régimen y estilo de menú (confirmados o, si no, pedidos, con la marca), servicios, modo de datos y alojamiento por espacio (nombre, tipo, zona y personas); sin huéspedes, importes ni notas internas |
| `booking.portal_kitchen_summary` | organizers | requisitos de cocina agregados sin nombres + los de huéspedes que consintieron |
| `booking.portal_my_guest` | guests | su ficha completa, su consentimiento, su aviso legal y su firma |

Acciones (`core.allow_read('<portal>', 'booking.fn', 'action', '{editor}')`), cada una con `expectedRevision` cuando modifica una fila:

| Acción | Portal | Hace |
|---|---|---|
| `booking.portal_add_guest` | organizers | alta de un huésped de su reserva (`by: organizer`); exige `declaration`; idempotente ante un reintento del mismo actor con el mismo `guest_id` (`existing: true`), `409 ROW_EXISTS` si el id es de otro (B3) |
| `booking.portal_update_guest` | organizers | rellena campos de datos (`by: organizer`); `FIELD_OWNED_BY_GUEST` si el campo es del huésped |
| `booking.portal_remove_guest` | organizers | baja en cualquier momento (decisión del usuario): a la papelera con sus restricciones y asignaciones, con quién y cuándo, y revoca su enlace de Guests; `422 GUEST_CHECKED_IN` si ya firmó con el retiro empezado o su parte se comunicó a SES (lo corrige el personal). Al vaciar la papelera se borra de verdad |
| `booking.portal_set_restrictions` | organizers, guests | restricciones de un huésped (`by` según portal); el organizador no ve ni pisa las del huésped sin consentimiento |
| `booking.portal_guest_update` | guests | completa o corrige sus datos (`by: guest`) |
| `booking.portal_guest_consent` | guests | interruptor de alergias y acuse del aviso legal |
| `booking.portal_guest_sign` | guests | firma (archivo subido por el portal; ver pregunta 3) |

Ninguna toca `data_status`, `ses_*`, `notes` ni la papelera del personal. Las escrituras pasan por `core.apply_row_op` con app `booking`, así siguen llegando a Booking por la sincronización normal y quedan en `core.changes`.

### 16.7 Respuestas de Core y del usuario

1. Huéspedes **solo con la reserva confirmada** (`422 RESERVATION_NOT_CONFIRMED`); antes, el portal muestra «podrás añadir a tus huéspedes cuando la reserva esté confirmada».
2. Las acciones escriben con el usuario del portal como actor y rol `editor` explícito (`updated_by` = el usuario del portal) y llegan al personal por `changes`. Cada acción escribe en un lote propio de Booking con `core.apply_portal_operations` (P20), que toma actor y rol del contexto de `invoke`.
3. **Firma desde Guests:** subida con `uploads` en `guests-api` al bucket privado `guests-documents`; `portal_guest_sign` comprueba que el archivo está verificado y es del mismo usuario. El personal la ve con `GET /api/v1/guest-signature/:guestId` (URL firmada 5 min, solo quien puede ver huéspedes).
4. **Declaración del organizador** en `booking.portal_declarations` (sincronizada para editor y owner; solo la escribe la acción, en el mismo lote que el dato; `422 DECLARATION_REQUIRED` la primera vez si no viene).
5. **Baja por el organizador:** en cualquier momento (ver §16.6). La revocación usa `core.portal_revoke_scope('guests', 'guest_id', id)` (P21), que además quita el permiso a la sesión abierta del huésped.

### 16.8 Peticiones de fase 1 de los portales (migración 0451)

- **BG1** `portal_my_guest.sources` (`{campo: 'guest'|'organizer'|'staff'}`, solo el `by`) y `source` en cada restricción.
- **BG2** `portal_guest_update`, `portal_guest_consent`, `portal_guest_sign` y `portal_set_restrictions` responden `{guest_id, revision, cursor}`.
- **BG3** `guests.diet_reviewed_at`: la marca `portal_set_restrictions` siempre, también con la lista vacía («No tengo alergias ni dieta especial»); está en `portal_my_guest` y como `diet_reviewed` en `portal_guests`. Los clientes de Booking no la escriben.
- **BG4** `portal_my_guest.reservation` con `status`, `arrival_time` y `departure_time`.
- **BG5** si cambia un dato del registro (cualquier campo de `portal_guest_fields`) después de firmar, la firma deja de valer: `signed_at`, `signature_file_id`, `signed_by_name` y `signature_text_version` a `null` (lo cambie el huésped, el organizador o el personal; no al firmar en el mismo cambio ni al anonimizar). `portal_guest_update` responde `signature_reset`. `portal_guest_sign` acepta `text_version` (de Central `guests.signature_statement`) y lo guarda en `guests.signature_text_version`.
- **BG6** parentesco con los **códigos del catálogo de SES** (`KINSHIP_CODES` y `kinshipLabel` en el dominio): Guests guarda el código; el texto libre antiguo se sigue convirtiendo al enviar a SES.
- **B11** `booking.portal_organizers({reservation_id})` para `organizers`: `items: [{display_name, me}]` de quienes tienen acceso a esa reserva.
- **C6** la conservación revoca el enlace y el permiso del huésped en Guests (`core.portal_revoke_scope`) al anonimizarlo.

## 17. SES.HOSPEDAJES · propuesta para revisión de Core

Diseño de producto aprobado por el usuario en `coordinacion/ampliacion/SES.md` (su §0 manda). Referencia técnica: especificación v3.1.3 y XSD oficiales (copiados a `integrations/ses/`, documentación pública sin datos personales). Orden: §17.1 interruptores → §17.3 cliente (SES-1) → reserva con botón (SES-2) → llegada (SES-3) → conservación (SES-4).

### 17.1 Interruptores por reserva y ajuste global

Columnas nuevas en `booking.reservations` (migración `0440_booking_ses`):

```text
ses_enabled          boolean not null default true    «Comunicar a SES.HOSPEDAJES»
ses_disabled_reason  text null    uso_privado | prueba | otro          obligatorio si ses_enabled = false
ses_disabled_note    text null    texto libre con «otro»
collect_guest_data   boolean not null default true    «Pedir datos a los huéspedes»; solo cuenta con SES desactivado
```

- `booking.guest_mode(reservation_id)` pasa a leerlas: `ses` si SES está activo; `operativo` si está desactivado y se piden datos; `ninguno` si no. En `ninguno`, `portal_add_guest` responde `422 GUEST_DATA_OFF` y las lecturas del organizador devuelven la reserva sin apartado de huéspedes. El dominio (`guestMissing`, `GuestMode`) gana el modo `ninguno`.
- Reglas en el hook SQL: con SES desactivado hace falta motivo (`SES_REASON_REQUIRED`); no se puede desactivar si ya hay un parte de viajeros aceptado de alguien alojado (`SES_ALREADY_REGISTERED`, cuando exista SES-3). En modo `operativo` el portal no pide ni guarda documento, dirección, fecha de nacimiento ni firma: las acciones de portal filtran esos campos (`portal_clean_fields` según el modo).
- Desactivar con la reserva ya comunicada: la ficha ofrece «Anular la comunicación en SES» (SES-2). Reactivar: pide los datos que falten y avisa del plazo.
- Aviso de coherencia en la interfaz (no bloquea): «Esta reserva tiene importe. ¿Seguro que es sin contraprestación?».
- El historial (`core.changes`) ya guarda quién, cuándo y el motivo.

Ajuste global, `booking.ses_settings` (una fila; lee editor/owner, escribe owner):

```text
environment   pre | prod          por defecto pre; prod solo con credenciales reales cargadas
paused        boolean             «Pausar envíos»: los botones preparan pero no envían
```

Los códigos de arrendador y de establecimiento y el usuario y contraseña del servicio web son **secretos de la Edge** (`SES_LANDLORD_CODE`, `SES_ESTABLISHMENT_CODE`, `SES_USER`, `SES_PASSWORD`, uno por entorno), nunca columnas.

### 17.2 Comunicaciones y estados

```text
booking.ses_communications          una por alta (RH o PV) o anulación; lee editor/owner; solo la escriben los procedimientos
  reservation_id   uuid → booking.reservations
  kind             RH | PV | anulacion
  guest_ids        uuid[] null        PV: huéspedes incluidos
  cancels_id       uuid null          anulacion: la comunicación que anula
  environment      pre | prod
  status           preparada | enviando | en_proceso | aceptada | rechazada | anulada | error
  content_sha256   text               huella del contenido enviado (nunca el XML ni el SOAP)
  lot_id           text null          número de lote devuelto por SES
  ses_code         text null          código de comunicación asignado por SES
  error_code       text null          código de error de SES (tabla del §5 de la spec)
  error_text       text null          descripción en claro
  legal_start_at   timestamptz        momento legal del plazo de 24 h (pago para RH; primer día para PV)
  sent_at, accepted_at, cancelled_at   timestamptz null

booking.ses_attempts                tabla cerrada (readable_roles '{}'): una fila por llamada al servicio
  communication_id, at, operation (comunicacion | consultaLote | anulacion), http_status, outcome, lot_id, error_code
```

Estados visibles: Preparada → Enviando → En proceso en SES → **Aceptada** (solo entonces «enviada») / Rechazada (con el error en claro y qué corregir) / Anulada / Error (de red o de servicio; se reintenta).

### 17.3 Dónde vive el cliente (SES-1)

- **Dominio puro**, `supabase/functions/_domain/booking/ses/`: construcción de la solicitud RH, PV y anulación siguiendo los XSD, catálogos oficiales (documento, sexo, pago, parentesco), ZIP (sin compresión adicional: la spec solo exige ZIP) y Base64, sobre SOAP de las operaciones `comunicacion`, `consultaLote` y `anulacionLote`, y lectura de las respuestas (lote, resultado por comunicación, códigos de error). Sin red ni secretos: se prueba entero en Node.
- **Validación contra los XSD oficiales en las pruebas** con `xmllint` (o una biblioteca de validación en Node como dependencia de desarrollo), sobre los XSD copiados a `integrations/ses/`.
- **Transporte**, `supabase/functions/booking-api/ses/transport.ts`: `POST` al endpoint de PRE o PROD con `Authorization: Basic` y `SOAPAction` vacío.
- **Certificado (comprobado el 7-10-2026):** los dos servidores (`hospedajes.pre-ses.mir.es` y `hospedajes.ses.mir.es`) presentan un certificado emitido por **«AC Componentes Informáticos»** de la FNMT **sin enviar ese intermedio**; la raíz «AC RAIZ FNMT-RCM» sí está en los almacenes habituales. Un cliente estándar falla (`UNABLE_TO_VERIFY_LEAF_SIGNATURE`); con el intermedio público (`http://www.cert.fnmt.es/certs/ACCOMP.crt`, válido hasta 2028) añadido a la confianza, PRE responde `401` sin credenciales, que es lo esperado. El intermedio va en el repo (`integrations/ses/fnmt-ac-componentes.pem`, es público). En la Edge: `Deno.createHttpClient({ caCerts })` y, si el runtime de Supabase no lo ofrece, `Deno.connectTls({ caCerts })` con una petición HTTP/1.1 mínima. **Para despejarlo en la Edge real:** ruta `POST /api/v1/worker/ses/ping` (clave de worker) que solo hace el saludo TLS contra PRE y devuelve el estado HTTP; Core la llama una vez desplegada. Si ninguna de las dos vías funciona en Supabase, el transporte pasa a un Worker de Cloudflare con el mismo contrato.
- **SES simulado en las pruebas:** un servidor SOAP falso que valida la cabecera, descomprime y comprueba la solicitud, y responde lotes aceptados, rechazados (con códigos reales) y en proceso.

### 17.4 Rutas

| Ruta | Quién | Hace |
|---|---|---|
| `POST /api/v1/ses/:reservationId/rh` | editor/owner | prepara y envía la reserva (solo con pago registrado y SES activo; no envía si `paused`) |
| `POST /api/v1/ses/:communicationId/cancel` | editor/owner | anula una comunicación aceptada |
| `POST /api/v1/ses/:reservationId/pv` | editor/owner | «Cerrar la entrada y comunicar» (SES-3) |
| `GET /api/v1/ses/:reservationId` | editor/owner | estado de sus comunicaciones |
| `POST /api/v1/worker/ses/tick` | planificador | consulta lotes en proceso y reintenta errores; solo trabaja si hay pendientes |
| `POST /api/v1/worker/ses/ping` | Core | prueba de TLS contra PRE (§17.3) |

Los avisos de plazo (12 h y 18 h desde el pago o el primer día) salen de `legal_start_at` en Inicio y en la ficha, y como petición a Tasks (`booking.ses_deadline`, §20 de Tasks) cuando Core lo confirme.

### 17.5 Preguntas para Core

1. ¿Ofrece el runtime de Supabase `Deno.createHttpClient` con `caCerts`, o `Deno.connectTls`? Si lo sabes, me ahorro la ruta de prueba; si no, la llamas tú tras desplegar.
2. ¿Valido los XSD en las pruebas con `xmllint` (no está en la CI de Windows/Ubuntu por defecto) o con una dependencia de desarrollo en Node? Propuesta: dependencia de desarrollo (`xmllint-wasm`), sin tocar la CI.
3. Secretos `SES_*` por entorno: ¿los nombras tú o uso los de §17.1?

## 18. Indicadores para Central

Vista `booking.central_kpi_projection` (migración `20261007_0450_booking_kpis.sql`), contrato en `docs/central/API.md` §7.2. Solo agregados; «hoy» en hora de Madrid. «Reservas vivas» = no borradas, no archivadas, ni canceladas ni perdidas.

| Clave | Unidad | Periodo | Sentido | Fórmula |
|---|---|---|---|---|
| `booking.reservations_confirmed_90d` | count | actual (hoy → +90) | up | reservas vivas confirmadas o en ejecución con entrada entre hoy y dentro de 90 días |
| `booking.guests_expected_90d` | persons | actual (hoy → +90) | up | suma de personas finales del evento o, si no hay, previstas de esas mismas reservas |
| `booking.events_next_30d` | count | actual (hoy → +30) | up | eventos vivos de reservas vivas con entrada entre hoy y dentro de 30 días |
| `booking.deposits_pending` | count | actual | down | reservas vivas pre-reservadas o confirmadas con señal pedida mayor que la cobrada |
| `booking.staff_needs_open` | count | actual | down | refuerzos sin cubrir de eventos que no han terminado |
| `booking.occupancy_rate` | pct | mensual (12 meses anteriores, el actual y 3 siguientes) | up | personas-noche asignadas en el mes (asignaciones de alojamiento de reservas vivas, noches [entrada, salida)) / (plazas base × días del mes) × 100; plazas base = camas activas no supletorias de habitaciones activas y reservables; `null` si no hay plazas |

`booking.leads_new` y `booking.leads_converted` llegarán con el CRM.

## 19. Lectura para facturar desde una reserva (Finance)

`booking.reservation_invoice_source({reservation_id})`, registrada para `invoices` (migración `20261007_0444_booking_invoice_source.sql`; contrato en `docs/invoices/API.md` §14.8, con estos ajustes de Booking):

- `reservation`: `id, code, label` (título), `revision, check_in, check_out`.
- `customer`: `name` (contacto de la reserva) y `kind` (`customer_type`); **`tax_id`, `id_type`, `country` y `address` en `null`**: Booking no guarda hoy los datos fiscales del organizador y Finance los completa en el borrador (pendiente de decisión del usuario si deben guardarse en Booking).
- `prices_include_vat` y, en cada línea, `vat_rate` de las condiciones de la propuesta (si no, las condiciones por defecto): sugerencia; el tipo por categoría es de Finance.
- `lines` de la **propuesta aceptada** en su orden: `kind` `tarifa` o `extra` (capa de la tarifa), `quantity`, `unit`, `unit_price` (unitario de la línea), `discount_amount` (su descuento en % convertido a importe) e `income_category` (`alojamiento` para recinto y por persona, `restauracion` para el servicio de comidas, `extras`, y `servicios` para el resto o las líneas sin tarifa). Los **ajustes en porcentaje** van como línea propia `kind: 'ajuste'` con `unit_price` negativo. La suma de las líneas cuadra con el total de la propuesta. Sin propuesta aceptada, una línea «Estancia · <título>» por `final_amount`.
- `proposal` (`id, version, total`) y `final_amount`, para comprobar.
- **`invoiced: null`**: Booking no sabe qué se ha facturado; lo une Finance con sus facturas.

## 20. SES-4 · conservación del registro de viajeros

Base: RD 933/2021 art. 5.3 y `coordinacion/ampliacion/SES.md` §3.

**Ventanas** (desde el **fin de la estancia**, `reservations.end_date`, hora de Madrid; nunca una estancia en curso ni futura):
- Reserva en modo `ses`: **3 años**.
- Modo `operativo` o `ninguno` (sin obligación legal): **6 meses**.
- El modo es el de la reserva en el momento de la tarea. Si una reserva tuvo partes aceptados, cuenta como `ses` aunque después cambie (ya no se puede desactivar: `SES_ALREADY_REGISTERED`).

**Qué se hace con cada huésped vencido** (una vez; `guests.anonymized_at` lo marca):
- Datos personales a `null`: apellidos, documento y soporte, nacimiento, nacionalidad, sexo, dirección, teléfono, correo, tutor, parentesco, notas, `signed_by_name`, `field_sources`. Nombre a «Huésped anonimizado».
- Archivos: firma y justificante de SES se marcan `retention_class = 'temporary'` en `core.files` y se quitan las referencias (`signature_file_id`, `ses_receipt_file_id` a `null`); la recogida de huérfanos los borra sin esperar.
- Restricciones del huésped (datos de salud): a la papelera.
- Se conservan: la fila del huésped (para los recuentos de la reserva), `arrived_at`, estados (`data_status`, `ses_status`, `ses_sent_at`) y las comunicaciones a SES (`booking.ses_communications`, que no llevan datos personales).
- Declaraciones del organizador de esa reserva (`portal_declarations`): a la papelera con la misma ventana.

**Cómo:** acción del sistema `booking.retention_run({limit})` llamada por `POST /api/v1/worker/retention/tick`, diaria con `core.schedule_tick('booking', 'retention/tick', '30 3 * * *', 'booking.retention_has_work')`. Lotes de como mucho 200 huéspedes por vuelta. Las escrituras deben llegar a los dispositivos por `core.changes` (para que borren su copia local), así que van en un lote propio del sistema con `core.apply_system_operations('booking', ops)` (P22), firmado por «Booking (sistema)». Migración `20261007_0448_booking_retention.sql`.

**Pruebas:** las dos ventanas (justo antes y justo después), que nunca toca una estancia en curso, que los archivos quedan `temporary` y sin referencia, que el cambio llega por `changes`, y que repetir la tarea no hace nada.

## 21. Fase 2 de los portales · el organizador diseña y propone

Regla del usuario: **Ikisai fija y el organizador propone**. Migraciones `20261008_0452_booking_portal_dates.sql` y `20261008_0453_booking_portal_design.sql`.

**Fechas (B6–B8):**
- `reservations.dates_definitive` (solo el personal): con ella, `start_date`/`end_date` son la fecha fija.
- `booking.reservation_date_options`: propuestas de Ikisai (personal) o del organizador (solo desde su portal), con `organizer_ok`. Nunca bloquean.
- `booking.date_blocks`: bloqueos manuales con motivo interno.
- Disponibilidad (`booking.range_availability`, noches [entrada, salida)): `ocupado` = bloqueo, o reserva viva confirmada, en ejecución, cerrada o pre-reservada con fecha definitiva; `en_opcion` = estudio, negociación o pre-reserva con fecha definitiva o con opciones de Ikisai; `libre` el resto. La propia reserva no cuenta.
- `portal_availability({reservation_id, from, to})`: fines de semana (viernes a domingo), como mucho 18 meses, sin decir quién.
- `portal_dates({reservation_id})`: `mode` `fixed` | `ikisai_options` | `calendar`, la fecha definitiva y las opciones con su disponibilidad.
- `portal_set_date_preferences({reservation_id, options})`: con opciones de Ikisai, `[{option_id, ok}]`; sin ellas, `[{start, end}]` sustituye las del organizador. Errores `DATES_FIXED`, `DATE_UNAVAILABLE`, `DATE_NOT_OFFERED`. Nunca fija la fecha.

**Diseño, extras, tarifas y propuesta (B7d, B9, B10, B12):**
- `portal_update_draft({reservation_id, expectedRevision?, fields, extras?})`: solo en `en_estudio` o `negociacion` (si no, `DRAFT_LOCKED`) y solo campos de diseño (personas, menores, régimen y menú pedidos, servicios y `organizer_notes`); `extras` sustituye los extras pedidos (`booking.reservation_extra_requests`), solo de tarifas `portal_visible` (si no, `EXTRA_NOT_OFFERED`).
- `portal_rates({reservation_id})`: tarifas activas visibles en el portal (con `public_name` y `public_description`) y las condiciones por defecto con `minimum_total`; `available: false` sin tarifas. **La calculadora la hace Organizers** con `suggestLines`, `proposalTotals` y `applyMinimum` de `@ikisai/domain-booking`.
- **Mínimo al enviar:** si el total de la propuesta queda por debajo de `conditions.minimum_total`, `send_proposal` responde `422 BELOW_MINIMUM` salvo que llegue `below_minimum_reason`; el motivo queda en `proposals.below_minimum_reason` (excepción comercial). La app lo pide antes de enviar.
- `portal_reservation_detail` incluye también `revision`, `event_type`, `dates_definitive`, `organizer_notes`, `special_setup` y `technical_support` (B14).
- `portal_proposals({reservation_id})`: propuestas `enviada` y `aceptada` con líneas, condiciones, tramos y validez (nunca borradores ni sustituidas).
- `portal_request({reservation_id, kind: 'quiere_confirmar'|'comentario', proposal_id?, message?})` → `booking.portal_requests` (estado `enviada`/`vista`/`respondida`, que cambia el personal). `portal_my_requests` las lista. **La aceptación sigue siendo del personal** (`accept_proposal`).

**Avisos al comercial:** las acciones del portal dejan un aviso en `booking.portal_notices` (tabla cerrada) y `POST /api/v1/worker/portal/tick` (sonda `booking.portal_has_work`) crea las peticiones a Tasks con la cuenta de servicio (formato de `docs/tasks/API.md` §22): `booking.organizer_dates` (`RES<código>-FECHAS-<n>`), `booking.organizer_confirm` (`RES<código>-CONFIRMAR`, prioridad alta) y `booking.proposal_comment` (`PROP<código>-COMENTARIO-<n>`), sin datos de contacto. El ámbito de los portales se comprueba con `core.portal_in_scope` (K1).

## 22. Fase 3 de los portales · lo contratado y el proyecto del retiro en Tasks

Migración `20261008_0455_booking_phase3.sql`.

- **Lo contratado (F1):** `portal_reservation_detail.contract` (o `null` sin propuesta aceptada): `proposal_version`, `total`, `deposit_required`, `prices_include_vat`, `vat_amount`, `payment_type` (forma de pago acordada) y `due` con la **señal** (a los `deposit_days` de la aceptación, o `deposit_days_short` si la entrada está a menos de `short_notice_days`) y el **saldo solo con su importe**, sin fecha: el plazo máximo para exigirlo (`conditions.balance_deadline_hours_after_end`, 24 h tras el final del evento por defecto) es **interno** y solo lo ve el personal en la ficha («Plazo máximo del saldo» y, pasado el plazo, el aviso: compara lo contratado —total de la propuesta aceptada— con `collected` de `invoices.reservation_collected` (Finance, #324): cobrado del todo, sin aviso; si falta, «Saldo pendiente: plazo máximo vencido. Falta cobrar …»; sin red o sin respuesta de Finance, «Plazo máximo del saldo vencido: revisa en Finance si está cobrado»).
- **Proyecto del retiro en Tasks (B13, `docs/tasks/API.md` §23):** `POST /api/v1/worker/tasks/tick` (sonda `booking.tasks_has_work`) llama a `worker/requests/project` con `kind: 'booking.retreat_project'`, `external_ref: 'RES<código>'`, la fecha de entrada y el título, y `state` `confirmed` (reserva confirmada, en ejecución o cerrada) o `cancelled` (cancelada, perdida o archivada, si ya tenía proyecto). La misma llamada renombra si cambian la fecha o el título. Con `no_route` reintenta. Después, una tarea por cada **extra** de la propuesta aceptada (`kind: 'booking.retreat_extra'`, `external_ref: 'RES<código>-EXTRA-<línea>'`, `project_ref`, vencimiento el día de entrada); `409 PROJECT_NOT_READY` reintenta. Si el proyecto está en la papelera de Tasks (`deleted`), sus extras se abandonan hasta que vuelva a `created`, `restored` o `renamed`. Estado en tablas cerradas `booking.tasks_projects` y `booking.tasks_extras`. Sin datos de contacto.

## 23. Fases 4 y 5 de los portales · programa del retiro y huésped de muestra

Peticiones B16 (Organizers) y BG9, BG11 y BG12 (Guests). Migración 0459.

- **Programa** (`booking.program_items`, sincronizable, uno por evento y común a los dos portales): `day` (dentro de las fechas de la reserva; si las fechas cambian después, la ficha marca lo que queda fuera), `starts_at` y `ends_at` (sin hora = «durante el día»; el fin necesita inicio y es posterior), `title` (≤ 120), `space_id` **o** `place_text` (≤ 80), `public_note` (≤ 500), `internal_note` (solo personal y organizador), `kind` (`actividad` · `comida` · `descanso` · `otro`), `optional` (reservado) y `position`. El personal lo ve y corrige en el bloque «Programa» de la ficha.
- **Lectura `booking.portal_program({reservation_id})`** para `organizers` y `guests`: `{revision, confirmed, start_date, end_date, items: [{id, revision, day, starts_at 'HH:MI', ends_at, title, place, space_id, place_text, public_note, kind, position}]}`. `place` es el nombre público del espacio (`spaces.public_name`, o su nombre) o `place_text`. `revision` es la suma de revisiones del programa (crece con cada cambio, también al quitar). Solo para `organizers`: `internal_note` en cada actividad y `spaces` (salas y exteriores activos para elegir). El huésped la lee si alguno de los huéspedes de esa reserva es suyo; si no, `OUT_OF_SCOPE`.
- **Acciones del organizador** (`organizers`, editor u owner), con la reserva confirmada (si no, `EVENT_REQUIRED`):
  - `booking.portal_program_save({reservation_id, item: {id, day?, starts_at?, ends_at?, title?, space_id?, place_text?, public_note?, internal_note?, kind?, position?}, expectedRevision?})` → `{id, revision}`. El `id` lo genera el cliente: si no existe se crea; si existe, se cambian solo los campos enviados (`""` deja el campo vacío). Errores: `PROGRAM_DAY_OUT_OF_RANGE`, `VERSION_CONFLICT`, `OUT_OF_SCOPE`, `INVALID_FIELDS`.
  - `booking.portal_program_remove({reservation_id, id, expectedRevision?})`.
  - `booking.portal_program_reorder({reservation_id, ids})`: posiciones 1..n en ese orden (como mucho 200).
- **Huésped de muestra (BG11):** `booking.portal_preview_guest({reservation_id})` (organizador, reserva confirmada) crea o devuelve `{guest_id, created}`: uno por evento (`guests.preview`). El enlace de Guests para abrirlo lo emite el núcleo (C9). No sale en `portal_guests` ni cuenta en `portal_reservations`, `guest_summary` ni en las listas del personal; sus restricciones no llegan a `food_event_projection`; no se puede marcar su llegada (`check`), así que nunca entra en un parte de SES; ninguna escritura como huésped (`portal_guest_update`, `portal_set_restrictions`, firma…) se acepta: `403 PREVIEW_READ_ONLY`. Solo esa acción lo crea, y `preview` no se cambia después.
- **BG12:** ya estaba: `reservation_id` es la última columna de `booking.food_event_projection` (0404).
- **Nombre público de los espacios:** `spaces.public_name` (opcional), editable por el personal.

### 23.1 Alojamiento delegable (fase 5: B17 y BG10, migración 0460)

Decisiones del usuario (8-10-2026): el huésped **solo elige entre las camas con baño ya contratadas** por el organizador (elegir no factura nada nuevo: el suplemento de las de 2–4 plazas con baño va en la propuesta); la preferencia de compañeros la ven el personal y el organizador.

- **Inventario del retiro:** las habitaciones con alguna asignación viva del evento (el personal las asigna, también como grupo sin cama). Columnas nuevas: `spaces.en_suite`; `room_assignments.source` (`guest` · `organizer` · `staff`, la pone el servidor según quién escribe) y `status` (`confirmed` · `requested`; una pendiente ya ocupa la cama); `guests.room_preference` (≤ 200) y `needs_ground_floor`.
- **Ajustes** (`booking.lodging_settings`, uno por evento: `choice` `off` · `choose` · `request`, `choose_until` inclusive en hora de Madrid, `preferences`) y **habitaciones abiertas** (`booking.open_rooms`: `space_id`, `option_key` `[a-z0-9_-]{1,40}`, `supplement`). Los ve y corrige el personal.
- **Guests:**
  - `booking.portal_lodging({guest_id})` → `{choice, choose_until, open, preferences, mine: {space_name, zone, bed_label, status, source} | null, preference: {text, ground_floor} | null, rooms}`. `rooms` solo con elección y solo las abiertas del retiro: `{space_id, name, zone, kind, capacity, en_suite, small_en_suite, option_key, open, supplement, beds_total, beds_free, beds: [{bed_id, label, kind, free, mine}]}`. Nunca de quién es una cama.
  - `booking.portal_choose_bed({guest_id, bed_id})`: bloquea la cama (`for update`), comprueba que está libre en las noches de la reserva y sustituye en el mismo lote la asignación anterior del huésped → `{assignment_id, revision, status}` (`requested` con `choice = 'request'`). Errores: `BED_TAKEN` (409), `CHOICE_CLOSED`, `NOT_OFFERED`, `OUT_OF_SCOPE`, `PREVIEW_READ_ONLY`; la invariante `BED_OVERBOOKED` sigue al final del lote.
  - `booking.portal_release_bed({guest_id})`: suelta la que eligió él mientras siga abierta.
  - `booking.portal_room_preference({guest_id, text, ground_floor, expectedRevision?})` → `{revision}`.
- **Organizers** (reserva confirmada; si no, `EVENT_REQUIRED`):
  - `booking.portal_rooms({reservation_id})` → `{settings, rooms (las del retiro, con cada cama: assignment_id, guest_id o group_label, status, source), pending: [{assignment_id, revision, guest_id, space_id, bed_id}], preferences: [{guest_id, text, ground_floor}]}`. Los nombres, de `portal_guests`.
  - `booking.portal_assign_bed({reservation_id, guest_id, bed_id | null})`: cualquier cama del retiro (también sin baño), libre; `null` la quita.
  - `booking.portal_room_settings({reservation_id, choice?, choose_until?, preferences?, rooms?: [{space_id, option_key?, supplement?}], expectedRevision?})`: `rooms` sustituye la lista; solo habitaciones **con baño** del retiro (si no, `NOT_OFFERED`).
  - `booking.portal_approve_bed({reservation_id, assignment_id, approve})`: confirma o quita una plaza pendiente.
- **Personal:** en «Alojamiento» de la ficha, cada asignación dice si está pendiente y quién la hizo, con la preferencia del huésped.

### 23.2 B18 · `booking.reservation_end_dates` (migración 0461)

Vista para la conservación de Organizers (borra las respuestas de los huéspedes a los 6 meses del fin del retiro): `reservation_id`, `end_date` y `status` (el de la reserva, o `borrada` si se borró, para que lo suyo también caduque). Sin datos personales. Se lee por SQL desde el schema `organizers` (lint, #334); no es una lectura de portal.

### 23.3 Marcadores en el «Texto de las condiciones» (migración 0462)

Decisión del usuario (8-10-2026): el texto no repite las cifras de los campos; las nombra con marcadores que se resuelven al pintar (documento de la propuesta, tarjeta de condiciones y `portal_proposals`, que ya devuelve `conditions.text` resuelto). Lógica en `_domain/booking/conditionsText.ts` (`renderConditionsText`) y, en español, en SQL (`booking.conditions_text`); una prueba comprueba que dan lo mismo.

| Marcador | Valor |
|---|---|
| `{{condiciones.senal_porcentaje}}` | `deposit_percent` («30 %») |
| `{{condiciones.senal_minima}}` | `deposit_minimum` («1.234,50 €») |
| `{{condiciones.senal_plazo}}` | `deposit_days` («7 días») |
| `{{condiciones.senal_plazo_corto}}` | `deposit_days_short` |
| `{{condiciones.poca_antelacion}}` | `short_notice_days` |
| `{{condiciones.iva}}` | `vat_rate` («10 %») |
| `{{condiciones.minimo}}` | `minimum_total` («2.500 €») |
| `{{condiciones.cancelacion}}` | tramos, uno por línea, de mayor a menor antelación: «Con 90 días o más de antelación: se devuelve el 100 % de la señal.»; el de 0 días, «Con menos de 45 días: no se devuelve la señal» (más « y se cobran costes extra» con `extra_costs`); un único tramo de 0 días, «En cualquier momento: …» |

- **Bloques:** `{{#condiciones.x}}…{{/condiciones.x}}` desaparece si el campo está vacío (null o 0; sin tramos, para `cancelacion`). Sin espacios dentro de las llaves.
- **Nunca** hay marcador para `balance_deadline_hours_after_end` (interno).
- **Desconocidos:** se ven tal cual; el editor los señala en la vista previa y avisa al guardar (no bloquea).
- **Editor:** ayuda con la lista de marcadores y vista previa resuelta con los valores del formulario y los tramos guardados.
- **Inglés:** `renderConditionsText(…, 'en')` formatea en `en-GB` («12.5%», «€2,500») para cuando haya versión inglesa; el SQL del portal resuelve en español.

## Anexo · Campos de C03 y C04 que no se portan

Siguiendo el handoff §4–§6 («campos ya depurados»). Si alguno se echa en falta, se añade antes de G3.

| Origen | Campo | Motivo |
|---|---|---|
| C03 | `ID_lead`, `responsable_comercial`, `fase_comercial` | sin CRM en V1 |
| C03 | `estado_reserva = propuesta_enviada`, `presupuesto_enviado_si_no`, `fecha_presupuesto` | sin histórico de propuestas |
| C03 | `fecha_briefing_final` | el handoff conserva solo el indicador |
| C03 | `fecha_senal` | la cubre `reservation_finance.payment_date` |
| C03 | `interes_servicio_infantil` | fuera de V1; queda `minors_count` |
| C03 | `num_personas_final` | pasa al evento (`final_guests`) |
| C03 | `estado_cobro_prev`, `estado_confirmacion`, `noches`, `archivado` | derivados o sustituidos por `archived_at` |
| C03 | `ID_evento_principal`, `ID_factura_emitida_principal` | relación por FK; facturas emitidas fuera de alcance |
| C03 | `calendar_*`, `_calendar_registry` | sustituidos por `calendar_links` |
| C04 | `nombre_evento_visible`, `nombre_grupo_ref`, `tipo_evento`, fechas, `num_personas_previsto`, `uso_*` | viven en la reserva |
| C04 | `estado_evento` | derivado |
| C04 | `briefing_operativo_recibido` | queda `briefing_received` en la reserva |
| C04 | `plan_infantil`, `necesita_supervision_infantil`, `observaciones_infantiles_operativas` | fuera de V1 |
| C04 | `estado_rotacion` | lo cubre el checklist `salida_rotacion` |
| C04 | `cierre_operativo_realizado`, `fecha_cierre_operativo` | `closed_at` |
| C04 | `ID_feedback_principal` | C10 fuera de alcance |
| C04 | `huespedes_raw_=>`, `_raw_control_c04`, formularios | mecanismo de Sheets |
