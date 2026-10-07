# Ikisai Organizers · API y pantallas (puerta G2)

Portal externo de los organizadores de retiros: `organizers.ikisai.com` (alias `organiza.ikisai.com`, redirige). Especificación de partida: `coordinacion/ampliacion/PORTALES.md`; núcleo en el contrato §3.3, §3.4, §3.6 y §3.7; datos en `docs/booking/API.md` §16 y §17.1. Sigue la plantilla `docs/core/PLANTILLA_API_APP.md`.

**Producto:** manda el diseño conjunto Organizers + Guests (`coordinacion/ampliacion/PORTALES_V2.md` y `portales_v2/02_AGENTE_ORGANIZERS.md`), que el usuario aprobó el 7-10-2026. El ciclo del retiro va en seis fases (§13).

**Lo que describen §1 a §12** es la **fase 1, preparación**: entrada por enlace, mis retiros, ficha del retiro, asistentes, cocina, «Ayuda y sugerencias» y el hueco de «Guarda tu acceso». Se suman los ajustes de V2 que entran ya en esta fase (§13.1). Las fases 2 a 6 están en §13 a grandes rasgos, y cada una tendrá su G2 antes del código.

## 1. Dominio y límites

Organizers deja al organizador de un retiro consultar su reserva y gestionar la lista de sus asistentes desde el móvil, sin cuenta ni contraseña: entra con el enlace personal que le manda Ikisai.

| Hace | Lee o escribe en otra app | No hace en la fase 1 |
|---|---|---|
| lista de sus retiros y ficha de cada uno; alta, datos y baja de asistentes; enlaces personales de sus huéspedes (emitir, reenviar, revocar); recordatorios para copiar; resumen de cocina; ayuda y sugerencias | **Booking** es dueña de reservas, huéspedes y restricciones: lecturas `booking.portal_*` y acciones `booking.portal_*` (§16.6). **Núcleo**: enlaces (`portal-links`, `auth/link`), catálogo, feedback y uso | importes, pagos, facturas, habitaciones, programa, menú de Food, firma del parte (solo el huésped), envío de correos o mensajes desde el servidor, comentarios de los huéspedes sobre el retiro (fase posterior), cuenta permanente (la prepara Core) |

**Organizers no guarda copia de los datos de Booking** ni tiene tablas propias en la V1: todo se lee y se escribe en Booking, filtrado por el ámbito del enlace (`membership.scopes.grants = [{reservation_id}]`). Si más adelante hacen falta borradores o mensajes, irán en el schema `organizers` (migraciones `0700–0799`).

**Público:** personas de fuera, a menudo en el móvil y con prisa. Textos claros y en segunda persona («tus asistentes»), sin jerga (nunca «SES», «ámbito», «revisión», «sincronizar»), botones grandes, una tarea por pantalla.

## 2. Tablas sincronizables (`organizers.*`)

Ninguna en la V1. No hay migraciones de Organizers en esta tanda.

## 3. Procedimientos (`call`)

Ninguno propio. Las escrituras son acciones de Booking invocadas con `POST /api/v1/invoke/<acción>` (§6.2).

## 4. Hooks de validación

Ninguno en la Edge. Las validaciones están en las acciones de Booking (ámbito, reserva confirmada, modo de datos, procedencia, declaración). El cliente valida antes de enviar lo mismo que el dominio de Booking (`_domain/booking/portal.ts`: `PORTAL_GUEST_FIELDS`, `guestMissing`, `OPERATIVE_GUEST_FIELDS`) para avisar en el formulario y no tras el viaje al servidor; lo importa por `packages/domain-booking` (solo lectura del código ajeno, sin copiarlo).

## 5. Visibilidad

Ámbito por reserva: la pertenencia `editor` del organizador al portal lleva `scopes.grants = [{reservation_id}, …]` (una entrada por reserva, añadidas por cada enlace que le emite Booking). La comprueban las funciones de Booking en cada llamada (`booking.portal_in_scope`); fuera de ámbito o inexistente, `403 OUT_OF_SCOPE`. Organizers no tiene tablas, así que no necesita `visible()`. `GET members` solo devuelve al propio miembro (contrato §3.6).

Privacidad de los huéspedes (Booking §16.3, ya aplicada por `booking.portal_guests`):
- el organizador ve **nombre e inicial del primer apellido** (`display_name`) y el estado de cada asistente;
- de cada campo ve **el valor solo si lo escribió él**; si lo escribió el huésped o el personal llega `true` y se muestra «Rellenado ✓», sin valor ni forma de verlo;
- alergias e intolerancias de un huésped, solo si el huésped lo consintió (`allergies_shared`); si no, solo agregadas sin nombres en el resumen de cocina;
- la firma, solo «firmada / pendiente».

## 6. Rutas

### 6.1 Edge `organizers-api`

`createApp({ app: 'organizers', slug: 'organizers-api', portalIssuer: true, origins: ['https://organizers.ikisai.com', 'https://organiza.ikisai.com', <local>] })`. **Sin rutas propias en la V1**: todo lo que necesita lo monta el kit.

