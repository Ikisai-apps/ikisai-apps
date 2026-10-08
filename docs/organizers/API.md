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

**Estado (8-10-2026):** las fechas están construidas sobre Booking B6–B8 (#303). Pestaña «Fechas» de la ficha mientras el retiro está en estudio, negociación o prerreserva, con los tres modos de abajo, guardado automático y tarjeta en el resumen. Un fin de semana es de viernes a domingo; se ofrecen los próximos doce meses y como mucho 20 marcas. El resto de la fase está construido sobre la segunda parte de Booking (#305: B7d, B9, B10 y B12):
- **Pestaña «Diseño»** (en estudio o negociación; si no, `DRAFT_LOCKED`):
  - personas y menores, comidas (régimen y orientación del menú), alojamiento y espacios;
  - extras visibles en el portal, con su cantidad;
  - «¿Necesitas otra cosa?» (`organizer_notes`).

  Todo se guarda solo con `portal_update_draft`.
- **Precio orientativo:** en el dispositivo (`app/quote.ts`), con `suggestLines`, `proposalTotals` y `applyMinimum` del dominio de Booking sobre `portal_rates`.
  - Fechas del cálculo: la definitiva o una de las posibles, a elegir.
  - Muestra noches y comidas incluidas, líneas, total con IVA incluido y su desglose, señal y aviso de mínimo aplicado.
  - La señal se calcula sobre lo que se paga.
  - Sin tarifas: «Ikisai te enviará el precio».
  - Calcula con el tipo de reserva real (`event_type`, B14), y con el montaje especial y el apoyo técnico si se piden.
- **Calculadora privada:** precio por asistente, asistentes y otros gastos dan ingresos, gastos, margen y punto de equilibrio. Se guarda solo en el dispositivo (caché por persona; se borra al cerrar la sesión).
- **Pestaña «Propuesta»** (cualquier retiro no cancelado): propuestas enviadas o aceptadas con líneas, totales, señal, validez, condiciones y tramos de cancelación (§13.3), con «Quiero confirmar» y «Enviar un comentario». Debajo, «Lo que has enviado a Ikisai», con su estado.
- La pestaña «Cocina» aparece solo con la reserva confirmada. En el móvil, las pestañas se desplazan y la activa queda centrada.

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

**Estado (8-10-2026):** pestaña «Pagos» (desde la prerreserva, retiro no cancelado) sobre Finance F1 y F2 (#307) y el texto `payment.instructions` de Central (#308):
- **Resumen de Finance:** facturado, cobrado y pendiente. Lo pagado sale solo de Finance.
- **Facturas del retiro:** número, fecha, total y si están cobradas.
  - La emitida desde Finance se pinta desde su copia congelada con la página imprimible del kit (imprimir o guardar en PDF), tal como se emitió y en español.
  - La registrada de otra herramienta (solo PDF guardado) muestra «Pídenosla», con el contacto público, hasta que exista la ruta firmada `portal-files`.
- **«Cómo pagar»:** el texto de Central en el idioma elegido.
- **Lo contratado** (Booking, `portal_reservation_detail.contract`, #312): total de la propuesta aceptada, lo pagado (lo cobrado según Finance), el **saldo pendiente** (contratado − cobrado, nunca negativo) y la forma de pago acordada.
  - Vencimientos de la señal y del saldo, con fecha e importe tal como llegan en `due`; el plazo del saldo es interno de Ikisai y no se muestra (aclaración del usuario del 8-10-2026): el saldo sale solo como importe pendiente; cada uno sale «Pagado» si lo cobrado cubre lo acumulado hasta él.
  - Sin propuesta aceptada, un aviso de que aparecerá al cerrarla.
  - Cálculo puro en `app/quote.ts` (`balanceOf`), probado.

- **Fecha definitiva:** la que marca el personal en Booking (§13.2).
- **Propuesta (decisión del usuario, 7-10-2026):** el organizador **no la acepta** desde el portal.
  - Ve la propuesta enviada, con sus líneas, condiciones, tramos de cancelación y validez.
  - Puede pulsar **«Quiero confirmar»** o **enviar comentarios**. Las dos cosas avisan al comercial y quedan en la ficha con su estado (enviado, visto, respondido).
  - La aceptación la hace el personal en Booking: fija importe y señal, y queda registrado quién la aceptó.
- **Dinero de Ikisai, en solo lectura** (Finance): total contratado, señal requerida y pagada, saldo, vencimientos, facturas en PDF e instrucciones de pago (transferencia, Bizum, efectivo; tarjeta cuando haya pasarela). Ningún dato de tarjeta pasa por Organizers.
- **Al confirmar,** Booking pide a Tasks el proyecto `AAAAMMDD-<título>` (idempotente; se renombra si cambian la fecha o el título) y las tareas de los extras contratados. Organizers no habla con Tasks.

### 13.4 Fases 4 y 5

Su G2 detallado está en §15 (experiencia de Guests) y §16 (decisiones del huésped). El borrador que había aquí queda sustituido. Cambios respecto a él:
- las ofertas no se muestran en Guests y desaparece `organizers.offer_payments`;
- el contrato con Guests queda en tres lecturas, más la de archivos para O1, y una escritura.

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

## 15. Fase 4 · Experiencia de Guests (G2, propuesta para Core)

Qué ve, hace y contrata el huésped en Guests, decidido por el organizador. Son **módulos y acciones fijos**, no un editor libre, con vista previa. Lo que es de otra app sigue siendo suyo:
- **el programa**, de Booking;
- **el menú**, de Food;
- **lo legal y operativo de Ikisai** (datos de registro, firma, alimentación y aviso legal), que no se puede desactivar.

Organizers guarda solo lo suyo:
- la configuración de la experiencia;
- sus materiales;
- sus preguntas, y las respuestas a ellas.

### 15.1 Datos propios (schema `organizers`, migración `20261008_0700`) · construido

Son las primeras tablas sincronizables de Organizers (contrato §2), en el espejo de `sync-client`: se editan sin red y la cola las envía al volver. Los códigos son los que lee Guests (`docs/guests/API.md` §13).

```text
organizers.experiences      una por reserva (única con deleted_at null)
  reservation_id, program_visible, program_window, menu_visible, menu_window, materials_visible, questions_visible,
  lodging_visible, lodging_capability (view | prefer | choose | request), lodging_choose_until,
  lodging_options [{key, label, guest_note}] (≤ 12), map_visible, organizer_message (≤ 1000), message_lang (es | en)
  window = before | during | after | always

organizers.materials        reservation_id, owner_id, kind (file | link | text), title (1–160), description, file_id → core.files,
                            url (solo https), body (≤ 4000), is_logo (uno por reserva), published, window, position
organizers.questions        reservation_id, owner_id, type (text | choice | multi | yes_no | number | date), label (1–300), help,
                            options [{value, label}] (2–12 en choice y multi), required, opens_at, closes_at, published, position
organizers.answers          reservation_id, question_id, guest_id, value jsonb; única por (question_id, guest_id)
organizers.offers           §16.2
```

- **Visibilidad (`visible` en `organizers-api`):** una fila se ve si su `reservation_id` está en `scopes.grants`. Además, los materiales y las preguntas se ven siempre a quien los creó (`owner_id`): son su **biblioteca** y se copian a sus próximos retiros («De otros retiros»), por decisión del usuario del 8-10-2026.
- **Escrituras del organizador:** `core.commit`, con la validación compartida `_domain/organizers` en el dispositivo y en `beforeCommit`. El gancho `organizers.validate_batch` lo comprueba también en la base de datos, sobre las filas del lote:
  - la reserva está en su ámbito y `reservation_id` no cambia;
  - `owner_id` es quien da el alta y no cambia;
  - no escribe respuestas.
- **Escrituras del huésped:** solo `organizers.guest_answer` (§15.4). El gancho exige su ámbito de Guests `{reservation_id, guest_id}` y una pregunta de esa reserva.
- **Archivos:** bucket `organizers-materials` (K5) con `uploads`: PDF ≤ 15 MB e imágenes PNG, JPG o WebP recomprimidas en el dispositivo; **sin SVG**. `register_file_field(…, 'materials', 'file_id', 'operational')` y `enable_file_gc('organizers')`. El organizador abre sus archivos con `files/:id` (K3).
- **Conservación (decisión del usuario):**
  - el logotipo, los materiales y las preguntas se conservan para sus próximos retiros;
  - **las respuestas se borran a los 6 meses del fin del retiro** (migración `0701`):
    - el fin lo da `booking.reservation_end_dates` (B18, #335);
    - el tick diario `worker/retention/tick` (sonda `organizers.retention_has_work`) vacía el valor y borra cada respuesta vencida en un lote del sistema (`apply_system_operations`), para que también desaparezca de los dispositivos;
    - una reserva borrada, cancelada o perdida sin fecha de fin caduca ya;
    - necesita la cuenta de servicio `organizers` en el núcleo (K7).

### 15.2 Módulos y capacidades de la V1

| Módulo | Dueño del dato | Capacidades | En Organizers |
|---|---|---|---|
| Programa | Booking (B16) | ver | El organizador lo edita (día, inicio, fin, título, espacio, nota pública), con guardado automático |
| Menú | Food (Fd2, Fd3) | ver | Ve la propuesta de Food con la marca «provisional» y deja comentarios o «prefiero que no» por plato; no edita recetas |
| Materiales | Organizers | ver | Sube archivos, enlaces y textos; elige qué publica y cuándo |
| Preguntas | Organizers | responder | Crea preguntas (texto, opción, varias, sí/no, número, fecha) y ve las respuestas con el nombre visible de cada asistente |
| Alojamiento | Booking (B17) | ver · preferencia · elegir | Fase 5 (§16.1) |
| Información práctica | Central (texto común) y materiales | ver | Elige si se ve; el texto es de Ikisai |
| Comentarios del retiro | Núcleo (feedback, destino `organizer`) | — | Bandeja de los comentarios de sus huéspedes (pendiente de la fase posterior del feedback) |

Lo obligatorio de Ikisai (datos del registro, firma, alimentación y aviso legal) no aparece en esta tabla: Guests lo muestra siempre.

### 15.3 Pantallas (pestaña «Experiencia» del retiro) · construido

Desde la prerreserva, con seis apartados en una tira desplazable. Se recuerda el último abierto en la sesión.

- **Qué ven:**
  - los módulos con su interruptor y, en programa y menú, la ventana;
  - el mensaje de bienvenida y su idioma;
  - **«Ver como un asistente»** (O6): `booking.portal_preview_guest` y un enlace de Guests con `preview: true` y `replace: true`, abierto en otra pestaña. Guests rechaza las escrituras con `PREVIEW_READ_ONLY`.
- **Programa** (Booking #328): por días del retiro, con hora de inicio y fin, espacio de Ikisai u otro lugar, nota para los asistentes y nota interna. Se guarda con `portal_program_save`, se quita con `portal_program_remove` y se ordena con `portal_program_reorder`.
- **Menú** (Food #327 y #332):
  - solo cuando cocina lo comparte, con «Provisional» o «Confirmado» y el aviso `portal.menu_note` de Central;
  - por plato, la miniatura (`portal-files`), «Prefiero que no» y «Comentar», más un comentario general;
  - cada comentario muestra su estado y la respuesta de cocina (`portal_my_menu_comments`).
- **Alojamiento** (Booking #328):
  - «Qué pueden hacer»: se guarda en la experiencia (lo que lee Guests) y en `portal_room_settings`. La correspondencia es `view` → `off`; `prefer` → `off` con preferencias; `choose` y `request` → igual, con preferencias;
  - tipos de habitación con la nota de precio para el huésped (`lodging_options`), y las habitaciones con baño que se pueden elegir, con su tipo (`option_key`);
  - reparto de camas (`portal_assign_bed`), plazas pendientes de aprobar (`portal_approve_bed`) y preferencias de compañeros.
- **Materiales:** archivos, enlaces y textos, con «Publicado», la ventana, el logotipo y «De otros retiros».
- **Preguntas:** seis tipos, aviso de datos sensibles (O7), respuestas con el `display_name` de cada asistente y CSV.

El **cartel** («Ofertas») toma el lugar de `central.portal_place_projection` (nombre y dirección del lugar, nunca el domicilio fiscal).

### 15.4 Contrato con Guests (cruzado con `docs/guests/API.md` §13)

Lecturas de Organizers registradas para `guests` (`core.allow_read('guests', 'organizers.…', 'function', '{editor,owner}')`), filtradas por `{reservation_id, guest_id}` del ámbito del huésped:
- `organizers.guest_experience_for(p)`: módulos visibles en la ventana actual, con su capacidad, sus `params` públicos y su orden;
- `organizers.guest_questions(p)`: preguntas publicadas y abiertas, con la respuesta propia;
- `organizers.guest_materials(p)`: materiales publicados en la ventana actual (título, tipo, descripción, enlace o texto, y `file_id` sin URL);
- `organizers.guest_material_file(p)` `{file_id}`: devuelve la fila de `core.files` solo si ese archivo es de un material publicado y en ventana del retiro del huésped. **Respuesta a O1:** de acuerdo con la propuesta de Guests. `guests-api` sirve `GET materials/:fileId`, llama a esta lectura y firma con `createStorage`.

Escritura:
- `organizers.guest_answer(p)` `{question_id, value}`: valida el tipo y la ventana, y escribe la respuesta propia con procedencia «huésped» mediante un lote de Organizers. Necesita que el núcleo admita que una acción de Organizers invocada desde el portal Guests escriba en `organizers.*` (K4).

**Construido** (migración `0700`, pruebas en `tests/organizers/experience.test.ts`):
- las tres lecturas y la acción, con las formas de Guests §13.1, §13.5 y §13.6;
- el resolutor, registrado con `core.allow_portal_file('guests', 'organizers.guest_material_file')` (C8). Guests abre el archivo con `GET portal-files/:fileId`;
- **ventanas:** las fechas son de Booking. Organizers devuelve `window` en cada módulo y material, y Guests filtra con las fechas de la reserva. El resolutor exige el material publicado, el módulo visible y la reserva del huésped;
- `guest_answer` escribe con `core.apply_portal_operations('organizers', …)` desde Guests (K6, #334). Devuelve `{revision}` y los errores `QUESTION_CLOSED`, `INVALID_ANSWER`, `VERSION_CONFLICT` y `OUT_OF_SCOPE`; con `value: null` borra la respuesta. El huésped de muestra recibe `PREVIEW_READ_ONLY`.

**Sin `organizers.guest_offers`:** las ofertas no se muestran en Guests (decisión del usuario, confirmada por Core). Los nombres de los asistentes en las respuestas los toma el organizador de `booking.portal_guests`; Organizers no los copia.

## 16. Fase 5 · Decisiones del huésped (G2, propuesta para Core)

### 16.1 Alojamiento delegable

El inventario, la disponibilidad y las asignaciones son de **Booking**: Organizers no copia nada y solo configura qué se delega. Ajustes del módulo `alojamiento` (`params`):

```text
mode              asigna_organizador | preferencia | elegir
rooms_open        [space_id]          habitaciones que el huésped puede elegir (con `elegir`)
supplement_rooms  [space_id]          habitaciones con suplemento (las de 2–4 plazas con baño)
supplement_payer  organizador | huesped | aprobacion
guest_price_text  text null           lo que verá el huésped, p. ej. «+60 € a pagar a tu organizador» (nunca el coste de Ikisai)
```

- **Con `asigna_organizador`:** el organizador reparte camas en una vista por habitaciones de Booking (B17: lectura del inventario del evento y acción de asignar).
- **Con `preferencia`:** el huésped indica con quién le gustaría compartir (lo guarda Booking como nota de asignación) y el organizador lo ve al repartir.
- **Con `elegir`:** el huésped reserva una plaza de las habitaciones abiertas con `booking.portal_choose_bed`, que es atómica, de Booking y la pide Guests. Si la habitación lleva suplemento:
  - con `organizador`, el suplemento lo asume él;
  - con `huesped`, se lo paga el huésped al organizador;
  - con `aprobacion`, la plaza queda pendiente hasta que el organizador la apruebe.

  En todos los casos **Ikisai factura el suplemento al organizador**, como un extra de su reserva (decisión del usuario).
- **Dónde vive la configuración:** la que necesita la reserva atómica (habitaciones abiertas, con suplemento y modo de aprobación) tiene que vivir en **Booking**, porque su acción no puede leer `organizers.*`. Propuesta B17: `booking.portal_room_settings`, que escribe el organizador con una acción de portal. En `params` de Organizers queda solo lo de presentación (`guest_price_text`).

### 16.2 Ofertas del organizador a sus asistentes

Solo para el organizador: le sirven para sus cálculos y para el cartel. **Nunca en Guests y sin cobro de Ikisai.**

```text
organizers.offers
  reservation_id   uuid
  name             text   (1–120)      «Estándar», «Habitación doble con baño», «Early bird»…
  description      text   null (≤ 600)
  price            numeric(10,2)        precio para el asistente (lo fija el organizador; no se deriva del coste de Ikisai)
  includes         text   null (≤ 600)
  capacity         integer null          plazas de esa opción
  expected         integer null          cuántas espera vender (para la calculadora de margen)
  available_from   date   null
  available_until  date   null
  on_poster        boolean              sale en el cartel
  position         numeric
```

La calculadora privada de margen (§13.2) pasa a sumar los ingresos por oferta (precio × esperados) cuando las hay. Sigue sin guardarse nada del margen en el servidor; las ofertas sí se guardan, porque son datos del organizador.

### 16.3 Cartel en PDF o JPG

Se genera **en el dispositivo**, sin servidor:
- **Contenido:** título del retiro, fechas, lugar (Ikisai, con la dirección de Central), las ofertas marcadas con su precio, el logotipo y una imagen de fondo elegida entre sus materiales.
- **Formatos:** vertical A4, para imprimir o guardar en PDF con la página imprimible del kit, y cuadrado o vertical para redes en JPG, con `canvas.toBlob`.
- **Diseño:** dos o tres plantillas fijas, con contraste comprobado sobre la imagen y tipografía del kit. No es un editor libre.

### 16.4 Lo que se reutiliza de Booking

- **Habitaciones de 2–4 plazas con baño:** ya son un extra en las tarifas (`portal_visible`, B10).
- **Suplemento:** al elegir con suplemento, Booking añade la línea al pedido de extras de la reserva o a la propuesta. Lo decide Booking, que factura Finance.
