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

Las dos primeras las pide Food en su documento (`docs/food/API.md` §7.1, su petición P5), igual que el `event_revision` monótono descrito arriba y los catálogos cerrados de `meal_plan` y `menu_style`, que son los `check` de §2.1 y §2.2. Si Core prefiere la lista exacta del contrato, las cuatro se quedan fuera y la vista filtra a `confirmada`, `en_ejecucion` y `cerrada`.

### 7.2 Lo que lee Invoices

Invoices asigna líneas de compra a un evento de Booking. Decisión de Core (ronda 5): **reutiliza `booking.food_event_projection`**, registrada también para la app `invoices` (migración `20261006_0402`). No se crea una vista aparte: la proyección no lleva huéspedes ni datos personales, y sus columnas de identificación (`event_id`, `event_code`, `reservation_code`, `title`, fechas, `reservation_status`, `event_revision`) son las que Invoices necesita. Solo hay eventos en la proyección, así que una reserva sin confirmar no es asignable.

Booking no consume enlaces de otras apps en V1. El «coste por retiro» leyendo `invoices.booking_cost_projection` queda para G4.

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
  - **Operación** (si hay evento): llegada, salida, responsable, estados, montaje, distribución, checklist por tipo, cierre.
  - **Huéspedes**: recuentos; lista completa solo para quien los ve.
  - **Comidas**: régimen solicitado y confirmado, tipo de menú, notas, restricciones («1 alergia a pistacho · 2 veganos»).
  - **Cobro** (solo `editor` y `owner`): presupuesto, importe final, señal y su estado derivado, tipo, titular y fecha del pago.
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