| Ruta (prefijo `/api/v1/`) | Uso en Organizers |
|---|---|
| `POST auth/link {token}` | canje del enlace personal → sesión (y pase de la sesión única). `401 LINK_INVALID` / `401 LINK_EXPIRED {validUntil}` |
| `POST auth/sso`, `refresh`, `logout` | los gestiona `sync-client` |
| `GET me`, `GET bootstrap` | nombre de la persona y sus ámbitos |
| `GET apps` | lanzador del kit (catálogo) |
| `POST read/booking.portal_reservations {}` | Mis retiros (las lecturas con argumentos van por `POST read/:name` con los `args` en el cuerpo; `GET read` solo admite filtros `where[…]` de vistas) |
| `POST read/booking.portal_reservation_detail {reservation_id}` | ficha del retiro: horas, plazas, régimen, servicios (B1) |
| `POST read/booking.portal_guests {reservation_id}` | asistentes de un retiro |
| `POST read/booking.portal_kitchen_summary {reservation_id}` | resumen de cocina |
| `POST invoke/booking.portal_add_guest` · `portal_update_guest` · `portal_remove_guest` · `portal_set_restrictions` | escrituras (§6.2) |
| `POST portal-links {app: 'guests', scope: {reservation_id, guest_id}, person: {name, email?}, label}` | enlace personal de un huésped → `{linkId, url, validUntil, shownOnce}` |
| `GET portal-links?reservation=` | enlaces de huésped de la reserva: `lastUsedAt` dice si el huésped lo ha abierto |
| `POST portal-links/:id/revoke` | anular un enlace de huésped (ampliar es solo del personal) |
| `POST feedback`, `feedback/uploads` (+ `verify`), `GET feedback?mine=true` | «Ayuda y sugerencias» |
| `POST usage/batch` | uso sin persona (`createUsage({ notice: false })`) |
| `GET read/central.common_texts_projection` | textos legales y de contacto (§9.11) |
| `GET auth/config` | `permanentAccount` para «Guarda tu acceso» (§9.8) |

Si Core prefiere menos viajes en la ficha (tres lecturas en paralelo), se puede añadir una ruta compuesta `GET retreat/:reservationId` que junte reserva, asistentes y cocina; no la propongo de entrada porque las tres lecturas ya van en paralelo y con caché (§10).

### 6.2 Lecturas y acciones de Booking (lo que ya existe, `main`)

Todas reciben `args` y responden `403 OUT_OF_SCOPE` fuera de ámbito.

| Nombre | `args` | Devuelve / hace | Errores que la interfaz traduce |
|---|---|---|---|
| `booking.portal_reservations` | — | `{items: [{id, code, title, start_date, end_date, expected_guests, status, confirmed, mode, guests, complete}]}` | — |
| `booking.portal_guests` | `reservation_id` | `{confirmed, mode, items: [{id, revision, display_name, fields{campo: valor \| true \| null}, missing[], signed, allergies_shared, restrictions[]}]}` | — |
| `booking.portal_kitchen_summary` | `reservation_id` | `{totals: [{restriction_type, subject, servings}], named: [{guest, restriction_type, subject, severity}]}` | — |
| `booking.portal_add_guest` | `reservation_id, guest_id` (uuid del cliente), `fields`, `declaration?`, `declaration_version?` | alta con procedencia «organizador» | `RESERVATION_NOT_CONFIRMED`, `GUEST_DATA_OFF`, `DECLARATION_REQUIRED`, `INVALID_FIELDS` (falta el nombre) |
| `booking.portal_update_guest` | `guest_id, expectedRevision, fields`, `declaration?` | rellena campos | `FIELD_OWNED_BY_GUEST`, `VERSION_CONFLICT`, `DECLARATION_REQUIRED` |
| `booking.portal_remove_guest` | `guest_id, expectedRevision` | baja (a la papelera de Booking) y revoca su enlace | `GUEST_CHECKED_IN`, `VERSION_CONFLICT` |
| `booking.portal_set_restrictions` | `guest_id, items: [{restriction_type, subject?, severity?, kitchen_notes?}]` (≤ 30) | **sustituye** las restricciones que escribió el organizador para ese huésped | `FIELD_OWNED_BY_GUEST`, `DECLARATION_REQUIRED` |

Lo que falta de Booking para la ficha («horas» y «lo que incluye») y para que el alta sea idempotente está en §14.

### 6.3 Mensajes de error para el organizador

| Código | Texto |
|---|---|
| `LINK_INVALID` | «Este enlace no es válido o ya no está activo. Pide uno nuevo a Ikisai.» |
| `LINK_EXPIRED` | «Este enlace caducó el {fecha}. Si tu retiro sigue en marcha, pide uno nuevo a Ikisai.» |
| `RESERVATION_NOT_CONFIRMED` | «Podrás añadir a tus asistentes cuando la reserva esté confirmada.» |
| `GUEST_DATA_OFF` | (no se ofrece el apartado; si llega, «En este retiro no hace falta la lista de asistentes.») |
| `DECLARATION_REQUIRED` | abre la casilla de la declaración (§9.5) y reintenta al aceptarla |
| `FIELD_OWNED_BY_GUEST` | «{Nombre} ya ha rellenado este dato. No hace falta que lo cambies.» y recarga la ficha |
| `GUEST_CHECKED_IN` | «{Nombre} ya ha hecho la entrada. Para darle de baja, habla con Ikisai.» |
| `VERSION_CONFLICT` | «Alguien ha cambiado estos datos mientras los editabas. Te enseñamos lo último.» y recarga, conservando lo tecleado en el formulario |
| `OUT_OF_SCOPE` / `NO_MEMBERSHIP` | «Ya no tienes acceso a este retiro.» y vuelve a Mis retiros |
| `UNAUTHENTICATED` sin pase | pantalla de entrada (§9.1) |
| red / `BACKEND_UNAVAILABLE` | «Sin conexión. Tus cambios no se han guardado; inténtalo cuando vuelvas a tener red.» |

