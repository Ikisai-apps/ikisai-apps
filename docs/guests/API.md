# Ikisai Guests · API y pantallas (puerta G2: fase 1 construida; fases 4 y 5 en diseño)

Portal externo de los huéspedes de los retiros: `guests.ikisai.com` (alias `ven.ikisai.com`, redirige). Diseño de producto en `coordinacion/ampliacion/PORTALES_V2.md` (aprobado por el usuario el 7-10-2026; manda sobre lo anterior), `PORTALES.md`, `FEEDBACK.md` (§4 y la especificación §3.2 y §4) y `USO.md`. Núcleo en el contrato §3.3 a §3.9. Datos en `docs/booking/API.md` §16 y §17.1. Pareja: `docs/organizers/API.md`. Sigue la plantilla `docs/core/PLANTILLA_API_APP.md`.

**Alcance de esta tanda:** la **fase 1 · preparación** de `PORTALES_V2.md` §4, en detalle (§1 a §12):
- entrada por enlace y aviso de protección de datos;
- Inicio con lo que falta;
- «Mis datos» según el modo de la reserva, con la procedencia de cada campo;
- alimentación con el interruptor de consentimiento;
- firma del parte;
- información práctica de Ikisai;
- «Ayuda y sugerencias»;
- el hueco de «Guarda tu acceso».

Las fases 4 y 5 (experiencia configurable, programa, menú, materiales, preguntas y elección de habitación) están diseñadas en el §13 (8-10-2026), con sus peticiones al final del §14.

## 1. Dominio y límites

Guests es el sitio donde una persona **vive su estancia en Ikisai**, desde que recibe el enlace hasta después del retiro. En la fase 1 cubre lo que hay que hacer antes de llegar y lo que conviene tener a mano: datos, alimentación, firma, información práctica y ayuda.

| Hace | Lee o escribe en otra app | No hace (fase 1) |
|---|---|---|
| Entrada por enlace, aviso legal, Inicio con lo pendiente, sus datos con autoguardado, alimentación y consentimiento, firma del parte, información práctica, ayuda y sugerencias, idioma español o inglés | **Booking** es dueña del huésped, sus restricciones, su consentimiento y su firma: lectura `booking.portal_my_guest` y acciones `booking.portal_guest_*` y `portal_set_restrictions` (§16.6). **Central**: textos legales, de contacto e información práctica (`central.common_texts_projection`). **Núcleo**: canje del enlace, subidas al bucket `guests-documents`, catálogo, feedback y uso | Programa, menú, materiales, preguntas del organizador, habitaciones, ofertas y pagos (§13); ver datos de otros huéspedes; enviar correos o mensajes desde el servidor; fotografiar o guardar documentos de identidad |

**Guests no guarda copias de datos de Booking, Food ni Finance.** No tiene tablas propias en la fase 1: lee las proyecciones filtradas por su ámbito y escribe con acciones de Booking. Si más adelante necesita algo propio (por ejemplo, la elección de habitación como intención antes de confirmarse), irá en el schema `guests` (migraciones `0600–0699`). Hoy no lo prevé (§13).

**Público:** personas de fuera, muchas veces en su primera visita, en el móvil y con poca paciencia para formularios. Por eso:
- textos claros y en segunda persona («tus datos», «tu retiro»);
- sin jerga: nunca «SES», «ámbito», «revisión» ni «sincronizar»;
- un paso por pantalla y botones grandes;
- **español e inglés desde el primer día** (§9.10).

## 2. Tablas sincronizables (`guests.*`)

Ninguna en la fase 1. La única migración, `20261007_0600_guests_file_gc.sql`, activa la recogida de huérfanos de sus archivos (§8).

## 3. Procedimientos (`call`)

Ninguno propio. Las escrituras son acciones de Booking invocadas con `POST /api/v1/invoke/<acción>` (§6.2).

## 4. Hooks de validación

Ninguno en la Edge. Las validaciones están en las acciones de Booking: ámbito, modo de datos, campos permitidos y archivo de firma verificado y propio.

El cliente valida antes de enviar con el mismo dominio de Booking, que importa de `packages/domain-booking` (solo lectura del código ajeno, sin copiarlo):
- `PORTAL_GUEST_FIELDS` y `OPERATIVE_GUEST_FIELDS`;
- `guestMissing`;
- `signsOwnEntry` y `OWN_SIGNATURE_MIN_AGE`.

Así el aviso sale en el formulario y no tras el viaje al servidor.

## 5. Visibilidad

**Ámbito por huésped.** La pertenencia `editor` de la cuenta al portal lleva `scopes.grants = [{reservation_id, guest_id}, …]`. Lo comprueban las funciones de Booking en cada llamada (`booking.portal_in_scope` exige el `guest_id` en Guests). Fuera de ámbito o inexistente: `403 OUT_OF_SCOPE`. `GET members` solo devuelve al propio miembro (contrato §3.6).

**Varias entradas de ámbito en una misma cuenta.** Con la reutilización de cuentas de la PR #278 (mismo correo o mismo `guest_id`), una cuenta puede acumular varias entradas: la misma persona en dos retiros, o una madre que rellena también los datos de su hijo con su propio correo. Guests lo contempla desde el principio:
- con una sola entrada abre directamente su retiro;
- con varias, Guests las agrupa por retiro y por persona (O4a, §9.12): pestañas de retiros, selector «Todos · Marta · Nico» y calendario. Hasta que Booking publique una clave de persona (O2), la misma persona en dos retiros se reconoce por su nombre y primer apellido.

Cada entrada solo enseña su propia ficha.

**Lo que ve el huésped** (Booking §16.3): todos sus datos, sean de quien sean; de qué fuente viene cada campo (§9.3); sus restricciones (también las que escribió su organizador); su consentimiento; si ha firmado. **Nunca** ve a otros huéspedes, el estado SES, las notas internas, importes ni recibos.

## 6. Rutas

### 6.1 Edge `guests-api`

```ts
createApp({
  app: 'guests', slug: 'guests-api',
  origins: ['https://guests.ikisai.com', 'https://ven.ikisai.com', <local>],
  uploads: { bucket: 'guests-documents', allowedMime: ['image/png', 'image/webp'], maxBytes: 300_000 },
})
```

**Una ruta propia, `GET plans`** (20-10-2026, MUELA-024): el mapa de zonas de Recursos (`resources.portal_plans`) con cada dibujo firmado aquí con `createStorage(...).readUrl` (10 minutos), su `fileId`, `mime` y `sha256`; nunca bucket ni ruta, ni personas. Lo demás lo monta el kit. Sin `portalIssuer`, porque un huésped no emite enlaces, y sin `workerKey`, porque no tiene trabajos programados.