## 7. Proyecciones y enlaces

Organizers no publica proyecciones. Consume las lecturas de Booking de §6.2 (registradas por Booking con `core.allow_read('organizers', …)`).

Enlaces de huésped: los emite el organizador con `createApp({ portalIssuer: true })`; el núcleo solo le deja emitir enlaces de **huésped** y de **sus** reservas, y no ampliar (§3.6). La URL (`https://guests.ikisai.com/i/<token>`) se muestra una sola vez: para reenviar se emite otra y se revoca la anterior (§9.4).

## 8. Archivos

Ninguno propio en la V1. Las imágenes de «Ayuda y sugerencias» van por `feedback/uploads` (bucket `feedback-media`, kit). Si un día Organizers guarda archivos, usará `createStorage`, declarará sus campos con `core.register_file_field` y activará `core.enable_file_gc('organizers')`.

## 9. Pantallas y navegación

PWA `apps/organizers` sobre `createAppShell` del kit 0.18.x: marca «Organizers» con lanzador (sesión única), sin navegación inferior (dos niveles: Mis retiros → Retiro con pestañas). Móvil primero; en escritorio, columna central de lectura cómoda. `data-feedback-ignore` en nombres, contactos y datos de asistentes.

### 9.1 Entrada (`/i/<token>` y `/`)

- **`/i/<token>`**: llama a `POST auth/link`, guarda la sesión, **quita el token de la URL** (`history.replaceState` a `/`) antes de pintar nada y va a Mis retiros. Si en el dispositivo había otra persona con sesión, se cierra la suya primero (`onSessionEnd`, limpia la caché local).
- `LINK_INVALID` y `LINK_EXPIRED`: pantalla con el texto de §6.3 y el correo y el teléfono de contacto, que salen de los textos comunes de Central (§9.11).
- **`/` sin sesión** (ni pase de sesión única): «Para entrar, abre el enlace que te enviamos por correo o WhatsApp.» Debajo, el hueco de la cuenta permanente («Entrar con Google», «Recibir un código por correo») oculto hasta que Core lo active (§9.8).

### 9.2 Mis retiros (`#/`)

Tarjetas ordenadas por fecha de inicio: título, fechas («del 12 al 15 de marzo»), estado en lenguaje claro y, si la reserva está confirmada y pide datos, «8 de 20 asistentes completos». Con **un solo retiro, se abre directamente** su ficha (la tarjeta queda a un toque con «Mis retiros»). Los cancelados, al final y atenuados.

Estados (de `booking.reservations.status`):

| Booking | Organizers |
|---|---|
| `en_estudio`, `negociacion` | En preparación |
| `pre_reservada` | Prerreservada |
| `confirmada` | Confirmada |
| `en_ejecucion` | En curso |
| `cerrada` | Finalizada |
| `cancelada`, `perdida` | Cancelada |

### 9.3 Retiro (`#/retiro/<id>`), pestaña Resumen

- Cabecera: título, código (pequeño, para hablar con Ikisai), fechas, **horas de llegada y salida** y estado.
- **Plazas:** personas previstas (y confirmadas, cuando Booking las dé), de ellas menores.
- **Lo que incluye:** alojamiento sí/no, régimen de comidas («Pensión completa», «Media pensión», «Desayuno», «Según programa»), estilo de menú (vegetariano, vegano, mixto) y espacios (centro de interpretación, zonas exteriores, piscina), en frases cortas.
- **Asistentes:** «8 de 20 completos · 3 sin firma», con botón a la pestaña. Antes de confirmar: «Podrás añadir a tus asistentes cuando la reserva esté confirmada.» Con modo `ninguno`: el bloque no aparece.
- **Cocina:** totales («3 vegetarianos · 1 alergia a frutos secos»), con botón a la pestaña.

Horas, plazas confirmadas y «lo que incluye» necesitan la lectura de §14 (B1); hasta que exista, el bloque muestra solo fechas, estado y personas previstas.

### 9.4 Asistentes (`#/retiro/<id>/asistentes`)

Lista con `display_name` y una etiqueta de estado: **Completo**, **Faltan datos** (con la lista corta: «documento, dirección») o **Falta la firma** («la hará {nombre} al abrir su enlace o al llegar»; solo en modo `ses`). Filtros rápidos: Todos · Faltan datos · Completos. Encima, «Añadir asistente» y «Copiar recordatorio para el grupo».

- **Añadir asistente:** hoja con nombre (obligatorio) y apellido; el resto es opcional y se puede rellenar después. La primera vez en esa reserva pide la **declaración** (§9.5). El `guest_id` lo genera el cliente.
- **Ficha del asistente** (`#/retiro/<id>/asistentes/<guestId>`), en bloques plegables según el modo:
  - `ses`: Identidad (nombre, apellidos, sexo, fecha de nacimiento, nacionalidad y, si es menor, persona responsable y parentesco) · Documento (tipo, número, número de soporte) · Residencia (dirección, código postal, ciudad, país) · Contacto (teléfono, correo) · Alimentación.
  - `operativo`: nombre, primer apellido, teléfono, correo · Alimentación. Nunca documento, dirección, nacimiento ni firma.
  - Cada campo: si llega su valor (lo escribió el organizador), se edita; si llega `true`, «Rellenado ✓» **sin edición** (lo escribió el huésped o Ikisai); si llega `null`, vacío y editable. Se guarda con `portal_update_guest` y la `revision` que se cargó.
  - **Alimentación:** lista de restricciones del organizador para ese huésped (tipo, qué, gravedad para alergias e intolerancias, nota para cocina) que se guarda entera con `portal_set_restrictions`; las del huésped, solo si consintió, en solo lectura con «Indicado por {nombre}».
- **Enviar su enlace:** emite `POST portal-links` con `person.name = display_name` y, si el organizador escribió su correo, `person.email`. Abre la hoja de compartir con el texto de §9.6: **Web Share** (`navigator.share`) cuando exista; si no, **WhatsApp** (`https://wa.me/<teléfono>?text=…` si el organizador escribió el teléfono, `https://wa.me/?text=…` si no) y **Copiar**. Aviso: «Este enlace es personal: envíaselo solo a {nombre}.» Estado bajo el nombre, de `GET portal-links`: «Enlace sin enviar» / «Enlace enviado el 3 de marzo» / «Lo abrió el 4 de marzo». **Reenviar** emite uno nuevo y revoca los anteriores de ese huésped (pendiente de la petición C2 de §14).
- **Copiar recordatorio** (por asistente): texto con lo que le falta y, si se acaba de generar, su enlace.
- **Copiar recordatorio para el grupo:** sin nombres (se pega en grupos): «Hola a todos: para el retiro {título} ({fechas}) aún hay {n} personas con datos por completar. Abrid el enlace personal que os mandé; si no lo encontráis, decídmelo y os lo reenvío.»
- **Dar de baja:** confirmación «Se quitará a {nombre} de este retiro y su enlace dejará de funcionar.» → `portal_remove_guest`.

### 9.5 Declaración del organizador

Casilla obligatoria la primera vez que el organizador escribe datos de otros en una reserva. Booking la guarda en `booking.portal_declarations` con la **versión aceptada** (`declaration_version`). El texto es `organizers.declaration` de los textos comunes de Central (§9.11), versión `v1`:

> ☐ Facilito estos datos con conocimiento de mis asistentes y solo para organizar su estancia en Ikisai. Cada asistente recibirá la información sobre protección de datos al abrir su enlace personal.

«Más información» muestra `portal.privacy`. La casilla aparece cuando `portal_guests.declared` es `false` (B2); si aun así la acción responde `DECLARATION_REQUIRED`, se resalta y se pide.

### 9.6 Textos para compartir el enlace

> Hola, {nombre}: este es tu enlace personal para el retiro «{título}» en Ikisai ({fechas}). Ábrelo para completar tus datos antes de llegar: {url}

En modo `ses` añade: «Son los datos que exige el registro de viajeros.»

### 9.7 Cocina (`#/retiro/<id>/cocina`)

- **Totales** del grupo sin nombres, de `portal_kitchen_summary.totals`: «Vegetariano · 3», «Alergia: frutos secos · 1».
- **Con nombre**, solo lo que el organizador escribió o lo que el huésped le dejó ver (`named`).
- Texto: «Si alguien tiene una alergia, añádela en su ficha o pídele que la indique en su enlace.»

### 9.8 «Guarda tu acceso» (hueco)

Botón flotante discreto en Mis retiros y Retiro (no en las fichas de asistente, donde taparía el estado del guardado). Hasta que Core active la cuenta permanente (Google y código por correo, con Workspace), abre una hoja: «Pronto podrás guardar tu acceso con tu cuenta de Google o con un código por correo. Mientras tanto, guarda el enlace que te enviamos.» El indicador es `GET auth/config → permanentAccount` (C3, hoy `false`). El componente queda listo para conectarle las dos acciones.

### 9.9 Ayuda y sugerencias

Entrada en el panel del lanzador (sin «Señalar para comentar» ni «Revisor de QA»). Abre `createFeedbackProgressiveForm` del kit con este catálogo (especificación de feedback §3.2 y §4):

1. «¿Sobre qué quieres comentarnos algo?» → **La aplicación** · **Mi retiro** · **Un espacio de Ikisai**.
2. Aplicación → «Algo no funciona» / «Tengo una sugerencia» (`intent: bug | improvement`) → paso `signal` («Mantén pulsado sobre el lugar de la aplicación al que te refieres»; se puede saltar) → comentario e imágenes. `subject: application`.
3. Mi retiro → retiro (se omite si ya se está dentro de uno: `known`) → tipo: Montaje y mobiliario · Alojamiento · Limpieza · Cocina · Técnico · Horarios y operación · Otra petición (`category: setup | accommodation | cleaning | food | technical | operation | other`) → comentario. `subject: event`, `scope: {reservation_id}`, `intent: problem | suggestion`.
4. Espacio → lugar (Habitación · Comedor · Sala · Baños · Exterior · Piscina · Otro; como texto, sin `space_id`, porque los espacios de Booking quedan para la decisión de habitaciones) → tipo: Algo está roto · Limpieza · Falta algo · Agua o electricidad · Seguridad · Otra cosa (`damage | cleaning | missing | utilities | safety | other`) → comentario e imagen. `subject: space`, `scope: {reservation_id}` si se está dentro de un retiro.