**Archivos solo de quien los subió.** En los portales, el kit solo deja leer (`GET files/:id`) y verificar (`uploads/:id/verify`) un archivo a quien lo subió: la firma de un huésped no la ve otro aunque conozca el id (C7, #288). Guests no vuelve a leer sus archivos.

| Ruta (prefijo `/api/v1/`) | Uso en Guests |
|---|---|
| `POST auth/link {token}` | canje del enlace (`client.loginWithLink(token)`, `sync-client` 0.5): sesión y pase de la sesión única. Errores: `401 LINK_INVALID` y `401 LINK_EXPIRED {validUntil}` |
| `POST auth/sso`, `refresh`, `logout` | los gestiona `sync-client` |
| `GET auth/config` | `permanentAccount`: muestra u oculta «Guarda tu acceso» (#278) |
| `GET me` | nombre de la cuenta y `scopes.grants` (de ahí salen el `guest_id` y la `reservation_id` de cada entrada) |
| `GET apps` | lanzador del kit |
| `GET read/booking.portal_my_guest?guest_id=` | ficha completa del huésped (§6.2) |
| `GET read/central.common_texts_projection?limit=200` | textos legales, de contacto e información práctica (§9.7). Si la petición CE1 de §14 sale adelante, se filtra además por idioma |
| `GET read/central.text_version?key=&version=` | texto exacto de una versión ya aceptada (el aviso que vio) |
| `POST invoke/booking.portal_guest_update` · `portal_guest_consent` · `portal_set_restrictions` · `portal_guest_sign` | escrituras (§6.2) |
| `POST uploads` · `uploads/:id/verify` | imagen de la firma al bucket privado `guests-documents` |
| `POST feedback`, `feedback/uploads` (+ `verify`), `GET feedback?mine=true` | «Ayuda y sugerencias» |
| `POST usage/batch` | uso sin persona (`createUsage({ notice: false })`) |
| `GET plans` | el mapa de zonas: `{plans: [{id, buildingId, floor, position, width, height, fileId, mime, sha256, url}], spaces: [{id, parentId, kind, name, planId, planShape, position}]}` (§9.16) |

### 6.2 Lecturas y acciones de Booking (lo que ya existe en `main`)

Todas responden `403 OUT_OF_SCOPE` fuera de ámbito.

| Nombre | `args` | Devuelve / hace | Errores que la interfaz traduce |
|---|---|---|---|
| `booking.portal_my_guest` | `guest_id` | `{id, revision, fields{campo: valor}, mode, missing[], signed, allergies_visible_to_organizer, privacy_ack_at, privacy_ack_version, reservation{title, start_date, end_date, status, arrival_time, departure_time}, sources{campo: guest\|organizer\|staff}, diet_reviewed_at, signature_text_version, restrictions[{id, restriction_type, subject, severity, kitchen_notes, source}]}` | — |
| `booking.portal_guest_update` | `guest_id, expectedRevision, fields` | completa o corrige sus datos (procedencia «huésped»); en modo `operativo` solo admite nombre, primer apellido, teléfono y correo | `VERSION_CONFLICT`, `GUEST_DATA_OFF`, `INVALID_OPERATION` |
| `booking.portal_guest_consent` | `guest_id, expectedRevision, allergies_visible_to_organizer?, privacy_ack_version?` | interruptor de alergias y acuse del aviso legal (con la hora del servidor) | `VERSION_CONFLICT` |
| `booking.portal_set_restrictions` | `guest_id, items: [{restriction_type, subject?, severity?, kitchen_notes?}]` (≤ 30) | **sustituye todas** sus restricciones, también las que había escrito el organizador | `INVALID_OPERATION`, `CONSTRAINT_VIOLATION` (falta el «qué» o la gravedad no corresponde) |
| `booking.portal_guest_sign` | `guest_id, expectedRevision, file_id, signed_by_name, text_version` | firma: `signature_file_id`, `signed_at`, `signed_by_name` y `signature_text_version` (versión de `guests.signature_statement`); solo en modo `ses` y con un archivo verificado subido por esa misma cuenta | `GUEST_DATA_OFF`, `INVALID_OPERATION`, `INVALID_FIELDS` |

Las cuatro acciones responden `{guest_id, revision, cursor}`, y `portal_guest_update` añade `signature_reset: true` cuando el cambio invalida la firma (Booking §16.8, BG1–BG6). `portal_set_restrictions` marca `diet_reviewed_at` también con la lista vacía.

### 6.3 Mensajes de error para el huésped (ES · EN)

| Código | Español | English |
|---|---|---|
| `LINK_INVALID` | «Este enlace no es válido o ya no está activo. Pídele uno nuevo a quien te lo envió.» | «This link is not valid or no longer active. Ask whoever sent it for a new one.» |
| `LINK_EXPIRED` | «Este enlace caducó el {fecha}. Si tu retiro sigue en marcha, pide uno nuevo a tu organizador.» | «This link expired on {date}. If your retreat is still on, ask your organiser for a new one.» |
| `VERSION_CONFLICT` | «Alguien ha cambiado este dato mientras lo editabas. Te enseñamos el último; el tuyo sigue aquí por si quieres volver a ponerlo.» | «Someone changed this while you were editing. Here is the latest; yours is kept in case you want it back.» |
| `GUEST_DATA_OFF` | (no se ofrece el apartado; si llega: «En este retiro no hace falta este dato.») | «This retreat doesn't need this information.» |
| `OUT_OF_SCOPE` / `NO_MEMBERSHIP` | «Ya no tienes acceso a este retiro. Si crees que es un error, habla con tu organizador.» | «You no longer have access to this retreat. If you think this is a mistake, contact your organiser.» |
| `INVALID_OPERATION` (firma) | «No hemos podido guardar tu firma. Vuelve a intentarlo.» | «We couldn't save your signature. Please try again.» |
| `CONSTRAINT_VIOLATION` (restricciones) | «Indica a qué eres alérgico o intolerante.» | «Tell us what you are allergic or intolerant to.» |
| red / `BACKEND_UNAVAILABLE` | «Sin conexión. Lo guardaremos en cuanto vuelvas a tener red.» | «You're offline. We'll save it as soon as you're back online.» |

Las pantallas de enlace no válido y caducado añaden el **correo y el teléfono de Ikisai de Central** (§9.1 y petición C1).

## 7. Proyecciones y enlaces

Guests no publica proyecciones. Consume:
- la lectura de Booking del §6.2, registrada con `core.allow_read('guests', …)`;
- `central.common_texts_projection` y `central.text_version`, legibles desde `guests` (PR #281).

Los enlaces de huésped los emiten Organizers (sus asistentes) y Booking (casos sueltos). La URL es `https://guests.ikisai.com/i/<token>`. Guests solo los canjea.

## 8. Archivos

Solo la **imagen de la firma**:
- PNG con fondo transparente (o WebP), del trazo recortado a su caja y a 2× la resolución de la pantalla, por debajo de 300 KB;
- se sube con `uploads` de `guests-api` al bucket privado `guests-documents`, se verifica y su `file_id` va a `booking.portal_guest_sign`;
- Guests no la vuelve a leer: el huésped ve «Firmado el 3 de marzo a las 18:40 por {nombre}».

El personal la ve desde Booking (`GET /api/v1/guest-signature/:guestId`).

**Conservación:** la columna que la referencia es de Booking (`booking.guests.signature_file_id`, clase `legal`, tres años, anonimización de SES-4). El archivo, en cambio, queda en `core.files` con `app = 'guests'`.
- El registro de Booking cubre la referencia (respuesta C2 de Core).
- Guests activa la recogida con `core.enable_file_gc('guests')` en su migración 0600, sin campos propios.
- Una firma subida que nunca llega a guardarse queda huérfana y se borra a los 30 días; una que llegó a ser legal no se borra sola.

Las imágenes de «Ayuda y sugerencias» van por `feedback/uploads` (bucket `feedback-media`, kit).

**Nunca se fotografía ni se sube el documento de identidad** (decisión de SES: se comprueba a la vista en la llegada).

## 9. Pantallas y navegación

PWA `apps/guests` sobre `createAppShell` del kit 0.18.x, móvil primero; en escritorio, columna central de lectura cómoda.
- **Cabecera:** marca «Guests» con lanzador (sesión única) y el selector de idioma (ES · EN).
- **Navegación (O4a, §9.12):** barra inferior «Calendario · Retiros · Más». En la pestaña de cada retiro, sus secciones: Resumen (antes, Inicio) y los módulos que habilite el organizador (§13.1). Cada tarea es una pantalla con «Volver».

Llevan `data-feedback-ignore` los datos personales, el número de documento y la firma.

### 9.1 Entrada (`/i/<token>` y `/`)

- **`/i/<token>`:** llama a `client.loginWithLink(token)`, **quita el token de la URL** (`history.replaceState` a `/`) antes de pintar nada y va a Inicio.
  - Si en el dispositivo había otra persona con sesión, se cierra la suya primero (`onSessionEnd` limpia la caché y los borradores locales).
- **`LINK_INVALID` y `LINK_EXPIRED`:** texto del §6.3 y debajo «¿Necesitas ayuda? Escríbenos a {contact.email} o llámanos al {contact.phone}».
  - Sin sesión no se puede leer Central por `read/…`. Hasta que exista la lectura pública de la petición C1, se usan los textos de reserva del código.
- **`/` sin sesión** (ni pase de sesión única): «Para entrar, abre el enlace personal que te enviaron por correo o WhatsApp.» Debajo, el hueco de «Guarda tu acceso» («Entrar con Google», «Recibir un código por correo»), oculto mientras `permanentAccount` sea `false`.
- **Idioma:** se elige antes de entrar, con la detección del navegador y un cambio manual siempre visible (§9.10).

### 9.2 Aviso de protección de datos

Es lo primero que ve el huésped al abrir su enlace, y vuelve a salir cuando cambia el texto:
- condición: `privacy_ack_version` distinta de la `version` vigente de `portal.privacy` en Central;
- texto completo de `portal.privacy` en el idioma elegido, con el responsable, la finalidad, el plazo y los derechos;
- un único botón **«Entendido, continuar»**, que llama a `portal_guest_consent {privacy_ack_version}`. Booking anota la hora del servidor.

Es **información, no consentimiento**: no hay casilla y no se puede rechazar. Sin pulsarlo, Guests no deja abrir «Mis datos» ni «Alimentación» (sí la información práctica y la ayuda). Si en ese momento no hay red, el acuse queda pendiente en local y se envía al volver; el huésped puede seguir.

Si `portal.privacy` no está en el idioma elegido, se muestra en español con la nota «Disponible solo en español».

### 9.3 Inicio (`#/`)

Responde a cuatro preguntas: qué retiro es, cuándo, qué me falta y qué puedo consultar ya.

- **Cabecera:**
  - título del retiro;
  - fechas en el idioma elegido («del 12 al 15 de marzo» · «12–15 March»);
  - horas de llegada y salida cuando Booking las dé (petición BG4);
  - «Hola, {nombre}».
- **Lo que te falta** (lista de comprobación, cada fila abre su pantalla):

  | Fila | Estado | Cuándo aparece |
  |---|---|---|
  | Tus datos | «Completos ✓» / «Faltan 3: documento, dirección, código postal» | siempre, salvo modo `ninguno` |
  | Alimentación | «Revisada ✓» / «Cuéntanos si tienes alergias o una dieta especial» | siempre |
  | Firma del registro de entrada | «Firmado ✓» / «Pendiente» / «Primero completa tus datos» | solo en modo `ses` |

  - Cuando todo está hecho: «¡Todo listo! Nos vemos el {fecha}.»
  - El estado sale de `missing`, `signed` y la marca de alimentación revisada (BG3). «Revisada» es `diet_reviewed_at`.
- **Información práctica:** tarjeta a §9.7.
- **Ayuda y sugerencias:** tarjeta a §9.8.
- **«Guarda tu acceso»** e **«Instalar la app»:** sugerencias discretas al final cuando todo está completo, nunca antes (§9.9).

**Según el momento**, calculado en hora de Madrid con las fechas de la reserva:
- **Antes:** la lista de arriba.
- **Durante** (del día de llegada al de salida): «Hoy en Ikisai» encabeza la página con un botón grande **«Necesito ayuda»** (rama Espacio del feedback, §9.8) y el teléfono de Ikisai. La lista de pendientes baja.
- **Después:** «Gracias por venir» y «Cuéntanos qué tal» (feedback del retiro y de Ikisai, §9.8).

La fase 4 llenará «Hoy en Ikisai» con el programa, la comida y el alojamiento (§13.2).

### 9.4 Mis datos (`#/datos`)

Un formulario por bloques plegables según el modo de la reserva. **Solo se abre el primer bloque con algo pendiente**, y los demás dicen en su cabecera si están completos o cuántos datos faltan.

| Modo | Bloques |
|---|---|
| `ses` | **Quién eres:** nombre, primer y segundo apellido, sexo, fecha de nacimiento, nacionalidad · **Documento:** tipo, número y número de soporte · **Dónde vives:** dirección, código postal, ciudad y país · **Contacto:** teléfono y correo · **Si es menor:** interruptor «Es menor de edad» y, al activarlo, nombre de quien le acompaña y parentesco (en lugar del documento) |
| `operativo` | nombre, primer apellido, teléfono y correo. Nunca documento, dirección, nacimiento ni firma |
| `ninguno` | la pantalla no existe; Inicio no muestra la fila |

**Reglas de los campos:**
- **Obligatorio, con su motivo:** debajo de cada campo que falta, «Lo pide el registro de viajeros». El enlace «¿Por qué te lo pedimos?» abre el texto de Central `guests.data_why` (petición CE2).
  - Las condiciones salen de `guestMissing` del dominio de Booking: segundo apellido con DNI, número de soporte con DNI o NIE, parentesco si es menor y documento si no lo es.
- **Procedencia** (decisión del usuario: lo que escribió el organizador lo ves y lo puedes corregir):
  - un campo que escribió el organizador lleva la marca «Lo indicó tu organizador» y se edita igual que los demás;
  - al cambiarlo pasa a ser del huésped (Booking anota `by: guest`) y la marca desaparece;
  - un campo escrito por el personal lleva «Lo indicó Ikisai».
  - La procedencia llega en `portal_my_guest.sources`.
- **Controles:**
  - tipo de documento: DNI, NIE, Pasaporte, TIE, Otro;
  - sexo: Hombre, Mujer, Otro (`H`, `M`, `X`);
  - país y nacionalidad: selector con buscador, con los nombres de `Intl.DisplayNames` en el idioma elegido y el código alfa-3 que guarda Booking;
  - fecha: campo de fecha del kit;
  - parentesco: lista traducida con los códigos del catálogo de SES (`KINSHIP_CODES` del dominio de Booking: `PM` padre o madre, `TU` tutor legal, `AB` abuelo o abuela…); Guests guarda el código. Un texto libre antiguo se muestra con `kinshipLabel` tal cual.
- **Normalización antes de enviar:** el número de documento, sin espacios y en mayúsculas (como Booking).

**Guardado automático, sin botón «Guardar»:**
- **Cuándo:** cada campo se guarda al salir de él, o tras 800 ms sin teclear en los de texto, con `portal_guest_update {guest_id, expectedRevision, fields: {campo}}`.
- **Cola:** las escrituras van en una cola local por huésped, en orden y con una sola en vuelo. Cada una lleva la revisión que devolvió la anterior (`revision` de la respuesta), sin releer la ficha.
- **Estado junto al campo:** «Guardando…», luego «Guardado ✓» (se desvanece). Si falla: «No se ha guardado · Reintentar». Sin red: «Se guardará al volver la conexión».
- **Estado global**, discreto, arriba: «Todo guardado» · «Guardando 2 cambios» · «Sin conexión: 2 cambios pendientes».
- **`VERSION_CONFLICT`:** se recarga la ficha. Si el valor del servidor del campo en conflicto es distinto del que tecleó el huésped, se muestran los dos («Tu organizador lo cambió a… · Tú habías puesto…») con «Quedarme con el mío» o «Usar el nuevo». Los campos sin conflicto se reenvían solos.
- Un campo que no pasa la validación del dominio (por ejemplo, una fecha imposible) no se envía: queda marcado con el motivo.

**Firma ya hecha y datos cambiados:** si el huésped corrige un dato del registro después de firmar, se le avisa: «Has cambiado tus datos después de firmar. Vuelve a firmar para que el registro coincida.» La regla es de Booking (BG5): la respuesta trae `signature_reset: true`, Inicio vuelve a mostrar la firma como pendiente y el aviso sale en ese momento.

### 9.5 Alimentación (`#/alimentacion`)

- **Lista de lo que ha indicado** (de `restrictions`):
  - cada elemento muestra el tipo y el «qué» («Alergia · frutos secos · grave»);
  - los que escribió el organizador llevan «Lo indicó tu organizador» (petición BG1).
- **Añadir**, en una hoja:
  1. **Tipo:** Alergia · Intolerancia · Vegetariana · Vegana · Sin gluten · Sin lactosa · Preferencia · Otra.
  2. **«¿A qué?»**, obligatorio en alergia, intolerancia y otra.
  3. **Gravedad**, solo en alergia e intolerancia: leve, moderada o grave.
  4. **«Algo que deba saber cocina»** (opcional, 200 caracteres).
- **«No tengo alergias ni dieta especial»**: botón visible con la lista vacía. Envía la lista vacía y deja la alimentación como revisada (BG3).
- **Guardado:**
  - cada cambio completo envía la **lista entera** con `portal_set_restrictions`, ya que la acción sustituye todas, también las del organizador;
  - la lista enviada lleva siempre lo que el huésped ve, así que lo que escribió el organizador se conserva salvo que el huésped lo quite;
  - un elemento a medias (sin el «qué») se queda en el dispositivo con «Falta indicar a qué» y no se envía.
- **Interruptor de consentimiento:**
  - texto: **«¿Quieres que tu organizador sepa tus alergias o intolerancias?»**;
  - debajo: «Si no, solo le diremos cuántas personas del grupo tienen cada alergia, sin nombres. La cocina de Ikisai las conoce siempre.»;
  - se guarda con `portal_guest_consent {allergies_visible_to_organizer}`;
  - es revocable y solo aparece si hay alguna alergia o intolerancia.
- **Aviso sin promesas clínicas:** «La cocina de Ikisai tendrá en cuenta lo que indiques. Si tu alergia es grave, recuérdalo también al llegar.» El texto definitivo viene de Central (`guests.allergies_notice`, petición CE2). Guests nunca dice que un plato «es seguro».

**Si cambia algo con el menú ya cerrado:** no se toca el menú. Food detecta el cambio porque la revisión de `booking.food_event_projection` sube cuando cambian las restricciones (contrato §8), y la revisión queda en el sistema dueño.

### 9.6 Firma del registro de entrada (`#/firma`)

Solo en modo `ses`. Hasta que los datos estén completos (`missing` vacío), la fila de Inicio dice «Primero completa tus datos» y la pantalla explica qué falta.

- **Resumen** de los datos que se firman (nombre, documento, nacimiento, dirección y fechas de la estancia), en solo lectura, con «Corregir» hacia Mis datos.
- **Texto de la declaración**, de Central (`guests.signature_statement`, petición CE2; texto de reserva: «Declaro que estos datos son ciertos. Se incorporan al registro de viajeros de Ikisai, que la ley obliga a conservar tres años.»). Su `version` viaja como `text_version` en `portal_guest_sign`.
- **Quién firma:**
  - lo decide `signsOwnEntry(guest, reservation.start_date)` del dominio de Booking: desde 14 años, el propio huésped;
  - por debajo, «Firma de la persona que acompaña a {nombre}», con `signed_by_name` prellenado con `guardian_name`;
  - el nombre de quien firma es editable y obligatorio (≤ 200).
- **Recuadro de firma** a lo ancho, con «Borrar» y «Firmar».
- **Al firmar:**
  1. la imagen se recorta y se comprime (§8);
  2. `uploads` → `PUT` → `verify`;
  3. `portal_guest_sign {guest_id, expectedRevision, file_id, signed_by_name}`;
  4. «Firmado ✓ el {fecha}».
- **Sin red:** la firma dibujada se guarda en el dispositivo (IndexedDB, por persona) con «Firma pendiente de enviar: se enviará al volver la conexión», y se envía sola al volver. **No se marca como hecha hasta que Booking confirma.** Si falla al enviarla, se pide firmar de nuevo.
- Firmado, la pantalla muestra «Firmado el {fecha} por {nombre}», sin la imagen.

### 9.7 Información práctica (`#/info`)

**Información de Ikisai**, de Central en el idioma elegido (claves nuevas, petición CE2):

| Clave | Contenido |
|---|---|
| `info.arrival` | cómo llegar, con la dirección y el enlace al mapa |
| `info.parking` | aparcamiento |
| `info.facilities` | instalaciones y lo que hay en el centro |
| `info.rules` | normas de convivencia |
| `info.bring` | qué traer |
| `contact.email`, `contact.phone` | contacto (ya existen) |

- Se pintan como secciones plegables con su título.
- **Durante la estancia**, «Llamar a Ikisai» (`tel:`) queda fijo arriba.
- Todo se guarda en caché para leerlo sin cobertura (§10).

Los **materiales del organizador** son de la fase 4 (§13.3).

### 9.8 Ayuda y sugerencias

Entrada en el panel del lanzador, con `createAppLauncher({ centerLabel: 'Ayuda y sugerencias' })`, y tarjeta en Inicio. Sin «Señalar para comentar» ni «Revisor de QA».

Abre `createFeedbackProgressiveForm` del kit con este catálogo (especificación de feedback §3.2 y §4):
1. **«¿Sobre qué quieres comentarnos algo?»** → La aplicación · Mi retiro · Un espacio de Ikisai.
2. **Aplicación:**
   - «Algo no funciona» o «Tengo una sugerencia» (`intent: bug | improvement`);
   - paso de señalar con `captureFeedbackTarget` («Mantén pulsado sobre el lugar de la aplicación al que te refieres»; se puede saltar);
   - comentario e imágenes. `subject: application`.
3. **Mi retiro:**
   - tipo: Horarios · Organización · Actividades · Comunicación · Comida · Otra;
   - comentario;
   - `subject: event`, `scope: {reservation_id, guest_id}`, `intent: problem | suggestion`;
   - aviso: «Lo leerá tu organizador». Destino `organizer` (FEEDBACK.md §4). Mientras Organizers no tenga su bandeja, los ve el personal de Booking en «Sugerencias y QA» (respuesta C5).
4. **Un espacio de Ikisai:**
   - lugar, como texto y sin `space_id`: Mi habitación · Comedor · Sala · Baños · Exterior · Piscina · Otro;
   - tipo: Algo está roto · Limpieza · Falta algo · Agua o electricidad · Seguridad · Otra cosa (`damage | cleaning | missing | utilities | safety | other`);
   - comentario e imagen;
   - `subject: space`, `scope: {reservation_id, guest_id}`;
   - destino `operations` → Tasks.

- **«Necesito ayuda»** (durante la estancia) abre directamente la rama Espacio, con el teléfono de Ikisai encima para lo urgente: «Si es urgente, llámanos».
- Debajo, **«Lo que me has enviado»** (`GET feedback?mine=true`) con el estado en claro: Recibido · En marcha · Resuelto.
- **Después del retiro:** «Cuéntanos qué tal» abre la rama Mi retiro con `intent: suggestion`, y una segunda pregunta «¿Y de Ikisai?» que va como Espacio u «otra». El feedback posterior estructurado (valoración) es de una fase siguiente (§13.6).

### 9.9 «Guarda tu acceso» e instalación

- **Hueco de «Guarda tu acceso»** para quien entró por enlace, opcional para el huésped (a diferencia del organizador):
  - aparece en Inicio cuando todo está completo, y en el menú de la cabecera;
  - con `permanentAccount = false`, abre una hoja: «Pronto podrás guardar tu acceso con tu cuenta de Google o con un código por correo. Mientras tanto, guarda el enlace que te enviaron.»;
  - el componente queda listo para conectarle las dos acciones cuando Core las active.
- **Instalar la app:**
  - en Android y Chrome, el aviso de instalación nativo (`beforeinstallprompt`);
  - en iOS, una hoja con los dos pasos de «Compartir → Añadir a pantalla de inicio»;
  - nunca bloquea nada.
- **Salir de este dispositivo:** en el menú de la cabecera. Borra la caché y los borradores locales (`logout` y `onSessionEnd`). Útil si se usó un móvil prestado.

### 9.10 Idioma (español e inglés)

- **Capa de traducción del kit** (en preparación por UI): diccionarios `es` y `en` de la app y `t('clave', vars)`.
  - **Elección:** por el idioma del navegador (`en*` → inglés; el resto → español), con cambio manual recordado por dispositivo.
  - **Formatos:** fechas, horas y números con `Intl` en el idioma elegido.
  - **El kit ya traducido:** lanzador, feedback, avisos y conflictos.
- **Lo que se traduce en Guests:** todas las etiquetas de los catálogos de Booking (tipos de documento, sexo, tipos de restricción, gravedades y parentescos), los estados y los errores. Booking guarda los valores canónicos; Guests solo los muestra.
- **Textos de Central**, en el idioma elegido si existen y, si no, en español con la nota «Disponible solo en español» (petición CE1).
- **Textos del organizador** (fase 4), en el idioma en que los escriba.
- **Ids:** las claves de traducción y los `data-feedback-id` son estables e independientes del idioma.

### 9.11 Uso y `data-feedback-id`

`createUsage({ app: 'guests', notice: false })`: agregados sin persona (USO.md §3). Identificadores literales `guests.<pantalla>.<sección>.<elemento>`. Los principales:

```text
guests.entrada.enlace.error              guests.entrada.idioma.cambiar
guests.aviso.privacidad.entendido        guests.inicio.pendientes.abrir
guests.inicio.selector.abrir             guests.inicio.ayuda.urgente
guests.datos.bloque.abrir                guests.datos.campo.guardar
guests.datos.conflicto.resolver          guests.alimentacion.lista.anadir
guests.alimentacion.lista.quitar         guests.alimentacion.lista.ninguna
guests.alimentacion.consentimiento.cambiar
guests.firma.recuadro.borrar             guests.firma.recuadro.firmar
guests.info.seccion.abrir                guests.info.contacto.llamar
guests.ayuda.formulario.enviar           guests.acceso.guardar.abrir
guests.app.instalar.abrir                guests.cuenta.dispositivo.salir
```

`usage.run` en guardar un campo, guardar la alimentación, el consentimiento, el acuse del aviso, firmar y enviar una sugerencia.

### 9.12 Guests por persona: calendario y pestañas (O4a, 14-10-2026)

Primera parte de O4 (RECURSOS.md §17; aprobada por el usuario el 13-10-2026), con los datos de hoy. La pestaña Outsider, las estancias, «hay alguien», las notas, los retiros abiertos con «Apuntarme» y «Mis propuestas» son O4b (después de O2 y O3c).

- **Barra inferior:** «Calendario · Retiros · Más».
  - «Retiros» abre la pestaña del retiro que se está viendo; desde el calendario, la del último visto (o la de entrada).
  - «Más» es lo del retiro que se ve, como antes.
- **Rutas:**
  - `#/`: el retiro de entrada.
  - `#/calendario`: el calendario.
  - `#/p/<guestId>[/<sección>]`: una persona en un retiro, como antes; **los enlaces directos siguen valiendo**.
  - `#/r/<reservationId>[/programa|/menu|/alojamiento]`: la familia junta en un retiro con varias personas de la cuenta.
- **Retiro de entrada:** el del enlace con el que se entró (C10: `loginWithLink` devuelve su `grant`; se guarda solo en memoria, así que al volver a abrir la app ya no cuenta); si no, el que está en curso; si no, el próximo; si no, el calendario. Con una sola ficha, esa.
- **Pestañas de retiros:** deslizables, por fecha (pasados, en curso y próximos), con la elegida centrada; solo con más de uno. Cambiar de pestaña **conserva la sección** (Programa en uno → Programa en otro).
- **Secciones del retiro:** Resumen · Programa · Menú · Alojamiento (las activas). Solo en el Resumen y en las secciones; las demás pantallas tienen su «Volver».
- **Familia (varias personas en una cuenta):**
  - selector «Todos · Marta · Nico» encima de las pestañas, solo si hay más de una, ordenado por nombre;
  - por defecto, **Todos**: las pestañas de todos los retiros; uno que no es de todos lleva el nombre de a quién toca;
  - en un retiro con varias personas, con «Todos»: Resumen con lo que falta de cada una (una tarjeta con su nombre), Programa y Menú comunes, Alojamiento con la cama de cada una (un toque lleva a la suya);
  - un solo «Entendido» del aviso legal vale para las fichas de ese retiro (se sigue aceptando en cada retiro);
  - con una persona elegida, solo lo suyo, como antes. Una ruta `#/p/<id>` de un retiro compartido elige a esa persona.
- **Calendario** (`createCalendar` del kit 0.33, capa «Mis retiros»): un mes de lunes a domingo con hoy en hora de Madrid. Tocar un retiro abre su pestaña. Debajo, «Todos tus retiros» con sus fechas y su momento (pasado, en curso o próximo): así se llega a uno lejano sin pasar meses, y se lee bien con lector de pantalla.
- **Pruebas:** `tests/guests/personas.spec.ts`. Las de caracterización siguen en verde con los cambios a propósito marcados «O4a».
- **Capturas** de antes y después: `docs/guests/capturas/o4a/` (las de antes, en `coordinacion/guests/o4/capturas/`).

### 9.13 Outsider en Guests (O4b, primera parte, 14-10-2026)

Para quien tiene nivel de casa `outsider` (`bootstrap.profile.houseLevel`; en Guests es `editor` y sus lecturas van por su cuenta, Booking §26). Sin ese nivel, nada de esto se ve.

- **Pestaña Outsider** (`#/outsider`):
  - en la tira de retiros, entre los pasados y los demás (boceto de O4 §2.2);
  - regla de entrada: el enlace, el retiro en curso, el próximo, **la Outsider** y el calendario;
  - un outsider sin retiros entra directamente en ella, sin pestañas.
  - **Tu estancia:** la que está en curso o la próxima, con habitación, cama y zona. Si coincide con un retiro, sale un aviso, nunca un bloqueo (decisión del usuario). Sin estancias, la cama habitual. «Nueva estancia» abre el calendario eligiendo días (`#/calendario/nueva`).
  - **Cómo llegar:** la información práctica (`#/outsider/info`, también en «Más»).
  - **Comidas:** «Sugerir un plato» (nombre, día y comida) envía una sugerencia `plato_casa` a Food (`client.suggest` con `houseDishSuggestionOperations`, Food §2.6) que aprueba cocina. Debajo, «Mis propuestas» con `createSuggestionSource(client, { scope: 'mine', app: 'food' })` y «Retirar».
  - El menú de casa saldrá cuando Food publique su lectura de portal (petición FD2), y «Mis tareas» cuando Tasks publique el rol outsider (TK1).
- **Calendario** con nivel outsider:
  - capas «Mis retiros» y «Mis estancias», con leyenda;
  - días rayados «Hay alguien del staff» (`portal_staff_presence`, sin nombres);
  - **notas con hora** (`portal_stay_notes`), en hora de Madrid, del equipo y propias.
  - **Estancias** (`portal_my_stays`, `portal_stay_save` y `portal_stay_remove`):
    - se crean eligiendo la llegada y la salida (noches `[desde, hasta)`, de 1 a 180), con la cama habitual;
    - se cambian de fechas y se quitan desde el panel del día;
    - las que puso el personal solo se ven.
  - **Notas:** «Añadir nota» (hora y texto) en el panel del día, y «Borrar» en las propias.
  - Todo esto necesita red: sin ella se avisa, y las lecturas salen de la caché.
- **Pruebas:** `tests/guests/outsider.spec.ts`, contra Booking y Food reales: sin nivel no hay pestaña; outsider y huésped; outsider sin retiros (presencia, notas y plato sugerido). Capturas en `docs/guests/capturas/o4b/`.
- **Segunda parte (14-10-2026):**
  - **Clave de persona** (`portal_my_retreats`, Booking §26): la misma persona en dos retiros se reconoce por su `person_key`. Una ficha sin clave se une a la única clave de su nombre y, si no hay ninguna, se agrupa por nombre y primer apellido, como en O4a.
  - **Estancias en familia** (con nivel outsider y más de una persona en la cuenta): una estancia nueva es para todos por defecto, con casillas para quitar a alguien. Las personas van con su clave de Booking (`portal_person_link` une sus fichas si aún no la tienen). El panel del día dice para quién es y ofrece «Separar» (`portal_stay_split`): unas personas con otras fechas y la misma cama. Una estancia que no es de todos lleva los nombres en el calendario.
  - **Retiros abiertos** (`portal_open_retreats`, §26.1), para cualquier huésped: capa «Retiros abiertos» (borde discontinuo) con su resumen en el panel del día, sin precio. Los que ya son suyos no se repiten.
- **Última parte: «Apuntarme»** (Booking #518, §26.3), en el panel del día de un retiro abierto:
  - es para todas las personas de la cuenta por defecto (o el titular), con casillas para quitar a alguien y un mensaje opcional;
  - se envía como sugerencia `apuntarme` a Booking (`client.suggest` con `booking.join_from_suggestion`), con la clave de persona de cada una (`portal_person_link` si aún no la tienen);
  - después, el estado: «Solicitud enviada» (con «Retirar»), «con el organizador», aceptada o descartada, con el comentario (`portal_open_retreats.request` y `client.suggestions({scope: 'mine', app: 'booking'})`);
  - al aceptarla, la cuenta recibe la entrada y el retiro pasa a sus pestañas;
  - «Mis propuestas» de la pestaña Outsider junta los platos (Food) y los «Apuntarme» (Booking).

### 9.14 Rediseño de La Muela, de una pasada (tanda 31, 20-10-2026)

Consolidado MUELA-071 con sus traspasos (012, 018, 025, 028, 030, 034, 037, 054, 056, 059, 060, 065 y 066) y la corrección
078, sobre el kit 0.48. Reglas de Core: lo que La Muela quitaba se conserva (`PERDIDAS_guests.md` §1), las reglas de ley,
seguridad y dinero son obligatorias (§2) y lo que no se nombra se queda (§3). Sin planos de zonas, «Ver en el plano» enseña
el sitio en texto y el plano del centro de Central (imagen o PDF).

**Parte A · cáscara, Resumen, Programa, Menú y Alojamiento:**
- **Menú lateral del kit** (`createAppShell({ menu })`, MUELA-013): la marca abre el cajón con «Este retiro» (sus secciones y
  lo que antes iba en «Más»: Información práctica, Materiales, Preguntas, Tus datos, Alimentación, Firma y Ayuda), «Retiros»
  (hasta seis y el calendario) y, con nivel outsider, la casa. La barra de abajo sigue con «Calendario · Retiros». «‹ Volver
  a…» (K9) si se llega desde otra app.
- **Cabecera del retiro** (`ui/frame.ts`, MUELA-059): portada del kit (`createCoverCarousel`) con la imagen del retiro (la
  primera imagen publicada en materiales que no es el logotipo; sin ella, color e iniciales), estado en texto, fechas, caras
  de la familia y, si el retiro no es de todos, a quién toca; flechas, puntos (`#retreatTabs .cover-dot`) y deslizar. Encima,
  el selector de persona (`#persons`) y la casa de Outsider (`#outsiderTab`). Debajo, «tu retiro de un vistazo» (estado,
  noches, cama y quién va) y las secciones con icono (`#sections`), fijas bajo la cabecera al bajar con la barra plegada.
  Si hoy hay un retiro en curso y se ve otro, aviso fijo `#otherRetreat` con «Ir a mi retiro» (se minimiza, no se cierra).
- **Resumen** (`ui/home.ts`, MUELA-012): cuadro del retiro (saludo, fechas con el momento y llegada y salida a la vista;
  durante, «Necesito ayuda» y «Llamar»; después, «Cuéntanos qué tal» y el próximo retiro), paso a paso del kit
  (`renderSteps`, `#task-<id>` en cada tarea; lo hecho en la línea «Hecho:», con su estado en el `title`), horario del retiro
  (`#schedule`: pestañas de día y `renderHourAgenda` con las comidas, `#todayNow`, `#todayNext`, `#todayMeal`), mensaje del
  organizador y «Tu estancia» (`#roomPlan` y cuadros `#retreatTiles`). Sin red, solo «Guarda tu acceso» se desactiva
  (`bindOnline`); lo que se rellena se guarda en el móvil como siempre.
- **Regla de «ahora»** (MUELA-012 y 025): una actividad sin hora de fin sigue «Ahora» hasta que empieza la siguiente del día
  (`endOfItem` y `nowAndNext` en `ui/program.ts`).
- **Programa «Ahora y lo siguiente»** (MUELA-025, `renderNow` del kit): lo de ahora con su barra y «Quedan…» (o «Hasta las
  19:00 · Meditación»), lo siguiente con su cuenta atrás, «Hoy, más tarde» plegado con el mismo detalle, lo hecho tras «Ver lo
  ya hecho» y los otros días al pie (`#programDays`). Antes del retiro, «Empieza en N días». Cada lugar con «Ver en el plano» y
  cada comida con «Ver el menú». Con la familia, el mismo programa con sus caras (sin `audience` no hay columnas por persona).
- **Menú «La carta»** (MUELA-034 y 065, con 078): la próxima comida abierta (`#menuNext`) y las demás plegadas, filtros de
  dieta y «Sin lo que indicaste, según la receta revisada» (ningún plato sin revisar lo pasa), y la línea de cocina con
  «Cambiar» (con la familia, cada persona, también «nada indicado»). En cada plato, **siempre** la línea de alérgenos de #597
  y, **encima**, el aviso de cada persona (`crossRestriction`): «⚠ Lucía: lleva frutos de cáscara (alergia grave). Pregunta
  en cocina.». Con la familia, «Lo que vigilar, persona a persona» (`#familyWatch`) si algo coincide ese día. Nunca «apto».
- **Alojamiento** (MUELA-056 sin plano y 065): arriba «Tu cama» o la habitación que se propone (`#lodgingMine` o
  `#lodgingNone`); filtros «Con baño» y «Poca gente»; «Cambiar habitación» despliega la lista por opciones del organizador
  con su nota (lo que no cumple, con borde discontinuo y elegible igual); y la habitación que se ve (`#lodgingRoom`) con la
  nota de suplemento y las camas por color **y con texto** (supletorias marcadas). Elegir y soltar (con confirmación)
  necesitan red. Con la familia: cada persona arriba con su cama o «Falta por colocar», «Eligiendo para…» al tocarla y
  «Dormir todos aquí» (una llamada por persona). Se conservan las preferencias que se guardan solas, «Pendiente de aprobar»,
  «Cerrada el…» y «sin habitaciones».

**Parte B · Guía del retiro, Tus datos, Alimentación, Firma, Ayuda y Entrada:**
- **Guía del retiro** (`ui/guide.ts`, MUELA-037): Información práctica, Materiales y Preguntas en una página; las rutas de
  siempre (`…/info`, `…/materiales`, `…/preguntas`) la abren en su sección. Avisos «Te faltan N preguntas…» y «N
  materiales nuevos», índice fijo (Llegar · Estancia · Materiales · Preguntas · Contacto) y el contacto arriba durante el
  retiro. El plano del centro se abre dentro (`#infoPlan`, desplegable). «Nuevo» en lo que aún no se ha abierto: se recuerda
  en el dispositivo (por persona) hasta que Organizers guarde «visto» en el servidor; en la vista previa no se marca.
- **Preguntas** (`ui/questions.ts`): `createStepForm` del kit con lo abierto y sin responder («Ahora no» en las no
  obligatorias de opción), y debajo la lista con lo respondido y «Cambiar» o «Cerrada». Solo tras el aviso de protección
  de datos y nunca con la familia junta. Lo escrito sin «Aceptar» se guarda al salir.
- **Tus datos** (`ui/data.ts`, MUELA-018): pregunta a pregunta la primera vez (solo lo que falta, en el orden del registro;
  el país por su nombre o su código; teléfono o correo, basta con uno); al volver, «Antes de venir» con las tareas, su
  estado en palabras y un botón por dato que falta; y **«Ver todos mis datos»** con «Cambiar» y quién puso cada dato, en
  todos los modos. Se conservan «¿Por qué te lo pedimos?», el aviso de firma anulada y los conflictos.
- **Alimentación** (`ui/diet.ts`): «¿Hay algo de comida que debamos saber?» («No, nada», dietas y «Una alergia, intolerancia
  u otra cosa» con los cuatro tipos, a qué, la gravedad y la nota), lo indicado con «Quitar» y la marca del organizador, el
  consentimiento aparte y el aviso de Central.
- **Firma** (`ui/sign.ts`): «Comprueba tus respuestas» con todos los datos y «Cambiar» (abre la pregunta y vuelve), la
  declaración de Central y la firma **solo con el dedo** (la escrita, cuando Booking confirme que vale).
- **Ayuda** (`ui/help.ts`, MUELA-054 sin plano): «¿Urgente?» con el teléfono, y Tu retiro · Un sitio · La app en tarjetas;
  el sitio en baldosas (con «Mi habitación» de entrada), las urgentes con «Si hay peligro, llama ya»; a quién llega; texto,
  fotos y «Enviar» (id y `requestId` estables); y «Lo que me has enviado» con los estados de 071 («✕ No lo vamos a hacer»,
  nunca en verde) y la respuesta escrita cuando llegue en `/feedback?mine`. El sitio sigue viajando como texto
  («[Mi habitación] …») hasta que el aviso lleve `space_id`.
- **Entrada** (`ui/entry.ts`, MUELA-060): bienvenida, qué ha pasado (con «Reintentar» sin red), «Encuentra tu enlace» paso a
  paso (correo y WhatsApp) y siempre las salidas de Central (correo y teléfono; WhatsApp cuando Central publique `contact.whatsapp`). El paso
  «con tu código» llegará con el reenvío del enlace sin sesión del núcleo.

**Parte C · Outsider, «Ikisai» y Calendario:**
- **Outsider** (`ui/outsider.ts`, MUELA-028): arriba «Tu estancia» (la de ahora o la próxima, con habitación y cama, fechas,
  el aviso si coincide con un retiro y «Ver en el plano»), o «No tienes ninguna estancia próxima» con la cama habitual; las
  demás estancias plegadas («Otras estancias (N)», con «la puso el equipo»). Debajo, **tus días en la casa** (los de la
  estancia, o los próximos tres sin ella) con comida y cena y «Sugerir aquí» en cada hueco desde hoy (el plato va a Food
  como siempre, `plato_casa`, con ese día y esa comida); «Otro día u otra comida» conserva plegado el formulario de siempre
  (cualquier día desde hoy y las seis comidas). «Nueva estancia», «Ikisai» y «Mis propuestas» (plegado). Sin red se ve todo
  y solo sugerir y pedir estancia se desactivan, con su motivo. La cabecera ya no repite la pestaña Outsider: solo el
  selector de persona. Cada hueco enseña lo que hay en el menú de casa (FD2, §9.15).
- **«Ikisai»** (`ui/house.ts`, MUELA-066; ruta `#/outsider/info`): sustituye a la Información práctica del retiro para el
  outsider. Según el momento (`duringOf`, día de Madrid): «Ahora, en la casa» (hasta cuándo, llamar al equipo, tu cama,
  normas), «Antes de venir» («Llegas el martes, 20 (en 5 días)», cómo llegar, tu cama, aparcamiento) o «Cuando vengas»
  (nueva estancia, cómo llegar, tu cama habitual). Debajo, la guía en tarjetas con la primera frase a la vista (En la casa ·
  Al llegar, con los textos `info.*` de Central), el plano de la casa (el del centro de Central; la sección no sale si no
  hay plano ni cama), el lugar y el contacto. Los textos propios de la casa (`house.*`) llegarán cuando Central los publique.
- **Calendario** (`ui/calendar.ts`, MUELA-030): arriba «Tu próximo retiro» (o «Ahora») con su cuenta atrás y «Abrir el
  retiro»; **«Tu año»** (`renderTimeline` del kit, doce meses): los retiros en una banda que abre cada uno, las estancias
  en una pista por persona (con la familia) y, en texto, mes a mes: retiros, estancias con sus noches, invitaciones y los
  días con alguien del staff (sin nombres). «Nueva estancia» abre una hoja con llegada y salida y las noches al momento,
  con aviso si coincide con un retiro y los días con staff; después, «¿Para quién?» como siempre. Las invitaciones a
  retiros abiertos, en tarjetas con su resumen, sin precio y con «Apuntarme» y su estado. El mes, plegado en «Ver como
  mes», conserva todo lo de antes: elegir días para una estancia, el panel del día con sus notas, «Cambiar fechas»,
  «Separar», «Quitar», «hay alguien del staff» y los retiros abiertos con «Apuntarme». La lista de todos los retiros sigue
  al pie.
- Se borran `ui/retreats.ts` (la cabecera vieja de pestañas, sustituida por `frame.ts` en la parte A) y `ui/info.ts` (la
  Información práctica del outsider, sustituida por «Ikisai»).

### 9.15 Menú de casa y Programa por persona (20-10-2026)

- **Menú de casa en Outsider (FD2, Food §7.6):** `food.portal_house_menu {}` (desde hoy, 60 días; con copia en la caché
  para verlo sin red). En «Tus días», cada hueco de comida y cena enseña su hora y sus platos, cada uno con la línea de
  alérgenos de #597 (los declarados siempre; sin revisar, «sin revisar por cocina», también sin ninguno). Sin menú, «aún
  no hay nada», como antes; «Sugerir aquí» sigue en cada hueco. Si la lectura falla, la pantalla sigue igual.
- **Para quién es cada actividad (`audience`, Booking §23, MUELA-065):** `todos` (o sin el dato), `adultos`, `menores`
  (por `is_minor` de cada persona) o `personas` (`audience_guest_ids`; Booking solo manda los del ámbito de quien lee, así
  que nunca sale nada de otra familia). Funciones puras en `app/audience.ts` (`audienceOf`, `itemsFor`).
  - **Una persona:** el Programa y el horario de Inicio solo enseñan lo suyo.
  - **La familia junta:** lo de ahora arriba, como siempre, y el día **en una columna por persona** (`#programCols`, tabla
    con sus papeles): lo común a todo el ancho, lo de alguien en su columna (borde naranja) y «Libre» en las demás; cada
    celda se abre con su detalle («Para Leo», el plano, «Ver el menú», la nota). Los menores, con aro y «menor» en texto.
    En Inicio, «Para Leo» en la línea de la actividad.
- `resource_space_id` de cada actividad se lee pero aún no se usa: el plano de zonas llegará cuando el portal pueda leer
  los dibujos (lo hace Core). Hasta entonces, el plano de Central.

### 9.16 El mapa de zonas en «Ver en el plano» (MUELA-024, 20-10-2026)

- **Lectura:** `GET plans` (§6.1) con copia en la caché para verla sin red, recordada un minuto en la pantalla. El dibujo
  se guarda en el dispositivo por su `sha256` (Cache Storage `ikisai-guests-plans`, se borra al salir) y no se vuelve a
  bajar si no cambia; si no se puede leer (CORS), la imagen firmada se pinta igual.
- **«Ver en el plano»** (`ui/plan.ts`) busca el sitio en el mapa por su id de Recursos: `resource_space_id` en el
  Programa, y `resource_space_id` y `resource_bed_id` en `portal_lodging` y `portal_my_stays` (Booking #680). Solo cuando
  Booking no tiene pareja (`null`), por nombre (habitación y cama dentro), y solo si coincide con uno. Con el sitio: `createSpaceMap` del kit con el sitio resaltado y «Aquí» en texto, el
  conmutador Plano/Lista y, debajo y plegado, el plano del centro de Central como respaldo. Sin dibujo o sin forma, la
  pieza enseña la lista con la ruta. Sin el sitio en el mapa, como antes (el plano de Central).
- **Pantallas:** Resumen (`#roomPlan` y lo de ahora), Programa, Información práctica y «Ikisai» (el mapa entero,
  `whole`), y la estancia de Outsider.
- **Alojamiento** (MUELA-056, `#lodgingMap`): con la elección abierta, el plano de las habitaciones abiertas encima de
  «Cambiar habitación» (casadas por nombre único mientras `portal_lodging` no dé el id de Recursos); las demás estancias,
  apagadas y sin tocar. Cada una con su estado en texto dentro («2 libres», «No cumple» con los filtros, «Llena»); tocarla
  la enseña abajo, como la fila de la lista, y queda resaltada. **La elegida ampliada** (`focus` del kit 0.54,
  `#lodgingBedsMap`): en la habitación de abajo, su dibujo recortado con las camas encima, cada una con su estado en texto
  («Libre», «Ocupada», «Elegida» o la de quién de la familia; apagada si no se puede elegir); tocar una hace lo mismo que
  su botón (confirmación incluida). Sin números en las camas (`bedNumbers: false`, kit 0.54.1, en todos los mapas de
  Guests): el estado va en el color, el rayado y el nombre accesible, y el nombre, en los botones. Los botones de color con texto siguen debajo, como lista equivalente. Sin forma de la
  habitación o sin camas dibujadas, solo los botones.
- **Ayuda** (MUELA-054, `#helpPlan`): bajo las baldosas de «Un sitio», «Tócalo en el plano» (solo los sitios de huéspedes:
  habitaciones, salas, baños, comedor, exteriores, zonas de paso y otros). Tocar un sitio lo elige («Sitio: …»,
  `#helpPicked`) y el aviso lleva `scope.space_id` (Recursos) y su nombre en el texto, como siempre. Las baldosas siguen.

- **Finca y decoración** (Recursos 0814, kit 0.63, 28-10-2026): `GET plans` firma también los iconos (`icons[].url`) y las imágenes de los edificios (`images[].url`), y pasa la retícula, las alturas (`bands`), las curvas con su cota (`contours`) y **solo la decoración general** (`decor`). `portalMap` pinta la decoración y las camas con el icono de su tipo (`bedIcons`); el mapa entero («Ikisai», Información práctica) empieza en la finca y se baja tocando (finca → edificio → habitación, `drill`). Al elegir cama (`#lodgingBedsMap`), sin decoración (`showDecor: false`). Prueba en `api.test.ts`.

### 9.17 Acceso que no caduca, «Mis retiros», dirección y fichas de equipo (encargo de VG del 26-10-2026, plazo 29-10)

Reglas (VG, por Core): quien entró una vez sigue entrando; organizador, staff y dirección aparecen en el retiro como huéspedes; dirección ve todos los retiros. Los datos los pone Booking (`docs/booking/API.md` §29, #725, migraciones 0481 y 0483); Guests solo enseña. Este apartado es el **modelo de pantallas** de la PR en borrador; el código va en la misma PR.

#### a) «Mis retiros» (`#/retiros`, nueva)

- **Dónde:** en el menú lateral, la sección «Tus retiros» enseña los seis más cercanos y «Ver todos» lleva a `#/retiros`; en el Calendario, «Todos tus retiros» enlaza también aquí. La barra («Calendario · Retiros») no cambia: «Retiros» sigue abriendo el retiro que se ve.
- **Grupos, por fecha:** «En curso» · «Próximos» (el más cercano primero) · «Pasados» (el más reciente primero). Sin fechas (sin red), al final.
- **Cada fila** (una tarjeta, toda ella enlace a su retiro):
  - título, fechas cortas y el momento de siempre (`retreatState`: «En 12 días», «Hasta el domingo 9», «Terminado»);
  - **estado de la reserva** en texto, desde `reservation.status` (`portal_my_guest`) y `status` (`portal_my_retreats`): `pre_reservada` → «Pendiente de confirmar» · `confirmada` → «Confirmado» · `en_ejecucion` → «En curso» · `cerrada` → «Terminado» · `cancelada` y `perdida` → «Cancelado · solo lectura»;
  - con la familia y «Todos», a quién toca (las caras, como en el calendario);
  - la etiqueta de equipo si la hay (d).
- **Pedidos de «Apuntarme» pendientes** (O4b, `joinSuggestions`): en «Próximos», con «Pedido · con el organizador» y «Retirar», como en el Calendario.
- **Cancelados:** se abren en solo lectura con la franja «Este retiro se canceló. Lo ves en solo lectura.» (la misma pieza que la vista previa: `readOnly()` pasa a ser `preview` **o** reserva `cancelada`/`perdida`). Nada se guarda ni se encola.
- **Sin red:** de la caché (`my_guest` y `portal_my_retreats`), con la hora de los datos.

#### b) La sesión no se cierra ni se borra al terminar el retiro

Revisado en `main` (830df42):

| Qué | Cuándo se limpia hoy |
|---|---|
| Sesión (token y renovación, `sync-client`) | al salir del dispositivo, si `auth/refresh` responde 400/401/403, o si entra otra persona |
| Caché por persona (IndexedDB `ikisai-guests`: lecturas, borradores y cola) | con el fin de sesión (`onSessionEnd`) |
| Materiales guardados sin red y «Nuevo» visto (`localStorage`) | con el fin de sesión |
| Dibujos del plano (Cache Storage `ikisai-guests-plans`) | con el fin de sesión |
| Shell del service worker | al activar una versión nueva (solo las cachés de shell viejas); el SW no toca `/api/` |
| Textos comunes (`localStorage`) | nunca (no son de la persona) |

**Nada depende de la fecha del retiro**: Guests no filtra los `grants` por fechas ni borra nada al terminar. Lo que cortaba el acceso era el servidor (el enlace caducaba y el `grant` desaparecía con la conservación); eso lo quita Booking (§29.1, `validUntil = 'infinity'`). En Guests:
- `validUntil` `'infinity'` (`Date.parse` da `NaN`) se trata como «sin caducidad»: la entrada nunca dice «Caducó el …» con una fecha inválida.
- Un retiro pasado se abre en el momento «después», como siempre. La ficha anonimizada (conservación) sale con el nombre «Huésped anonimizado» y sus datos vacíos, sin más cambios en Guests.
- Prueba: una cuenta con un retiro pasado y otro futuro se abre, ve los dos en «Mis retiros» y no ve «No tienes acceso».

#### c) Dirección («todos»)

- **Cómo se sabe:** `membership.scopes.grants` contiene `{all: true}` (núcleo 0095; Booking lo confirma). `api.grants()` sigue devolviendo solo los pares reserva + huésped; `api.direction()` dice si está «todos».
- **Sin ninguna ficha:** ya no es «No tienes acceso»: la entrada lleva a `#/retiros`.
- **«Mis retiros»** añade, debajo, **«Todos los retiros»** (`portal_open_retreats`, que con dirección devuelve `direction: true` y todos, pasados y futuros): buscador por título y los mismos grupos por fecha; cada fila con su estado y, si ya tiene ficha, «Ya estás dentro».
- **Recorrer sin estar apuntada:** `#/r/<reservationId>` de un retiro sin ficha abre la **vista de dirección**: cabecera del retiro (título, fechas, estado) y **Programa** (`portal_program` lo permite con `portal_scope_reservation`). Menú, Alojamiento, Guía, datos y firma llevan `guest_id` y necesitan ficha: no salen. Franja: «Lo ves como dirección. Aún no te has apuntado.».
- **Apuntarse:** en los vivos (`joinable`), «Apuntarme» en la vista del retiro → confirmación («¿Te apuntas a …?») → `booking.portal_join_direction({reservation_id, persons?})`, sin aprobación. Con una persona en la cuenta, ella misma con su nombre (sin `persons`); con la familia, «¿Con quién?» con todas marcadas, cada una con su clave de Booking (`portal_person_link` si aún no la tiene, como en O4b). Después se relee el `bootstrap` (el `grant` nuevo) y se abre su ficha. Errores en texto: `RESERVATION_NOT_OPEN` «Este retiro ya no admite apuntarse» y `RESERVATION_NOT_CONFIRMED` «Este retiro aún no está confirmado».
- **«Todos» nunca vale por un huésped:** Guests no pide nada con el `guest_id` de otro.

#### d) Organizador, staff y dirección en el retiro

- **Etiqueta** (`portal_role` de `portal_my_guest` y `portal_my_retreats`, BG14): «Organizas» (`organizer`) · «Equipo» (`staff`) · «Dirección» (`direccion`). Una píldora en «Tu retiro de un vistazo» (`#teamRole`), en su fila de «Mis retiros» y, con la familia junta, en la tarjeta de esa persona del Resumen («Nora · Equipo»). Nada más cambia de sitio.
- **Datos y firma** (G-B2, Core 26-10): sus fichas se ven en el modo `ninguno` (`teamMode`, `api.ts`): sin «Tus datos», sin firma y sin esas tareas; `#/p/<id>/datos` y `/firma` vuelven al Resumen.
- **Cama** (`portal_lodging.team: true`): con `choice: 'off'`, «La cama te la asigna el equipo» (`#lodgingTeam`) en lugar de la elección; con `choice: 'choose'` (camas de equipo marcadas, 0483), la elección de siempre entre las habitaciones que da Booking, sin plazo y confirmada al momento. `NOT_OFFERED` con `reason: 'team'` dice lo mismo que `'off'`.
- **Menú:** como un huésped (VG), pero nunca «Cocina tiene registrado…»: «Tu ficha de equipo no llega a cocina: si comes aquí, avisa tú en cocina.» (G-B1, Core 26-10). El cruce plato a plato sigue.
- **Outsider que viene como huésped:** ficha normal. Guests no enlaza a Tasks desde el portal (hoy no lo hace; TK1 sigue sin construir).

#### Enlace directo para Organizers (Gu1)

`https://guests.ikisai.com/#/r/<reservation_id>` (ya en `main`): con varias personas de la cuenta en ese retiro, la familia junta; con una, redirige a `#/p/<guest_id>`; con dirección y sin ficha, la vista de dirección (c). Sobrevive al pase común: `auth/sso` es un `fetch` dentro de `client.start()`, sin redirección.

#### Preguntas para VG (por Core; Core decidió las dos según la recomendación el 26-10, a falta de VG)

- **G-B1 · Menú de una ficha de equipo.** Sus restricciones no llegan a cocina (§29.4 de Booking), pero hoy el Menú dice «Cocina tiene registrado…». Opciones: (1) quitar esa línea y decir «Tu ficha de equipo no llega a cocina: si comes aquí, avisa tú en cocina»; (2) quitar también Alimentación de su ficha; (3) dejarlo igual. **Recomiendo (1):** el cruce con sus alergias le sigue avisando y nadie cree que cocina lo sabe.
- **G-B2 · Datos y firma de una ficha de equipo.** No van a SES. Opciones: (1) ocultar los datos de registro y la firma en sus fichas (quedan nombre y alimentación); (2) dejarlos opcionales; (3) igual que un huésped. **Recomiendo (1):** no pedir datos que no se usan.

**Pruebas:** `tests/guests/accesos.spec.ts` («Mis retiros», ficha de equipo y dirección).

### 9.18 «Tus ofertas de hoy» en el Menú (encargo de VG por Core, 27-10-2026)

Lo que le toca a cada persona, por día y servicio, de la lectura de portal de Food **`food.portal_offers`** (FD3, la misma para Guests y Organizers): `{reservation_id, offers: [{offer_id, name, kind: 'cerrado'|'carta', meal_groups, audience: 'huespedes'|'interna', days, services, place, payer, charge_when, lines}], days: [{date, services: [{type, time, included: [{offer_id, options}]}], cartas: [offer_id]}]}`.

- **El cruce con la persona lo hace Guests** (`offersForGuest`, `app/offers.ts`): una ficha ve las ofertas cuyo `meal_groups` contiene su `meal_group` (Booking, BG16, en `portal_my_guest`) y las que no tienen grupos.
- **Ofertas internas** (`audience: 'interna'`, decisión de VG por Core): solo a fichas de equipo asignadas (`portal_role` `staff` o `direccion`) de su grupo; nunca a un huésped ni al organizador. Llevan «Solo equipo».
- **Modo** (de Food): `payer = 'organizador'` → «Incluido» (todas las líneas de esa carta); huésped con `charge_when = 'barra'` → «De pago», con su precio; huésped con `charge_when = 'cuenta'` → «A cuenta».
- **Dónde:** en el Menú, bajo las pestañas de días, el bloque `#menuOffers` del día elegido («Tus ofertas de hoy» si es hoy): por servicio, lo incluido con sus opciones («Puedes elegir:»); después, «Además, en la carta» con las cartas del día (código, nombre y precio o «Incluido»). Un día con ofertas y sin menú también tiene pestaña. Con la familia junta, lo que no es de todos lleva «Para Ana».
- **Seguridad alimentaria (G13):** cada opción y cada línea se cruzan con lo que indicó cada persona (`hitsOf` y `crossings` del Menú) y llevan su línea de alérgenos de #597. Nunca «apto».
- **«A cuenta»:** «Abrir la carta» pide a Flow **`flow.portal_customer({reservation_id, guest_id})` → `{number, carta_url, account_open}`** (FL1): `carta_url` es un enlace de un solo uso que deja ese navegador como ese cliente, así que no se guarda en la caché y se pide en cada toque; se enseña «Tu número de cliente: N». El número lo da el encargado con «Dar número a los huéspedes» (decisión (c) de Core): sin número, «La barra aún no te ha dado número. Pídelo allí.» y no se abre nada; con número y sin `carta_url`, solo el número. La cuenta la abre caja cuando la persona lo pide (Core, 27-10): con `account_open`, «Tienes una cuenta abierta…»; sin ella, «Si quieres pagar al final, pide en caja que te abran una cuenta.». Sin la lectura o sin respuesta, la carta pública `https://flow.ikisai.com/` y «Tu número te lo da la carta al pedir.». Solo enlaces `https`. El número ligado a una ficha es un dato personal: nunca en capturas ni en fixtures.
- **Sin red:** las ofertas, de la caché como el menú; «Abrir la carta» necesita red.
- **Pruebas:** `tests/guests/offers.test.ts` (cruce, internas, modos, precio y enlace). La de Playwright llega cuando FD3 esté en `main`.

### 9.19 Visitantes por QR: ven.ikisai.com sin invitación (encargo de VG por Core, 27-10-2026)

VG aprueba `ven.ikisai.com` como puerta pública **sin invitación**. Quien escanea el QR de un evento entra como **visitante**: una identidad anónima del núcleo (`core.visitors`, contrato C11 de Core, migración 0096), con su token en el móvil y **ningún dato al entrar**.

**Contrato C11 (Core, 27-10)**
- **Token aparte, no sesión:** `POST /api/v1/public/visitor {event_code?}` → `{visitorId, token}`. El token se guarda en `localStorage` del portal (`ikisai-visitor`) y va en la cabecera `X-Visitor` en cada llamada pública. Sin bootstrap, sin ámbitos ni pertenencias: **un visitante nunca es miembro de nada**.
- **Escrituras, en la API del dueño:** cada app abre su escritura pública (`core.allow_public_write`) y la sirve en su propia Edge (`POST /api/v1/public/<nombre>`); el kit resuelve `X-Visitor` y la app pone `visitor_id` en la fila. `guests-api` no escribe en tablas de otros.
- **Lecturas, públicas con argumentos** (`event_code`), sin ámbito; las de «lo mío» reciben el `visitor_id` que resuelve el kit (`publicReadWithVisitor`), nunca el token. Como las lecturas registradas son globales, `guests-api` las sirve en sus rutas `public/…`.
- **Recuperación por correo y paso a otro móvil:** v2, no para el sábado.

**Reglas fuertes**
- Un visitante **nunca ve a otros** visitantes ni huéspedes.
- **Nunca se liga a un huésped de Booking por el nombre**; solo por un vínculo consentido: su enlace de invitación (`/i/<token>`) o un «Apuntarme» que acepta el personal.
- Lo que deja (nombre, correo, teléfono) es **voluntario**, con su para qué escrito al lado.
- Repo público: ejemplos y fixtures con nombres sintéticos y `example.invalid`.

#### Entrada (`/e/<código>`)

1. `main.ts` reconoce `/e/<código>` (10 caracteres, BG17; vale en mayúsculas o minúsculas), lo quita de la URL antes de pintar y abre `#/v/<CÓDIGO>`.
2. El evento sale de la lectura pública `booking_event` (BG19), que sirve el kit en `guests-api` como `GET public/booking_event?code=…`. Si el código no es de ningún evento: «Este código no es de ningún evento abierto», con el contacto público y sin decir si existió.
3. **Identidad de visitante:** con token en el móvil, se usa; si no, al tocar «Entrar» se crea (`POST public/visitor {event_code}`), sin pedir nada. Si el móvil tiene además una sesión de huésped, conviven: el evento se ve como visitante salvo que use «Ya tengo invitación».
4. El código se añade a la lista de **«Mis eventos» de este móvil** (`localStorage`, solo códigos; se borra con «Salir de este móvil»).

#### Evento del visitante (`#/v/<código>`)

- **Cabecera:** nombre, fechas, tipo («Retiro», «Jornadas abiertas», «Familiar»), estado («Abierto», «Cerrado») y el resumen público. Nada de precios ni del organizador.
- **Qué hay para comer** (FD5, lectura pública `food_visitor_offers` con `event_code`; `guests-api` la sirve en `GET public/offers?code=…`): solo las ofertas que quien las hace marca «Visible para visitantes (QR)», por día y servicio, con la pieza de §9.18 (`offersBlock`) y su línea de alérgenos. Sin restricciones de la persona, no hay cruce personal; sí el aviso «Si tienes alergias, pregunta en cocina».
- **«Mi pedido»** (Flow, FL2): «Abrir la carta» llama a `POST /api/flow/v1/public/visitor_join {event_code}` (el worker lo lleva a flow-api, con `X-Visitor`: crea o encuentra su cliente, sin cuenta, idempotente) y abre su `carta_url` de un solo uso; «Mi pedido» se pinta con la lectura pública `flow_visitor_customer` (`{number, carta_url, account_open, orders: [{number, status: open|paid|delivered, summary, preparing}]}`, con el `visitor_id` del kit). Sin flujo que atienda la carta del evento (404 `NO_FLOW`), «Este evento no tiene carta ahora mismo»; sin Flow, la carta pública. Sin número todavía: «Aún no tienes número: lo tendrás al abrir la carta». Con cuenta abierta, «Tienes una cuenta abierta»; si no, «Si quieres pagar al final, pide en caja que te abran una cuenta».
- **«Apuntarme»** (si `joinable`, BG18): `POST /api/v1/public/join` de **booking-api** (tabla `booking.visitor_requests`, de Booking) con `{event_code, name, contact?}`: «¿Cómo te llamamos?», obligatorio solo aquí; correo o teléfono, opcionales y con su para qué. Queda «Pedido · pendiente» hasta que el personal lo acepta (`booking.join_from_visitor`), y entonces la ficha queda ligada a este visitante por esa petición. Lo pendiente sale de la lectura pública `booking_visitor_requests` (con el `visitor_id` que pone el kit). El worker de Pages lleva `/api/booking/v1/public/*` a booking-api y reenvía `X-Visitor` (sin la sesión del huésped); las pruebas hacen lo mismo en `tests/guests/server.ts`.
- **«Déjanos un dato»** (opcional, sin apuntarse): el correo para avisarle de la próxima jornada, con su para qué; la misma ruta con `kind: 'contact'` (Core, 27-10), que vale en cualquier evento vivo.
- **Forma (Booking #770):** `POST public/join {event_code, kind: 'join' | 'contact', name?, contact?, note?}` con `X-Visitor` → la petición `{event_code, kind, name, status, created_at}`; una pendiente por visitante, evento y tipo. «Lo suyo»: `GET public/join?event_code=…` → `{items: [{event_code, kind, name, status, created_at, decided_at}]}`; el contacto no sale nunca. Estados: «Pendiente», «Aceptada» (join), «Atendida» (contact) y «Descartada». Nombre, contacto y nota se borran a los 6 meses del fin del evento, y la pantalla lo dice junto al campo.
- **«Ya tengo invitación»:** abrir su enlace personal (`/i/<token>`). Es el vínculo consentido con su ficha de huésped.

#### «Mis eventos» (`#/v`)

- Código en `apps/guests/src/app/visitor.ts` y `ui/visitor.ts`; prueba `tests/guests/visitantes.spec.ts`.
- Los eventos de la lista de este móvil, por momento (en curso, próximos y pasados, la pieza de «Mis retiros», §9.17), cada uno releído con `public/event`, con su estado y el de su «Apuntarme».

#### Salir y, en la v2, guardar y mover

- **Salir de este móvil:** borra el token, la lista de eventos y la caché del visitante.
- **v2:** recuperar por correo (enlace) y pasar a otro móvil con un código de un solo uso (C11, más adelante). Hasta entonces, la pantalla dice que el acceso vive solo en ese móvil.

#### Sin red

El evento, sus ofertas y «Mis eventos», de la caché del visitante con la hora de los datos. Entrar, apuntarse, dejar un dato y «Abrir la carta» necesitan red.

#### Lo que necesita Guests

| Id | De | Qué | Estado |
|---|---|---|---|
| C11 | Core | `core.visitors`, `POST public/visitor`, `X-Visitor`, `resolveVisitor`, `publicReadWithVisitor` | contrato fijado; PR core/visitantes (0096) |
| BG17 | Booking | `booking.events.public_code` | en #767 (0488) |
| BG18 | Booking | `POST public/join` en booking-api (`booking.visitor_requests`), su «lo mío» y `join_from_visitor`; origen de Guests admitido | tras C11 |
| BG19 | Booking | lectura pública `booking_event` | en #767 (0488); la sirve el kit |
| FD5 | Food | lectura pública `food_visitor_offers` con `event_code`, solo ofertas `public` | en #758 |
| FL2 | Flow | `flow.visitor_join` (acción) y `flow.visitor_customer` (lectura), con `flow.customers.visitor_id` | tras C11 |

### 9.20 Indicadores para Dirección (P7 de Central, encargo de Core del 27-10-2026; migración 0601)

`guests.central_kpi_projection`, con el contrato de Central (`docs/central/API.md` §7.2). Solo la lee el owner de Central (`core.allow_read('central', …, '{owner}')`). Son agregados de `booking.guests_kpi_projection`, que publica Booking: una fila por reserva confirmada o en ejecución, sin nombres. No cuentan la huésped de muestra ni las fichas de equipo. Todas las claves son `period = 'actual'`, con «hoy» en Madrid.

- **Retiros de ahora:** los que no han terminado y empiezan en los próximos 30 días.
  - `guests.portal_entered_pct` (`pct`, ↑) y `guests.portal_entered` (`persons`, ↑): los que han entrado al portal, es decir, han aceptado el aviso de protección de datos (`privacy_ack_at`).
  - `guests.signatures_done` (↑) y `guests.signatures_pending` (↓), en `persons`: partes firmados y sin firmar.
  - `guests.retreats_signatures_pending` (`count`, ↓): retiros con algún parte sin firmar.
- **Retiros recientes:** los que empezaron en los últimos 30 días.
  - `guests.ses_sent_30d` (`persons`, ↑): partes enviados a SES.
  - `guests.retreats_ses_pending` (`count`, ↓): retiros con llegadas sin comunicar.
- **Pruebas:** `tests/guests/kpis.test.ts`.
### 9.21 Entrada pública sin invitación ni QR (ENTRADA_PUBLICA.md, tarjeta 1; VG por Core, 27-10-2026)

- **Pantalla de entrada sin sesión y «Mis eventos» vacío:** muestran «Eventos abiertos», sacados de la lectura pública de Booking `booking_public_events`. Son los eventos abiertos al público y los retiros con «Apuntarme». Cada uno lleva su tipo en texto, «Apuntarme» si se puede y «Con alojamiento» si ofrece noches.
- **Al tocar un evento:** se abre su página de visitante (`#/v/<código>`). Mirar no crea identidad; se crea al «Entrar».
- **Sin eventos o sin red:** una línea que lo dice.
- **«Dormir aquí»** (tarjeta 2; Booking 0498 y 0499). Sale en la página pública del evento cuando ofrece noches.
  - **Mirar:** se eligen la llegada, la salida y las personas. Se ven las modalidades con su precio por noche y el total, si cabéis, y las plazas que quedan **todas** esas noches (`booking_public_lodging`). Mirar no pide datos ni crea identidad.
  - **Pedir:** al «Elegir» una modalidad sale el resumen y cómo se paga. Con `hold`, la plaza se guarda N horas y se paga en recepción; con `pay_first`, no se guarda hasta pagar. Se pide lo mínimo: el nombre, y el contacto y la nota si se quieren.
  - **Enviar:** «Pedir las noches» va a `POST /api/booking/v1/public/stay`; ahí se crea la identidad, porque es un gesto. Una solicitud nueva sustituye a la anterior.
  - **Seguimiento:** en «Lo que has pedido» se ven las noches, las personas, el total y hasta cuándo se guarda la plaza, o que el plazo ya pasó.
  - **Errores:** `NO_AVAILABILITY` (`409`), `NO_LODGING` e `INVALID_FIELDS`, cada uno con su texto.
- **«Alójate aquí»** (VG, por Core: el alojamiento funciona como la barra; Booking, encima de 0499).
  - **Dónde sale:** en una pestaña del visitante que solo se abre en el móvil que entró por el QR del evento (`/e/<código>`) o por la carta de Flow (`/e/<código>?alojate&v=<código>`). Con `v`, se canjea el traspaso de la misma identidad (`POST public/visitor/handoff/redeem`, núcleo 0106), que es de un solo uso.
  - **Noches y cama:** llegada, salida y las camas libres **todas** esas noches (`booking_public_beds`), o «Asignadme una», que es lo que sale marcado.
  - **Tus datos:** van en borrador. Solo el nombre es obligatorio; el documento hace falta para dormir, no para pedir.
  - **«Ir a pagar»:** `POST public/stay`, que deja la estancia `por_pagar` con su número, como en la barra, y «Ve a recepción y di tu número para pagar».
  - **Cuando recepción cobra:** la pantalla pasa a «Esta noche duermes en {habitación} · {cama}» (`booking_visitor_stay`, que se consulta cada 20 s con la pantalla a la vista).
  - **Completar mis datos:** está disponible mientras no esté alojado (`POST public/stay/traveler`).
  - **Caducada:** se dice, y se puede pedir otra vez.
  - **«Ver las camas en el plano»** (VG, 27-10-2026: sin sesión, nunca): está plegado. Al abrirlo se crea la identidad de visitante si aún no la había (es un gesto), se anota la visita y se pide `GET /api/v1/public/plans?event_code=…` a guests-api.
    - **Qué exige la ruta:** `X-Visitor` (si no, `401`), que el evento ofrezca noches y que el visitante haya entrado en él (`403`).
    - **Qué devuelve:** el mismo mapa que `GET plans`, con los dibujos firmados. Lee `resources.portal_plans`, registrada solo para código de Edge (Recursos 0817).
    - **Qué se ve:** las camas libres todas esas noches se tocan para elegir; las demás salen ocupadas. Ningún dato de personas.
  - **Reservar antes de venir:** la solicitud anterior, con `hold` o `pay_first`, queda plegada como opción secundaria.
- **«Guarda tu acceso» del visitante** (tarjeta 3; núcleo C11 v2, 0106). Es un bloque plegado en «Mis eventos» y en cada evento.
  - **Guardar:** con un correo, opcional, y el código de un solo uso que llega a ese correo, el acceso de este móvil queda guardado (`public/visitor/email` y `email/verify`).
  - **Recuperar:** en otro móvil, el mismo correo recupera el acceso. Si el correo ya guardaba otro, este móvil pasa a él.
  - **Lo que se enseña:** solo la pista del correo (`public/visitor/me`) y «Quitar el correo». El núcleo nunca dice si un correo existe.
  - **Salir de este móvil:** también revoca el token de este móvil (`public/visitor/logout`).
- **Vínculo visitante ↔ huésped** (tarjeta 4; núcleo 0106 con `booking.visitor_claim`). Nunca se empareja por el nombre.
  - **«Tu ficha está lista: entrar»:** sale en una petición aceptada que ya tiene ficha. `public/visitor/claim` une este visitante a la ficha y da un enlace de un solo uso.
  - **«Unir este móvil a mi ficha»:** sale en el Inicio del huésped si el móvil también entró como visitante. Usa `POST /api/v1/visitor-link` con la sesión y el `X-Visitor` de este mismo móvil, y «Deshacer» usa `DELETE`. «Ahora no» lo esconde en este móvil.
- **Pruebas:** `visitantes.spec.ts`.

## 10. Offline

Guests **no tiene espejo**: no tiene tablas propias, y las acciones de Booking no van por la cola de `sync-client`. Comportamiento:

- **Base:** `sync-client` 0.5 con `tables: []`, para la sesión, la renovación, la sesión única, `api()`, `loginWithLink` y `onSessionEnd`.
- **Lecturas con caché** en IndexedDB por persona (`guests-cache`: clave = lectura + `args` + idioma, con la hora).
  - Sin red se pinta lo último con el aviso «Sin conexión · datos de las 18:40».
  - Lo que importa durante la estancia (información práctica, contacto y, en la fase 4, programa, menú y alojamiento) se precarga al abrir Inicio con red.
  - La caché de la ficha lleva datos personales del propio huésped: solo vive en su dispositivo y se borra en `onSessionEnd` y con «Salir de este dispositivo».
- **Escrituras con cola local propia** (por persona, en IndexedDB): campos de datos, lista de alimentación, consentimiento, acuse del aviso y firma.
  - Se envían en orden al volver la red, con `expectedRevision`.
  - **Nada se da por guardado hasta que Booking responde.** La interfaz distingue «guardado», «pendiente» y «error».
  - Los conflictos se resuelven como en §9.4.
- **Lo que reserva o cobra** (elegir habitación, fase 5), **solo con red**: el botón queda desactivado con «Necesitas conexión para reservar».
- **Service worker:** precarga la cáscara de la app y los diccionarios de los dos idiomas.

## 11. Aceptación

### 11.1 Recorrido

1. El organizador envía el enlace de un asistente desde Organizers. El huésped lo abre en Android: entra sin contraseña y el token desaparece de la URL.
2. Ve el aviso de protección de datos de Central y pulsa «Entendido». Booking guarda la versión y la hora.
3. Inicio dice qué retiro es, cuándo y qué falta: «Tus datos · faltan 5», «Alimentación», «Firma · primero completa tus datos».
4. Ve con la marca «Lo indicó tu organizador» el apellido que escribió el organizador. Lo corrige: se guarda solo y la marca desaparece; en Organizers pasa a «Rellenado ✓», sin el valor.
5. Completa el documento y la dirección sin pulsar «Guardar». Cada campo muestra «Guardado ✓» y Booking los ve con procedencia «huésped».
6. Añade una alergia grave a los frutos secos y activa el interruptor: aparece con su nombre en la cocina de Organizers. Lo desactiva: solo en los totales.
7. Firma con el dedo. Booking ve la firma y el organizador ve «Firmado ✓».
8. Un menor de 12 años: la pantalla de firma pide la de quien le acompaña, con su nombre prellenado.
9. Una reserva en modo `operativo` solo pide nombre, apellido y contacto, sin firma. En modo `ninguno` no aparece «Mis datos».
10. Sin red: rellena dos campos («Se guardará al volver la conexión») y la información práctica se ve con el aviso de la hora. Al volver la red se guardan solos.
11. El organizador cambia el teléfono mientras el huésped lo edita: el huésped ve los dos valores y elige.
12. Con el teléfono en inglés todo sale en inglés, incluidas las fechas. Un texto de Central sin traducir sale en español con la nota.
13. Una cuenta con dos entradas (madre e hijo) ve a la familia junta («Todos»: lo que falta de cada una) y cada ficha por separado con el selector; nunca a otros huéspedes.
14. «Necesito ayuda» durante la estancia: un «Baños · Agua o electricidad» llega a Tasks; un «Mi retiro · Horarios» va al organizador. Los dos se ven en «Lo que me has enviado».
15. Enlace revocado o caducado: pantalla con el motivo y el contacto de Ikisai.

### 11.2 Pruebas automáticas

- **`tests/guests/*.test.ts`** (PGlite, como Booking y Organizers):
  - sin la suite de conformidad de `packages/test-kit`, que necesita una tabla sincronizable propia (como Organizers);
  - canje del enlace;
  - `portal_my_guest` y las cuatro acciones por `guests-api`, dentro y fuera de ámbito (otro `guest_id` de la misma reserva → `OUT_OF_SCOPE`);
  - subida de la firma al bucket `guests-documents`, y que una firma subida por otra cuenta se rechaza;
  - modo `operativo` y `ninguno`;
  - ids literales de feedback en el catálogo.
- **Playwright** (`tests/guests/*.spec.ts`, contra `guests-api` y `booking-api` reales sobre PGlite, como Organizers), en móvil y escritorio:
  - recorrido 1–9;
  - token fuera de la URL;
  - autoguardado con estados;
  - sin red con la cola y la caché;
  - `VERSION_CONFLICT`;
  - inglés;
  - menor;
  - varias entradas;
  - ningún dato de otro huésped en el DOM.

## 12. Reparto entre agentes y estado

**Construido (7-10-2026, #283):** Edge, migración 0600 y la PWA de la fase 1 entera:
- entrada, aviso legal, Inicio según el momento y selector de persona;
- Mis datos con autoguardado y conflictos;
- alimentación, firma, información práctica, ayuda, «Guarda tu acceso» e instalación;
- español e inglés;
- offline con cola local (`writer.ts`).

Detalles de la implementación:
- **Idioma:** `createI18n` y `createLanguageSelect` del kit 0.19 (#285), con los diccionarios de la app en `app/i18n-es.ts` e `i18n-en.ts`. Los textos del kit (lanzador y formulario de ayuda) también cambian de idioma.
- **Recuadro de firma:** propio en `ui/sign.ts` (U2 sigue abierta por si el kit lo adopta).
- **Textos de Central** (migración 0570): una fila por clave e idioma, con `fallback` y `source_lang`, y negritas con `**…**`.
  - La versión que se guarda al aceptar el aviso (`privacy_ack_version`) o al firmar (`text_version`) es `<idioma de origen>-<versión>` (`es-v1`, `en-v1`).
  - Aceptar en un idioma vale para el otro mientras las dos versiones sigan vigentes.
  - Sin Central se usan los textos de reserva del código, con la versión `reserva-1`.

**Fases 4 y 5 (8-10-2026), construidas con lecturas simuladas** (respuesta de Core: construir lo que depende de Guests y conectar cada pieza cuando llegue):
- `app/portal.ts`: lecturas y acciones con la forma de §13, en caché por persona. Una lectura que aún no existe en el servidor devuelve `null` y Guests sigue como en la fase 1.
- **Barra inferior propia** según los módulos visibles y su ventana (`ui/nav.ts`), y pantalla «Más».
- **Programa y menú** con «Hoy en Ikisai» (`ui/program.ts`).
- **Materiales** con `portal-files` y «Guardar para verlo sin conexión» en la caché del navegador, como mucho 20 MB por persona y borrados al salir (`ui/materials.ts`).
- **Preguntas** con autoguardado en la cola (`ui/questions.ts`; operación `answer` de `writer.ts`, que no toca la revisión de la ficha de Booking).
- **Alojamiento** (`ui/lodging.ts`): ver, preferir, elegir o pedir, con confirmación, `BED_TAKEN` y solo con red.
- **Vista previa:** con `preview` en la entrada de ámbito (enlace real del núcleo, #325), franja y solo lectura: la cola no encola nada.
- **Inicio:** mensaje del organizador, preguntas pendientes y «Elige tu habitación».
- **Pruebas:** `tests/guests/modules.spec.ts`, 5 de Playwright con las lecturas simuladas por `page.route` y el reloj fijo (`page.clock`), para no depender de la hora.

**Conectado a la API real (8-10-2026):**
- **Programa:** `booking.portal_program` (Booking #328, §23).
- **Alojamiento:** `booking.portal_lodging`, `portal_choose_bed`, `portal_release_bed` y `portal_room_preference` (Booking §23.1). Los ajustes son de Booking: `choice`, `choose_until`, `open` y `preferences`. De Organizers solo se usa la nota de precio (`guest_price_text`).
- **Menú:** `food.portal_menu {reservation_id, guest_id}` (Food #327, §7.5). Guests solo ve menús validados. Los platos llevan descripción pública, etiquetas de dieta y **siempre** los alérgenos declarados (tanda 26). Si la receta no está revisada (`allergens_checked` falso), se añade «sin revisar por cocina», también cuando no declara ninguno. Cada plato se cruza con lo que indicó **cada persona** que lo ve (G13), con `crossRestriction` del dominio de Food: «⚠ Lucía: lleva frutos de cáscara» para alergias e intolerancias, «Ana: lleva cilantro (preferencia)» como información. Lo declarado avisa esté revisado o no, y el texto del plato también cuenta. Con la familia junta, «Cocina tiene registrado…» va persona a persona y con su nombre. Nunca «apto».
- **El lugar:** `central.portal_place_projection` (Central #326, §2.9): dirección del lugar (nunca la fiscal), enlace del mapa y plano (imagen o PDF) con `portal-files`. Es información de Ikisai: sale siempre en Información.
- **Vista previa** con el enlace `preview: true` del núcleo (#325).

- **Organizers** (#333): `guest_experience_for`, `guest_materials` (archivos con su resolutor real de `portal-files`), `guest_questions` y `guest_answer`, con la forma de §13.
  - `app/normalize.ts` acepta además la forma por filas de `docs/organizers/API.md` §15, por si cambia.
  - **Las respuestas se guardan** desde que entró K6 del núcleo (#334): una acción de Organizers invocada desde Guests escribe en `organizers.*`.
- **Navegación con la barra del kit 0.21 (U5):** `createAppShell({ maxNav: 5 })` y `setNav(nav, more)` por persona; los días, con `createDayTabs`. Sustituye a la barra propia y a la pantalla «Más».
- **Fotos de los platos** (Food #332): miniatura por `portal-files`.
- **Supletorias** (BG13, Booking #491, §25): las activadas por el organizador salen en la elección de cama con la marca «Supletoria» y su recuento aparte; las no activadas no salen.

**Pruebas:**
- `tests/guests/api.test.ts` (8);
- `tests/guests/static.test.ts` (6): diccionarios iguales, claves usadas y ids de feedback;
- `tests/guests/portal.spec.ts` (9 de Playwright, 3 de ellas `@smoke`) y `modules.spec.ts` (6, 1 de ellas `@smoke`, todo contra la API real); `normalize.test.ts` (3).



Lo hago yo: `supabase/functions/guests-api` (índice y conformidad), `apps/guests`, `tests/guests` y `docs/guests`. Con subagente (`sonnet`), solo lo mecánico:
- los escenarios de Playwright a partir de uno aprobado;
- el diccionario inglés a partir del español, que reviso yo.

**Orden de las PR:**
1. Edge, conformidad y pruebas de ámbito.
2. Entrada, aviso, Inicio y Mis datos con autoguardado.
3. Alimentación y firma.
4. Información práctica, ayuda, «Guarda tu acceso», idioma y offline.

## 13. Fases 4 y 5 · experiencia configurable y decisiones del huésped (G2, diseño)

Base:
- `PORTALES_V2.md` §4 y §6 (decisiones del usuario del 7-10-2026);
- la propuesta original (`portales_v2/03_AGENTE_GUESTS.md` §5 a §12);
- el contrato con Organizers (`docs/organizers/API.md` §13.4 y §13.5).

Reparto: **Organizers configura y Guests pinta**. Cada dato tiene un solo dueño y Guests no guarda copias:

| Dato | Dueño | Guests |
|---|---|---|
| Qué módulos ve el huésped y qué puede hacer en cada uno | Organizers (`organizers.guest_experience`) | lee `organizers.guest_experience_for` |
| Programa del retiro | Booking (lo edita el organizador con acciones de Booking) | lee `booking.portal_program` |
| Menú publicado | Food | lee `food.portal_menu` |
| Materiales del organizador | Organizers (`organizers.materials`, archivos en `core.files`) | lee `organizers.guest_materials`; el archivo, por `portal-files` (§13.5) |
| Preguntas del organizador y respuestas | Organizers | lee `organizers.guest_questions` y escribe `organizers.guest_answer` |
| Habitaciones, camas y quién duerme dónde | Booking | lee `booking.portal_lodging` y escribe `booking.portal_choose_bed` y `portal_room_preference` |
| Mapa, plano e información de Ikisai | Central | textos `info.*` y plano público (§13.4) |

**Lo de Ikisai no se configura.** Los datos del registro, la alimentación, la firma, el aviso legal, la información práctica y la ayuda están siempre, con independencia de lo que elija el organizador.

**Ofertas del organizador:** no se muestran en Guests (decisión del usuario confirmada por Core el 7-10-2026). Sobra `organizers.guest_offers`.

### 13.1 Configuración de la experiencia y navegación

**Lectura** `organizers.guest_experience_for({reservation_id})` (de Organizers, registrada para `guests`, con el ámbito del huésped):

```text
{ revision,
  modules: {
    program:       { visible, window },
    menu:          { visible, window },
    materials:     { visible },                       la ventana va en cada material
    questions:     { visible },
    lodging:       { visible, capability, choose_until, options[] },
    map:           { visible },
  },
  organizer_message: { text, lang } | null           bienvenida del organizador para Inicio (opcional) }

window      = 'before' | 'during' | 'after' | 'always'    (por defecto 'always')
capability  = 'view' | 'prefer' | 'choose' | 'request'     (solo alojamiento, fase 5)
options[]   = [{ key, label, guest_note }]                   tipos de habitación que ofrece (§13.7)
```

- **Sin configuración**, Guests se queda como la fase 1: Inicio, Mis datos, Alimentación, Firma, Información y Ayuda.
- **Ventanas:** se calculan con las fechas de la reserva en hora de Madrid (`momentOf` de Inicio): antes, durante y después del retiro.
- **Navegación:** desde O4a (§9.12), los módulos visibles son **secciones de la pestaña del retiro**: **Resumen** · **Programa** · **Menú** · **Alojamiento**, en el mismo orden que la barra de antes y con los mismos toques.
  - Lo que no está activo no aparece; sin módulos, solo el Resumen y sin secciones.
  - «Más» (en la barra «Calendario · Retiros · Más») agrupa Información, Materiales, Preguntas, Mis datos, Alimentación y Firma del retiro que se ve.
  - En escritorio, la barra pasa a lateral (`createAppShell` con `nav`).
- **Inicio según el momento:**
  - **Antes:** la lista de lo que falta, más «Preguntas de tu organizador» si hay preguntas obligatorias sin responder y «Elige tu habitación» si hay elección abierta. Debajo, «Tu retiro» con lo que esté publicado.
  - **Durante:** «Hoy en Ikisai» con lo que está pasando y lo siguiente del programa, la próxima comida, mi habitación y «Necesito ayuda».
  - **Después:** «Gracias por venir», los materiales de después y «Cuéntanos qué tal».
- **Vista previa para el organizador** (propuesta): un **huésped de muestra** por reserva, que crea Booking.
  - Lleva `preview = true`, no cuenta en la completitud ni va a SES, y se borra con la reserva.
  - El organizador lo abre en Guests con un enlace que emite Organizers (`portal-links` con ese `guest_id`).
  - Ve exactamente lo que verá un huésped, sin duplicar pantallas en Organizers.
  - Las escrituras de ese huésped se rechazan con `PREVIEW_READ_ONLY`, y Guests muestra una franja «Vista previa: no se guarda nada».
  - **Hecho en el núcleo (#325, contrato §3.6):** el enlace de Guests emitido con `preview: true` marca la entrada de ámbito con `preview`, y el kit rechaza cualquier escritura. Guests lo lee de `scopes.grants[].preview`: muestra la franja y no encola nada.
  - Alternativa, si Organizers prefiere pintarla él: las mismas lecturas sobre datos ficticios. Lo deciden Core y Organizers (petición O6).

### 13.2 Programa (fase 4)

**Dueño: Booking.** Petición BG9. El organizador lo edita desde Organizers con acciones de Booking; el personal, desde Booking.

```text
booking.program_items        sincronizable, ámbito por evento
  event_id      uuid → booking.events (inmutable)
  day           date not null                  dentro de las fechas de la reserva
  starts_at     time null                      sin hora = «durante el día»
  ends_at       time null
  title         text not null (≤ 120)
  space_id      uuid null → booking.spaces     espacio de Ikisai (se muestra su nombre público)
  place_text    text null (≤ 80)               lugar libre si no es un espacio («Excursión al pinar»)
  public_note   text null (≤ 500)              lo que ve el huésped
  internal_note text null                      solo personal y organizador
  kind          text default 'actividad'       actividad | comida | descanso | otro
  optional      boolean default false          reservado para elegir entre talleres (más adelante)
  position      numeric
```

- **Lectura** `booking.portal_program({reservation_id})` para `guests` y `organizers`: `{revision, items: [{id, day, starts_at, ends_at, title, place, public_note, kind}]}`.
  - Sin `internal_note`.
  - `place` es el nombre público del espacio o `place_text`.
  - Los huéspedes solo la ven si el módulo está visible: Booking no lo comprueba, porque no es un dato sensible, y lo filtra la interfaz.
- **Comidas en el programa:** el horario de las comidas lo pone el menú de Food (`service_time`). El programa puede llevar `kind = 'comida'` sin duplicar los platos; Guests junta las dos fuentes en «Hoy».
- **En Guests:**
  - pestaña Programa con los días como pestañas horizontales (el de hoy, seleccionado durante el retiro) y las actividades en lista por hora;
  - en «Hoy», «Ahora» y «Lo siguiente»;
  - en caché para verlo sin cobertura.

### 13.3 Menú (fase 4)

**Dueño: Food.** Petición FD1. Guests no se convierte en Food: solo enseña lo publicado.

- **Lectura** `food.portal_menu({reservation_id})` para `guests` y `organizers`:

  ```text
  { status: 'provisional' | 'confirmado',
    services: [{ date, type, time, dishes: [{ name }] }] }
  ```

  - Es `provisional` con el menú en `borrador` o `revisar`, y `confirmado` con `validado` o `cerrado`.
  - Sin raciones, recetas, ingredientes, avisos ni notas internas.
  - Sin menú, `{status: null, services: []}`.
  - Para comprobar el ámbito, Food necesita saber a qué reserva pertenece el evento: `reservation_id` en `booking.food_event_projection` (petición BG12 a Booking).
- **Ámbito:** el `reservation_id` está en las entradas del actor (`scopes.grants`). Si no, `OUT_OF_SCOPE`.
- **Nombre del plato:** es el nombre de la receta (`food.recipes.name`). Si Food quiere un nombre «para el público» distinto del interno («Curry adaptado 2»), un campo `public_name`, opcional en FD1.
- **En Guests:**
  - pestaña Menú por días, con desayuno, comida y cena y la hora;
  - la marca «Provisional» mientras no esté confirmado;
  - el texto de Central «El menú puede cambiar para adaptarse a alergias e intolerancias» (clave nueva `guests.menu_notice`, petición CE3);
  - **sin promesas clínicas:** si el huésped tiene restricciones, «Cocina tiene registrada tu alergia a frutos secos», nunca «este plato es apto».
- **Comentarios del organizador sobre el menú:** son de Organizers con Food y no se muestran a los huéspedes.

### 13.4 Mapa, plano e información (fase 4)

**Dueño: Central** (información de Ikisai). Petición CE3:
- **Clave `info.map_link`:** enlace a la ubicación en un mapa externo. Se abre fuera de la app.
- **Plano del centro:** una imagen de Central (por ejemplo `central.entity.site_plan_file_id`), servida con `portal-files` (§13.5) o sin sesión, como el contacto público. Guests la guarda en caché para verla sin cobertura.
- **Espacios en el plano** (más adelante): si Booking da a cada espacio una posición en el plano, el programa puede señalar dónde es cada actividad. No entra en esta fase.

**Información práctica:** ya existe (§9.7). Con el módulo «Mapa» visible, la pantalla de Información añade arriba el plano y el enlace.

### 13.5 Materiales del organizador (fase 4) y cómo se sirven sus archivos (O1)

**Dueño: Organizers.**

- **Lectura** `organizers.guest_materials({reservation_id})`:

  ```text
  items: [{ id, kind: 'file' | 'link' | 'text', title, description, window,
            file?: { id, name, mime, size }, url?, body? }]
  ```

  Solo los publicados, en la ventana actual.
- **Problema (O1):** el archivo vive en `core.files` con `app = 'organizers'`. Desde SQL no se puede firmar una URL de R2 ni de Supabase. Y el `files/:id` de `guests-api` solo ve archivos de Guests subidos por la propia persona (C7).
- **Propuesta de diseño (para que decida Core):** **archivos publicados a un portal**, un mecanismo genérico del núcleo y del kit:
  1. La app dueña registra un **resolutor**: `core.allow_portal_file('guests', 'organizers.guest_material_file')`. Es una función `fn(p jsonb) returns boolean` que recibe `{app, actor, args: {file_id}}` y dice si ese actor puede ver ese archivo. En Organizers: el material está publicado, en ventana y es de una reserva de su ámbito.
  2. El kit monta en cada portal `GET /api/v1/portal-files/:fileId`. Prueba los resolutores registrados para ese portal y, si alguno dice que sí, firma una URL de 5 minutos con `createStorage(supabase).readUrl(fila)`. Así funciona igual con R2 y con Supabase.
  3. **Respuesta:** `{url, expiresAt, name, mime, size}`. Fuera de ámbito, o no publicado: `404 FILE_NOT_FOUND`, como si no existiera.
  4. Lo mismo sirve después para el plano de Central (§13.4) o para un documento de Booking.

  **Aprobado y hecho por Core (#325):** `core.allow_portal_file(portal, 'schema.fn')` con `fn(p_ctx jsonb {actor, portal, file_id, scopes}) returns boolean` y `GET /api/v1/portal-files/:fileId`. Los materiales no admiten SVG (pueden llevar código); el logotipo, en PNG o WebP.

  **Por qué así y no una lectura que devuelva URL firmadas:** la lectura (`read/…`) es SQL y no puede firmar. Firmar todas las URL al listar haría caducar enseguida las que no se abren. Y un resolutor por app mantiene la regla «la app dueña decide quién ve su dato».
- **En Guests:**
  - pestaña o entrada «Materiales» con lista por tipo (documento, enlace o texto) y el título y la descripción del organizador;
  - al abrir un archivo, `portal-files` y se abre la URL;
  - **«Guardar para verlo sin conexión»** en los PDF y las imágenes (como mucho 20 MB por huésped): se descarga y se guarda en la caché del navegador, por persona, y se borra en `onSessionEnd`;
  - los enlaces de grupos (WhatsApp o Telegram) son un `link` más.

### 13.6 Preguntas del organizador (fase 4)

**Dueño: Organizers** (`organizers.questions` y `organizers.answers`). Las respuestas son datos que el huésped da a su organizador: no van a Booking salvo que sean operativas, y ese caso ya lo cubren los campos de Booking.

- **Lectura** `organizers.guest_questions({reservation_id, guest_id})`:

  ```text
  items: [{ id, revision, type: 'text' | 'choice' | 'multi' | 'yes_no' | 'number' | 'date',
            label, help, options: [{ value, label }], required, open: boolean,
            answer: { value, revision, updated_at } | null }]
  ```

  `open` es `false` fuera de la ventana de respuesta: entonces la respuesta se ve, pero no se cambia.
- **Escritura** `organizers.guest_answer({guest_id, question_id, value, expectedRevision?})`:
  - crea o actualiza la respuesta, con procedencia «huésped» y el usuario del portal como actor;
  - devuelve `{revision}` (como BG2);
  - errores:
    - `QUESTION_CLOSED` (fuera de ventana);
    - `INVALID_ANSWER` (tipo u opción no válidos);
    - `VERSION_CONFLICT`;
    - `OUT_OF_SCOPE`.
- **En Guests:**
  - pantalla «Preguntas de tu organizador», con autoguardado por respuesta en la misma cola local (`writer.ts`, operación nueva `answer` hacia otra app);
  - aviso fijo: «Tu organizador verá tus respuestas»;
  - las obligatorias sin responder entran en «Lo que te falta» de Inicio.
- **Conservación (decisión del usuario, 8-10-2026):** las respuestas de los huéspedes se borran a los **6 meses del fin del retiro**, como el resto de sus datos y como promete el aviso de protección de datos. Las preguntas y la configuración pueden quedar como plantilla del organizador. Lo hace Organizers.
- **Límites recomendados a Organizers:**
  - no preguntar por salud, alergias ni documentos, porque ya lo cubre Ikisai con su consentimiento;
  - un aviso en su editor si el texto de una pregunta parece pedirlos.

### 13.7 Alojamiento: ver, preferir o elegir habitación (fase 5)

**Dueño: Booking** (camas y asignaciones, §15.1). Decisiones del usuario:
- las habitaciones de 2–4 plazas con baño son extras que **Ikisai factura al organizador**;
- el organizador decide si se ofrecen a los huéspedes y qué les dice del precio.

**Lo que ve y hace el huésped** según `modules.lodging.capability`:

| Capacidad | Guests |
|---|---|
| `view` | «Tu habitación»: nombre público, zona y cama, si está asignada; si no, «Te diremos tu habitación antes de llegar» |
| `prefer` | además, «¿Con quién te gustaría compartir habitación?» (texto, ≤ 200) y «Necesito planta baja o accesible» (sí/no); lo ven el organizador y el personal al asignar |
| `choose` | elige cama entre las habitaciones de su retiro que el organizador ha abierto a elección; se confirma en el momento |
| `request` | como `choose`, pero queda «Pendiente de que tu organizador lo apruebe» hasta que lo aprueba desde Organizers |

**Lecturas y acciones de Booking** (petición BG10):
- **`booking.portal_lodging({reservation_id, guest_id})`** para `guests`:

  ```text
  { mine: { space_name, zone, bed_label, status: 'confirmed' | 'requested' } | null,
    preference: { text, ground_floor } | null,
    rooms: [ { space_id, name, zone, kind, en_suite, beds_total, beds_free,
               option_key,                       tipo de habitación del organizador (§13.1 options)
               beds: [{ bed_id, label, kind, free }] } ] }
  ```

  - `rooms` solo con `choose` o `request`, y solo las habitaciones que el organizador ha abierto a elección en esa reserva.
  - Nunca nombres de otros huéspedes: solo libre u ocupada.
- **`booking.portal_choose_bed({guest_id, bed_id, expectedRevision?})`**, reserva atómica:
  1. bloquea la fila de la cama (`select … for update`);
  2. comprueba que está libre en todas las noches de la reserva (la invariante `BED_OVERBOOKED` ya existe y se mantiene);
  3. sustituye en el mismo lote la asignación anterior del huésped en ese evento;
  4. escribe `source = 'guest'` y `status = 'confirmed'`, o `'requested'` con `request`.
  - Responde `{revision, status}`.
  - Errores:
    - `BED_TAKEN` (otro la cogió antes; Guests recarga y lo dice);
    - `CHOICE_CLOSED` (pasado `choose_until`);
    - `NOT_OFFERED` (cama de una habitación no abierta a elección);
    - `OUT_OF_SCOPE`.
- **`booking.portal_release_bed({guest_id})`:** suelta su elección mientras la elección siga abierta.
- **`booking.portal_room_preference({guest_id, text, ground_floor})`**, con `prefer`. Columnas nuevas en `booking.guests`: `room_preference` y `needs_ground_floor`, escribibles solo por las acciones de portal. **Decisión del usuario (8-10-2026):** las ven el personal y también el organizador.
- **Para Organizers** (no lo usa Guests): abrir habitaciones a elección con su `option_key`, y aprobar o rechazar las peticiones.

**Columnas nuevas** que propongo a Booking:
- **`booking.spaces`:** `en_suite boolean` (baño propio) y `public_name text` (el nombre que ve el huésped, si no es el interno).
- **`booking.room_assignments`:** `source` (`guest` | `organizer` | `staff`) y `status` (`confirmed` | `requested`).
- **`booking.event_open_rooms`** (o lo que Booking prefiera): qué habitaciones de la reserva están abiertas a elección y con qué `option_key`.

**Suplemento:** Guests nunca muestra el coste de Ikisai.
- Muestra el `guest_note` que escribe el organizador para cada tipo de habitación: «Incluido», «+40 € por persona, a pagar a tu organizador» o «Consulta con tu organizador».
- Lo que Ikisai factura al organizador por esas habitaciones va por la propuesta y Finance (fase 3) y no pasa por Guests.
- **Decisión del usuario (8-10-2026):** el huésped solo elige entre las camas con baño que el organizador **ya contrató** como extra en su propuesta. Elegir no cambia lo que Ikisai factura.

**En Guests:**
- pestaña Alojamiento con «Tu habitación»;
- con `choose` o `request`, las habitaciones disponibles por tipo, con la nota del organizador, «2 de 4 camas libres» y la elección de cama;
- un botón «Elegir esta cama» con confirmación; **solo con red** («Necesitas conexión para elegir habitación»);
- tras `BED_TAKEN`: «Alguien acaba de elegir esa cama. Te enseñamos las que quedan.», conservando el tipo elegido;
- pasado `choose_until`, solo lectura: «La elección de habitación se cerró el {fecha}».

### 13.8 Offline, caché y rendimiento

- **Lecturas nuevas en la caché por persona:** programa, menú, materiales (la lista), preguntas, experiencia y alojamiento.
- **Precarga:** se hace al abrir Inicio con red y vale para todo el retiro; durante la estancia, también al volver a primer plano.
- **Sin red:**
  - las respuestas a las preguntas van en la cola local, como los datos;
  - la elección de habitación nunca: necesita confirmación del servidor.
- **Lecturas en paralelo:** Inicio pide `experience`, `my_guest`, `program`, `menu` y `lodging`. Si Core prefiere menos viajes, se puede valorar una ruta compuesta en `guests-api`, que no propongo de entrada.

### 13.9 Después del retiro

Sin cambios respecto a lo anterior:
- valoración del retiro para el organizador y de Ikisai para Ikisai;
- materiales de «después»;
- base para «Mis estancias» si la persona guardó su acceso.

Sin tienda ni puntos en esta versión.

### 13.10 Aceptación (fases 4 y 5)

1. **Sin configuración:** Guests se ve como la fase 1.
2. **Con módulos activados:**
   - el organizador activa programa, menú y materiales: aparecen la barra inferior y las pestañas, y solo esas;
   - un material de «después» no aparece antes del retiro.
3. **Programa y menú:**
   - durante el retiro, «Hoy» enseña la actividad en curso, la siguiente y la próxima comida;
   - sin cobertura, programa, menú y materiales guardados se ven con el aviso de la hora.
   - El menú en borrador sale como «Provisional». Con una alergia registrada, sale «Cocina tiene registrada tu alergia…», sin calificar los platos.
4. **Materiales:**
   - un PDF del organizador se abre con una URL de 5 minutos y se puede guardar para verlo sin conexión;
   - otro huésped de otra reserva recibe `FILE_NOT_FOUND` con el mismo id.
5. **Preguntas:** una pregunta obligatoria aparece en «Lo que te falta». Se responde sin pulsar «Guardar» y el organizador la ve. Cerrada la ventana, se ve y no se cambia.
6. **Alojamiento:**
   - con `prefer`, la preferencia llega a Organizers y a Booking;
   - con `choose`, dos huéspedes eligen la misma cama a la vez: uno la consigue y el otro ve «Alguien acaba de elegir esa cama» y las que quedan;
   - nunca hay dos personas en la misma cama ni se ven los nombres de otros;
   - con `request`, la elección queda pendiente hasta que el organizador la aprueba.
7. **Vista previa:** el organizador abre la vista previa y ve lo mismo que un huésped, sin poder guardar nada.

## 14. Peticiones

Detalle y estado en `docs/guests/PETICIONES.md`.

### A Booking (por Core)

- **BG1 (hecha, #284) · Procedencia en la ficha del huésped.** En `portal_my_guest`:
  - `sources: {campo: 'guest' | 'organizer' | 'staff'}` (de `field_sources`, solo el `by`);
  - `source` en cada restricción.

  Sin esto no se cumple «lo que escribió el organizador lo ves y lo puedes corregir» con su marca.
- **BG2 (hecha, #284) · Revisión nueva en la respuesta de las acciones** (`portal_guest_update`, `portal_guest_consent`, `portal_set_restrictions` y `portal_guest_sign`): `{guest_id, revision, cursor}`. Permite encadenar el autoguardado campo a campo sin releer la ficha tras cada cambio.
- **BG3 (hecha, #284) · «Alimentación revisada».** Una columna `diet_reviewed_at` en `booking.guests` (escribible solo por las acciones de portal) que `portal_set_restrictions` marca también con la lista vacía («No tengo alergias ni dieta especial»). Se expone en `portal_my_guest` y como `diet_reviewed` en `portal_guests` y en la completitud del personal. Hoy no se distingue «no tiene nada» de «no ha contestado».
- **BG4 (hecha, #284) · Datos de la estancia para el huésped.** En `portal_my_guest.reservation`: `status`, `arrival_time` y `departure_time`. Sin importes, notas ni otros huéspedes. En la fase 4 se sumará su alojamiento asignado.
- **BG5 (hecha, #284) · Firma y datos cambiados.** Propuesta: si después de firmar cambia un campo del registro de viajeros, la firma deja de valer:
  - si lo cambia el huésped, `portal_guest_update` pone `signed_at` y `signature_file_id` a `null` y responde `signature_reset: true`;
  - si lo cambia el organizador o el personal, se marca igual.

  Además, guardar la versión del texto de la declaración firmado (`signature_text_version`, de Central). Booking decide si lo prefiere de otra forma.
- **BG6 (hecha, #284) · Parentesco.** Hoy es texto libre. Guests ofrece una lista traducida y guarda la etiqueta en español. ¿Prefiere Booking los códigos del catálogo de parentesco de SES en el dominio, para que Guests guarde el código?

### A Central (por Core)

- **CE1 · Textos por idioma.** `lang` (`es` | `en`) en `central.texts` y en la proyección, con alternativa en español si falta la traducción, y `lang` en `central.text_version`. Los textos de Ikisai se escriben en los dos idiomas (`PORTALES_V2.md` §3.8).
- **CE2 · Claves nuevas en la semilla**, editables desde «Textos y contacto»:
  - `guests.data_why` (por qué pedimos los datos);
  - `guests.signature_statement` (declaración al firmar, tipo `legal`);
  - `guests.allergies_notice` (aviso sobre alergias, sin promesas);
  - `info.arrival`, `info.parking`, `info.facilities`, `info.rules` e `info.bring` (información práctica; ¿un tipo nuevo `info`?).

### A Core

- **C1 · Contacto sin sesión** (lo hace Core: `GET /api/v1/public/contact?lang=`). Una lectura pública y cacheable de los textos de tipo `contacto` (por ejemplo `GET /api/v1/public/contact?lang=`), para las pantallas de enlace no válido o caducado, donde aún no hay sesión. Si no, esas pantallas solo pueden usar el texto de reserva del código (Organizers tiene el mismo caso).
- **C2 · Firma y recogida de huérfanos** (respondida: lo cubre Booking; Guests activa la recogida en la 0600). La firma es un `core.files` de `app = 'guests'` referenciado desde `booking.guests.signature_file_id`, que es una columna de Booking de clase `legal`. ¿Lo cubre el registro de Booking (`core.register_file_field`)? ¿Debe Guests llamar a `core.enable_file_gc('guests')` sin campos propios?
- **C3 · Alta de infraestructura** cuando abra la PR con `apps/guests`: `scripts/apps.py`, Pages, `guests.ikisai.com` y la redirección de `ven.ikisai.com`, como C5 de Organizers.
- **C4 · Varias entradas por cuenta** (confirmada). Confirmar que, con la #278, una cuenta de Guests acumula entradas en `scopes.grants` cuando se le emiten enlaces de otro huésped o de otro retiro con el mismo correo, y que revocar uno quita solo esa entrada.
- **C5 · Comentarios «Mi retiro» de huéspedes antes de la bandeja de Organizers** (respondida: se ofrece; los ve el personal de Booking). El destino es `organizer`, pero Organizers V1 no tiene aún «Comentarios del retiro». ¿Los ve mientras tanto el personal de Booking (que ya puede ver los reportes de portales) o escondo esa rama hasta que exista la bandeja? Propuesta: ofrecerla, porque Booking los ve.
- **C6 · Cuentas internas de huésped al caducar** (lo hace Core con Booking). ¿Qué pasa con las cuentas `p-…@portales.ikisai.com` y sus pertenencias cuando vence la conservación de SES-4? Propuesta: el mismo trabajo de anonimización revoca el ámbito y, sin otras entradas, borra la cuenta.

- **C7 · Lectura de archivos solo del autor en el kit** (hecha, #288). `GET files/:id` y `uploads/:id/verify` solo valen para quien subió el archivo; `guests-api` ya no necesita su propio filtro.

### A Organizers (por Core)

- **O1 · URL de los materiales.** `organizers.guest_materials` no puede firmar URL desde SQL, y el `files/:id` de `guests-api` solo ve archivos de Guests subidos por la propia persona. Una ruta de `organizers-api` no sirve, porque los huéspedes no son miembros de Organizers. Sustituida por la propuesta genérica del §13.5 (C8: `core.allow_portal_file` y `GET portal-files/:fileId`).

### A UI (por Core)

- **U1 · Capa de traducción** (ya pedida por Core en `ui/RESPUESTAS.md`). Además: que `createFeedbackProgressiveForm` acepte catálogos con etiquetas por idioma.
- **U2 · Recuadro de firma en el kit** (`createSignaturePad` → `Blob` PNG recortado, con borrar y deshacer, accesible y usable con el dedo). Booking tiene uno propio en `apps/booking`; tenerlo en el kit lo comparten los dos. Si no, lo hago en `apps/guests`.
- **U3 · Estado de guardado por campo** (`guardando`, `guardado`, `pendiente`, `error` con reintento) y estado global, reutilizable por Organizers.
- **U4 · Icono propio de Guests** (hecho): casa con huésped sobre terracota (`coordinacion/ui/icono-guests/`), marca `guest` del kit. El manifiesto y `theme-color` pasan a `#8f4b1f`, con fondo `#f6efe6`.

### Fases 4 y 5 (diseño del 8-10-2026, §13)

**A Booking:**
- **BG9 · Programa del retiro:**
  - tabla `booking.program_items` (§13.2);
  - acciones de portal para que el organizador lo edite (alta, cambio, baja y orden);
  - lectura `booking.portal_program({reservation_id})` para `guests` y `organizers`, sin notas internas.
- **BG10 · Alojamiento para el huésped** (§13.7):
  - `portal_lodging`;
  - `portal_choose_bed`, atómica, con `BED_TAKEN`, `CHOICE_CLOSED` y `NOT_OFFERED`;
  - `portal_release_bed`;
  - `portal_room_preference`.
  - Columnas `spaces.en_suite` y `spaces.public_name`, `room_assignments.source` y `status`, y `guests.room_preference` y `needs_ground_floor`.
  - Habitaciones abiertas a elección por reserva, con `option_key`.
  - Para Organizers: abrir habitaciones y aprobar peticiones.
- **BG11 · Huésped de muestra para la vista previa** (si se elige esa opción, O6): `guests.preview`, que no cuenta en la completitud ni va a SES, y `PREVIEW_READ_ONLY` en las acciones del huésped.
- **BG12 · `reservation_id` en `booking.food_event_projection`:** para que Food compruebe el ámbito de `food.portal_menu`.

**A Food:**
- **FD1 · Menú para los portales:** `food.portal_menu({reservation_id})` para `guests` y `organizers` (§13.3), con el estado `provisional` o `confirmado`, los servicios y los nombres de los platos, sin raciones ni notas. Opcional: `recipes.public_name`.

**A Organizers:**
- **O1 · Materiales:** el resolutor `organizers.guest_material_file` para `portal-files` (C8), y la lectura `guest_materials` con la forma de §13.5.
- **O2 · Forma de las lecturas y de la acción:** `guest_experience_for` (§13.1), `guest_questions` y `guest_answer` (§13.6), con `revision` en la respuesta y los errores `QUESTION_CLOSED` e `INVALID_ANSWER`.
- **O3 · Configuración del alojamiento:** `capability`, `choose_until` y `options[]` con `guest_note` (lo que el organizador dice al huésped del precio), y la aprobación de las peticiones con `request`.
- **O5 · Quitar `organizers.guest_offers`** del contrato con Guests (decisión del usuario).
- **O6 · Vista previa:** huésped de muestra abierto en Guests (propuesta, con BG11) o pintada en Organizers.
- **O7 · Límite de las preguntas:** sin salud, alergias ni documentos (§13.6).

**A Central:**
- **CE3 · Mapa y avisos:**
  - claves `info.map_link` y `guests.menu_notice` (en los dos idiomas);
  - plano del centro como imagen, servida con `portal-files` o sin sesión.

**A Core:**
- **C8 · Archivos publicados a un portal** (§13.5, propuesta para O1):
  - registro `core.allow_portal_file(portal, 'schema.fn')` (resolutor que dice si el actor puede ver un archivo);
  - ruta del kit `GET /api/v1/portal-files/:fileId` en los portales, con URL de 5 minutos por `createStorage`;
  - `404 FILE_NOT_FOUND` fuera de ámbito.
- **C9 · Enlace del huésped de muestra** (con BG11 y O6): que Organizers pueda emitir un enlace de Guests al huésped de muestra de sus reservas.

**A UI:**
- **U5 · Barra inferior de los portales con «Más»**, como mucho cinco entradas, y lista de días deslizable para el programa. Si el kit no lo tiene, lo hago en `apps/guests`.