Debajo, «Lo que me has enviado» (`GET feedback?mine=true`) con el estado en claro (Recibido · En marcha · Resuelto). Los comentarios de huéspedes sobre el retiro (bandeja del organizador) son de una fase posterior.

### 9.10 Uso y `data-feedback-id`

`createUsage({ app: 'organizers', notice: false })`. Identificadores literales `organizers.<pantalla>.<sección>.<elemento>`; los principales:

```text
organizers.entrada.enlace.error            organizers.retiros.lista.abrir
organizers.retiro.pestanas.asistentes      organizers.retiro.resumen.ver_asistentes
organizers.asistentes.lista.anadir         organizers.asistentes.lista.recordatorio_grupo
organizers.asistentes.alta.guardar         organizers.asistente.ficha.guardar
organizers.asistente.ficha.enviar_enlace   organizers.asistente.ficha.reenviar_enlace
organizers.asistente.ficha.recordatorio    organizers.asistente.ficha.baja
organizers.asistente.enlace.whatsapp       organizers.asistentes.declaracion.aceptar
organizers.cocina.resumen                  organizers.acceso.guardar.abrir
organizers.ayuda.formulario
```

`usage.run` en: alta, guardar ficha (datos y alimentación), enviar enlace, reenviar, baja y los dos recordatorios. Todos los ids son literales (el catálogo de la publicación no recoge los construidos en ejecución); `tests/organizers/feedback-ids.test.ts` lo comprueba.

### 9.11 Textos legales y de contacto (decisión del usuario, 7-10-2026)

Ningún texto legal ni de contacto va fijo en el código: se leen de Central (`GET read/central.common_texts_projection`, columnas `key, title, body, version, kind`) al abrir la sesión. Claves: `organizers.declaration`, `portal.privacy`, `contact.email` y `contact.phone`. Son públicos: la última copia se guarda en el dispositivo sin persona, para la pantalla de entrada sin sesión. En el código solo hay un texto de reserva por si la lectura falla sin red y sin copia (`apps/organizers/src/app/common-texts.ts`).

### 9.12 Campos booleanos

`is_minor` no se ofrece al organizador: `booking.portal_guests` devuelve `true` tanto si otra persona lo rellenó como si vale `true`, y un booleano por defecto (`false`) sale siempre como «rellenado». Los campos de persona responsable y parentesco se piden como texto «si es menor» (petición B5).

## 10. Offline

Organizers **no tiene espejo** (sin tablas propias) y las acciones de Booking no van por la cola de `sync-client`. Comportamiento:

- `sync-client` 0.4 con `tables: []`: sesión, renovación, sesión única, `api()` y `onSessionEnd`.
- **Lecturas con caché** en IndexedDB por persona (`organizers-cache`: clave = lectura + `args`, con la hora). Sin red se pinta lo último con el aviso «Sin conexión · datos de las 18:40». Se borra en `onSessionEnd`.
- **Escrituras solo con red.** Las acciones explícitas (añadir, enviar el enlace, dar de baja) se desactivan sin red. Los campos de la ficha se guardan solos (§13.1): sin red, lo tecleado queda como borrador local por persona y se envía al volver la conexión, con el aviso «Sin conexión · se guardará al recuperar la conexión».
- Sin conflictos que resolver: `VERSION_CONFLICT` recarga y conserva el borrador (§6.3).

## 11. Aceptación

### 11.1 Recorrido

1. El personal genera en Booking el enlace del organizador; el organizador lo abre en Android: entra sin contraseña y el token desaparece de la URL.
2. Con un solo retiro se abre su ficha: fechas, estado, personas previstas.
3. Con la reserva sin confirmar, Asistentes dice «Podrás añadir a tus asistentes cuando la reserva esté confirmada».
4. El personal confirma: el organizador añade a tres asistentes; la primera vez acepta la declaración.
5. Rellena el documento de uno: Booking lo ve con origen «organizador».
6. Envía el enlace de otro por WhatsApp; el huésped lo abre en Guests y completa su documento: el organizador ve «Rellenado ✓» y «Lo abrió el …», sin el valor.
7. El huésped consiente compartir su alergia: aparece con nombre en Cocina; sin consentimiento, solo en los totales.
8. Copia el recordatorio del grupo: sin nombres.
9. Da de baja a uno: desaparece de la lista y su enlace de Guests deja de funcionar.
10. Con una reserva en modo `operativo`, la ficha solo pide nombre, apellido y contacto; en `ninguno` no hay apartado de asistentes.
11. Enlace revocado o caducado: pantalla con el motivo y el contacto.
12. Ayuda y sugerencias: un comentario de «Mi retiro · Limpieza» llega a Ikisai y se ve en «Lo que me has enviado».
13. Sin red: se ven Mis retiros y la última lista de asistentes con el aviso; las acciones están desactivadas; lo que se escribe en la ficha se guarda solo al volver la conexión.

### 11.2 Pruebas automáticas

- `tests/organizers/*.test.ts` (PGlite, como Booking): conformidad de `organizers-api` con `packages/test-kit`; canje del enlace; lecturas y acciones de Booking por `organizers-api` dentro y fuera de ámbito; emisión, lista y revocación de enlaces de huésped; un organizador no emite enlaces de organizador ni de reservas ajenas; un organizador de otra reserva recibe `OUT_OF_SCOPE`.
- Playwright (`tests/organizers/portal.spec.ts`, contra las Edge reales sobre PGlite, como Central): enlace no válido; recorrido 1–9 en móvil con el token fuera de la URL, guardado automático, enlace por WhatsApp, ningún valor del huésped en la página, cocina, recordatorio sin nombres y baja; varios retiros y modo operativo; sin red, con caché y guardado al volver la conexión; ayuda y sugerencias.

## 12. Reparto entre agentes

Lo hago yo entero (es pequeño): `supabase/functions/organizers-api` (índice y conformidad), `apps/organizers`, `tests/organizers`, `docs/organizers`. Con subagente (`sonnet`), solo lo mecánico: escenarios de Playwright a partir de uno aprobado y los textos de las tablas de etiquetas. Orden: (1) Edge y pruebas de conformidad y de ámbito; (2) entrada, Mis retiros y ficha; (3) asistentes, enlaces y recordatorios; (4) cocina, ayuda, «Guarda tu acceso» y offline.

## 13. Fases (PORTALES_V2)

| Fase | Organizers | Dueño de los datos |
|---|---|---|
| **1 · Preparación** (§1–§12, en construcción) | Asistentes, enlaces, completitud, cocina agregada, ficha, ayuda | Booking (hecho), Central (textos) |
| **2 · Diseño desde el interesado** | Fechas posibles en un calendario con los estados libre, en opción y ocupado; personas, orientación del menú, alojamiento, extras, calculadora con el motor de tarifas de Booking y calculadora privada de margen | Booking (el borrador es una reserva «en estudio») |
| **3 · Formalización** | Fecha definitiva, propuesta aceptada, señal, saldo y facturas en solo lectura | Booking, Finance, Tasks (proyecto `AAAAMMDD-`) |
| **4 · Experiencia de Guests** | Qué ve, hace y contrata el huésped (módulos y acciones fijos, con vista previa), programa, materiales propios, preguntas propias, menú de Food con comentarios | Organizers (configuración, materiales, preguntas), Booking (programa), Food (menú) |
| **5 · Decisiones del huésped** | Alojamiento delegable (las habitaciones de 2–4 plazas con baño son un extra que Ikisai factura al organizador), ofertas del organizador y cartel en PDF o JPG | Booking (camas, reserva atómica), Organizers (ofertas) |
| **6 · Pagos en línea** | Señal y saldo a Ikisai en línea | Finance y pasarela |

PORTALES_V2 resuelve los seis puntos que quedaron abiertos en la primera versión de este documento:
- importes y facturas: fases 3 y 6;
- habitaciones: fases 2 y 5;
- programa e información práctica (materiales): fase 4;
- coorganizadores e idiomas: §13.1.

### 13.1 Ajustes de V2 que entran en la fase 1

**Estado (8-10-2026):** hechos el guardado automático, los coorganizadores, los idiomas y la instalación; la cuenta permanente sigue esperando a Workspace.

- **Guardado automático, sin botón «Guardar».**
  - Cada campo de la ficha del asistente se guarda solo al dejar de escribir (800 ms) o al salir del campo, con `portal_update_guest` y la `revision` vigente.
  - La ficha muestra el estado: «Guardando…», «Guardado» o «No se ha guardado · Reintentar».
  - Ante un `VERSION_CONFLICT`, recarga y reintenta una vez con la revisión nueva; solo avisa si el campo ha pasado a ser del huésped.
  - La alimentación se guarda al completar o quitar cada requisito.
  - Siguen siendo acciones explícitas las que crean, borran o comprometen: «Añadir asistente» (crea la fila y pide la declaración), enviar el enlace y dar de baja.
  - Sin red, lo tecleado queda en el borrador local y se envía al volver la conexión, con el aviso «Se guardará al recuperar la conexión». La app no finge haber guardado.
- **Coorganizadores.** Booking emite un enlace por persona y cada una tiene su cuenta. Todas ven lo mismo, y la declaración es por persona (`booking.portal_declarations` ya va por `reservation_id` y `user_id`). La ficha mostrará «Organizáis: Marta y Pablo» cuando Booking lo publique (B11).
- **Idiomas: español e inglés.**
  - Los textos de la interfaz usan `createI18n` del kit (0.19) con la convención del kit: la clave es el propio texto en español (`t('Mis retiros')`) y `apps/organizers/src/app/i18n-en.ts` lo traduce. Una prueba comprueba que no falta ninguno y que se conservan las `{variables}`.
  - Los textos de Central se leen en el idioma del dispositivo, con el español como reserva.
  - El idioma se elige con el selector ES | EN de la cabecera (y de la pantalla de entrada) y se recuerda en el dispositivo; por defecto, el del navegador.
- **Instalación.** Con `createInstallPrompt` del kit (0.20): la hoja «Instala la app» al entrar por enlace (`beforeinstallprompt` en Android y escritorio, instrucciones en iOS) y una tarjeta en Mis retiros. «Ahora no» se recuerda 7 días.
- **Cuenta permanente.** Sigue el hueco de §9.8 hasta que Core la active con Workspace.

### 13.2 Fase 2 · Diseño desde el interesado (a grandes rasgos)

**Principio (decisión del usuario, 7-10-2026): Ikisai fija y el organizador propone.** El organizador nunca fija una fecha ni acepta una propuesta; marca posibilidades, pide y comenta, y el personal decide en Booking.

- La comercial crea el retiro en Booking (una reserva «en estudio») con los datos mínimos que tenga y emite el enlace del organizador. **El borrador del retiro es esa reserva**, no un dato de Organizers, así que el personal ve cada cambio al instante.
- La pantalla de inicio cambia con el estado de la reserva. Con `en_estudio` o `negociacion` muestra **«Diseña tu retiro»**; desde `pre_reservada`, la preparación (fase 1).

**Fechas.** Lo que ve el organizador depende de lo que haya puesto Ikisai:

| Situación en Booking | Organizers muestra | El organizador puede |
|---|---|---|
| **Fecha definitiva** marcada por el personal | La fecha fija, con horas de llegada y salida | Nada sobre las fechas |
| Sin fecha definitiva, con **fechas posibles propuestas por Ikisai** | Esas opciones, cada una con su estado (libre o en opción) | Marcar una o varias como «me vienen bien» |
| Sin fecha definitiva y **sin propuestas** | Calendario con todos los fines de semana: **libre**, **en opción** (alguien tiene una prerreserva, que no bloquea) u **ocupado** (no se puede marcar) | Marcar uno o varios fines de semana disponibles como posibles |

- Lo marcado son **posibilidades, nunca la fecha definitiva**. La pantalla lo dice («Ikisai confirmará la fecha definitiva») y el calendario no revela quién ocupa una fecha.
- Cuando el comercial marca la fecha definitiva en Booking, Organizers la refleja al instante y desaparecen las opciones.
- Se guarda solo, como el resto del diseño. Cada marca avisa al comercial por la cola de Booking, no al instante (B8).
- Fin de semana = de viernes a domingo; las opciones entre semana se ven por día. Lo ocupado incluye los bloqueos internos del personal, sin decir el motivo, y la propia reserva no cuenta en su contra (B6).

**El resto del diseño:**
- Personas previstas, sin nombres; se pueden añadir asistentes desde ya.
- Orientación del menú, con los valores de Booking (`menu_style`).
- Alojamiento, con o sin pernocta; las habitaciones de 2–4 plazas con baño, como extra.
- Extras del catálogo de Booking, con su nombre y descripción públicos (`public_name`, `public_description`), más «Necesito otra cosa» como texto libre. Los extras pedidos van a `booking.reservation_extra_requests` (B10).
- Todo se guarda solo, campo a campo, con las acciones de Booking (B7).

**Calculadora.** Calcula en el dispositivo con el dominio de Booking (`@ikisai/domain-booking`: `suggestLines` y `proposalTotals`, código puro, el mismo que usa el personal). Usa las tarifas visibles, las condiciones y el mínimo que publica `booking.portal_rates({reservation_id})` (B9), con la fecha definitiva o la opción que elija el organizador. No hay cálculo en SQL:
- Precios con el **IVA incluido** y desglosado.
- Noches = salida − llegada. Cada noche incluye dos comidas por persona; las extra van aparte.
- **Mínimo comercial** en los ajustes de Booking.
- Sin tarifas cargadas, muestra «Ikisai te enviará el precio».

**Calculadora privada de margen.** Calcula ingresos, margen y punto de equilibrio solo en el dispositivo, nunca en el servidor, y se borra al cerrar la sesión.

### 13.3 Fase 3 · Formalización (a grandes rasgos)

- **Fecha definitiva:** la que marca el personal en Booking (§13.2).
- **Propuesta (decisión del usuario, 7-10-2026):** el organizador **no la acepta** desde el portal.
  - Ve la propuesta enviada, con sus líneas, condiciones, tramos de cancelación y validez.
  - Puede pulsar **«Quiero confirmar»** o **enviar comentarios**. Las dos cosas avisan al comercial y quedan en la ficha con su estado (enviado, visto, respondido).
  - La aceptación la hace el personal en Booking: fija importe y señal, y queda registrado quién la aceptó.
- **Dinero de Ikisai, en solo lectura** (Finance): total contratado, señal requerida y pagada, saldo, vencimientos, facturas en PDF e instrucciones de pago (transferencia, Bizum, efectivo; tarjeta cuando haya pasarela). Ningún dato de tarjeta pasa por Organizers.
- **Al confirmar,** Booking pide a Tasks el proyecto `AAAAMMDD-<título>` (idempotente; se renombra si cambian la fecha o el título) y las tareas de los extras contratados. Organizers no habla con Tasks.

### 13.4 Fases 4 y 5 · Datos propios de Organizers (borrador del modelo)

Lo que sí es del organizador vive en el schema `organizers` (migraciones `0700–0799`), en tablas sincronizables con ámbito por reserva (`visible()` por `reservation_id`). Es un borrador: el modelo exacto irá en el G2 de cada fase.

```text
organizers.guest_experience   una por reserva: módulos visibles (programa, alojamiento, menú, mapa, información práctica,
                              materiales, actividades, extras, comentarios) y acción permitida en cada módulo
                              (ver | preferencia | solicitar | elegir | reservar | apuntarse | responder)
organizers.questions          preguntas propias: tipo (texto, opción, sí/no, número, fecha), opciones, obligatoria,
                              ventana (desde/hasta), posición
organizers.answers            respuestas de cada huésped; las escribe Guests con una acción de Organizers
organizers.materials          logo, PDF, imágenes, enlaces y textos; privado o publicado, y cuándo (antes, durante,
                              después); el archivo va en core.files, declarado con core.register_file_field
organizers.offers             ofertas del organizador a sus asistentes: nombre, descripción, precio, qué incluye,
                              límite, periodo, compatibilidad, recurso de Booking vinculado, visibilidad, formas de pago
                              e instrucciones; son informativas, sin cobro de Ikisai
organizers.offer_payments     estado de pago que marca el organizador por asistente y oferta (pendiente, pagado, devuelto)
```

- **Cartel** (PDF o JPG con el logotipo, los precios, los días, el lugar y una imagen de fondo): se genera en el dispositivo con los datos de `offers` y `materials`, sin servidor.
- **Programa:** es de Booking (con su petición en esa fase). Organizers lo edita con acciones de Booking y Guests lo lee de Booking.

### 13.5 Contrato con Guests (propuesta para el agente de Guests)

- **Lecturas de Guests en Organizers**, registradas para `guests` y filtradas por el ámbito del huésped (`{reservation_id, guest_id}`):
  - `organizers.guest_experience_for(p)`: módulos y acciones;
  - `organizers.guest_questions(p)`: preguntas vigentes y sus respuestas;
  - `organizers.guest_materials(p)`: materiales publicados para la fase actual, con URL firmada por `files`;
  - `organizers.guest_offers(p)`: ofertas visibles, sin coste interno ni margen.
- **Única escritura de Guests en Organizers:** la acción `organizers.guest_answer(p)`, con procedencia «huésped».
- **Lo de Ikisai no se configura.** Lo legal y operativo (datos de registro, alergias, firma) no depende del organizador y sigue en Booking §16.
- **Vista previa.** Organizers pinta la experiencia de Guests con esas mismas lecturas sobre un huésped ficticio, sin datos reales.

## 14. Peticiones

Estado de cada una en `docs/organizers/PETICIONES.md`.

### A Booking (por Core)

- **B1 · Detalle de la reserva para la ficha.** `booking.portal_reservations` (o una `booking.portal_reservation {reservation_id}`) con: `arrival_time`, `departure_time`, `final_guests`, `minors_count`, régimen (`meal_plan_confirmed` o, si no, el pedido), estilo de menú (ídem), `uses_accommodation`, `requires_meals`, `uses_interpretation_center`, `uses_outdoors`, `uses_pool`. Nada de importes ni notas internas.
- **B2 · `declared: boolean`** en `booking.portal_guests`: si el actor ya hizo la declaración en esa reserva, para pedirla antes de escribir y no tras un `DECLARATION_REQUIRED`.
- **B3 · Alta idempotente.** Si `portal_add_guest` recibe un `guest_id` que ya existe en esa reserva y lo creó el mismo actor, devolver éxito en vez de error de clave duplicada (un reintento tras perder la respuesta por falta de cobertura).
- **B4 · (Opcional, no V1)** restricciones de cocina del grupo sin huésped (`guest_id` nulo, con raciones) para reservas en modo `ninguno`, donde hoy el organizador no puede indicar nada.

### A Core

- **C1 · Canje en `sync-client`.** Un `client.loginWithLink(token)` que llame a `auth/link`, guarde la sesión como `login()` y dispare `onSessionEnd` si había otra persona, para que la PWA no maneje tokens a mano.
- **C2 · Reenviar un enlace de huésped sin duplicar cuentas.** Hoy `portal-links` sin correo crea una cuenta interna nueva en cada emisión; al reenviar, el huésped tendría dos cuentas y la antigua seguiría con permiso aunque se revoque su enlace. Propuesta: si ya hay un enlace con el mismo `scope.guest_id`, reutilizar su `user_id`; y una opción `replace: true` que revoque en la misma transacción los enlaces anteriores de ese ámbito.
- **C3 · Indicador de la cuenta permanente** (p. ej. `GET auth/config → {portalAccount: false}`) para mostrar u ocultar «Guarda tu acceso» sin publicar una versión nueva.
- **C4 · (UI) entrada de ayuda del lanzador configurable en portales:** etiqueta «Ayuda y sugerencias» y su descripción, y el paso `signal` del formulario por pasos sin el interruptor «Señalar para comentar» (activar el gesto solo para ese paso).
- **C5 · Alta de infraestructura** cuando abra la PR con `apps/organizers`: `scripts/apps.py`, Pages, `organizers.ikisai.com` y la redirección de `organiza.ikisai.com`.
