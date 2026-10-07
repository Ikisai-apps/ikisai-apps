# Ikisai Guests · API y pantallas (puerta G2, fase 1 · preparación, borrador para Core)

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

Las fases 4 y 5 (experiencia configurable, programa, menú, materiales, preguntas y elección de habitación) van solo a grandes rasgos en el §13.

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
- con una sola entrada abre directamente Inicio;
- con varias, muestra primero «¿Qué quieres ver?», con una tarjeta por persona y retiro (nombre, título del retiro y fechas).

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

**Sin rutas propias en la fase 1:** todo lo que necesita lo monta el kit. Sin `portalIssuer`, porque un huésped no emite enlaces, y sin `workerKey`, porque no tiene trabajos programados.

**`GET files/:id` cerrada.** El kit solo comprueba la pertenencia a la app, así que en un portal cualquier huésped podría pedir el archivo de otro (su firma) si conociera el id. Guests nunca vuelve a leer sus archivos, de modo que `guests-api` responde siempre `404 FILE_NOT_FOUND` en esa ruta (`createGuestsApp` envuelve el manejador del kit). Petición C7 a Core: que el kit lo ofrezca como opción.

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
- **Navegación:** en la fase 1, sin barra inferior: Inicio es el centro y cada tarea es una pantalla con «Volver». En la fase 4, la barra inferior se construye con los módulos que habilite el organizador (§13.1).

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
  | Compartir tus alergias con tu organizador | «Sí» / «No» (informativo, no es una tarea pendiente) | si tiene alguna alergia o intolerancia |

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
13. Una cuenta con dos entradas (madre e hijo) ve «¿Qué quieres ver?» y cada ficha por separado; nunca a otros huéspedes.
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

## 12. Reparto entre agentes

Lo hago yo: `supabase/functions/guests-api` (índice y conformidad), `apps/guests`, `tests/guests` y `docs/guests`. Con subagente (`sonnet`), solo lo mecánico:
- los escenarios de Playwright a partir de uno aprobado;
- el diccionario inglés a partir del español, que reviso yo.

**Orden de las PR:**
1. Edge, conformidad y pruebas de ámbito.
2. Entrada, aviso, Inicio y Mis datos con autoguardado.
3. Alimentación y firma.
4. Información práctica, ayuda, «Guarda tu acceso», idioma y offline.

## 13. Fases siguientes (a grandes rasgos)

Fases de `PORTALES_V2.md` §4: 4 (experiencia configurable) y 5 (decisiones del huésped). La 2 y la 3 no tocan Guests. Principio: cada dato tiene un dueño, y Guests lee y pide.

### 13.1 Experiencia configurable por el organizador (fase 4)

- **Dueño de la configuración: Organizers.** Por retiro guarda:
  - qué **módulos** ve el huésped: programa, alojamiento, menú, mapa, información práctica, materiales, actividades, extras y feedback;
  - qué **capacidad** tiene en cada uno: ver, indicar preferencia, solicitar, elegir, reservar, apuntarse o responder;
  - en qué **ventana** se ve: antes, durante o después.
- **Lectura desde Guests:** `organizers.guest_experience_projection`, filtrada por la reserva del ámbito. No es un editor libre, son módulos y acciones fijos. Lo obligatorio por Ikisai (datos legales, firma, alimentación y aviso legal) no se puede desactivar.
- **Navegación:** Guests construye la barra inferior y las tarjetas de Inicio a partir de esa configuración. Sin configuración, se queda como la fase 1.
- **Patrón de «capacidad delegada»:** `{module, capability, window, params}`. Cada capacidad que escribe se resuelve con **una acción del dueño del dato** (Booking para el alojamiento, Organizers para sus preguntas), nunca con tablas de Guests. Se empieza por el alojamiento (§13.4) y no se implementan veinte tipos a la vez.

### 13.2 Programa y «Hoy en Ikisai»

- **Dueño:** el programa es del dominio operativo del retiro (Booking). Lo define el organizador y lo publica Booking por `booking.portal_program`: día, inicio, fin, título, espacio y observación pública.
- **En Guests:** el programa por días y, durante la estancia, «Ahora» y «Lo siguiente» en Inicio.
- **Más adelante:** las actividades opcionales a elegir serán otra capacidad delegada.

### 13.3 Menú y materiales

- **Menú** (dueño Food):
  - lectura `food.portal_menu_projection` por evento: desayuno, comida y cena por día, platos publicados y la marca «provisional»;
  - texto fijo de Central: «El menú puede cambiar para adaptarse a alergias e intolerancias»;
  - sin promesas clínicas: basta con «Cocina tiene registrada tu restricción».
- **Materiales del organizador** (dueño Organizers):
  - archivos (con `createStorage` y su retención) y enlaces (grupo de WhatsApp o Telegram);
  - con ventana antes, durante o después;
  - lectura por proyección, y los archivos con URL firmada desde la Edge de Organizers.

### 13.4 Alojamiento (fase 5, primer caso fuerte)

- **Según la configuración**, el huésped:
  - ve su cama asignada;
  - indica preferencias («con quién me gustaría compartir»);
  - o **elige** una plaza, incluidas las habitaciones de **2–4 plazas con baño**.
- **Disponibilidad real de Booking,** sin copia.
- **Reserva atómica en servidor:** `booking.portal_choose_bed`, con bloqueo de la fila de la cama y una restricción única por noche. Ante una carrera, Guests muestra el estado actualizado y conserva la elección como intención, sin fingir éxito. Solo con red.
- **Suplemento:** decisión del usuario del 7-10-2026, que lo factura Ikisai al organizador. Guests muestra lo que el organizador haya configurado («Incluido» o «+X € a pagar a tu organizador»), sin el coste interno de Ikisai.

### 13.5 Ofertas, pagos y preguntas del organizador

- **Ofertas del organizador: no se muestran en Guests** (decisión del usuario, confirmada por Core el 7-10-2026). Le sirven para sus cálculos y para su cartel en PDF o JPG, que difunde por su cuenta.
- **Contrato con Organizers** (`docs/organizers/API.md` §13.5). Guests usa cuatro lecturas registradas para `guests` y filtradas por `{reservation_id, guest_id}`:
  - `organizers.guest_experience_for` (módulos y acciones);
  - `organizers.guest_questions` (preguntas vigentes y sus respuestas);
  - `organizers.guest_materials` (materiales publicados para el momento actual).

  Escribe solo con `organizers.guest_answer`. Sobra `organizers.guest_offers`, por la decisión anterior. Falta precisar quién firma las URL de los materiales (petición O1).
- **Pagos a Ikisai** (extras de Ikisai) llegarán con la fase 6, de Finance y la pasarela. Guests nunca guarda datos de tarjeta.
- **Preguntas propias del organizador:**
  - las define Organizers;
  - las respuestas son datos del huésped que pertenecen a Organizers (`organizers.*`) y se escriben con una acción de Organizers invocada desde Guests, con la misma pauta de ámbito que Booking;
  - no contaminan `booking.guests` salvo que sean datos operativos reales.

### 13.6 Después del retiro

- **Valoración estructurada**, con destinos separados:
  - lo del retiro va al organizador;
  - lo de Ikisai va a Ikisai.
- **Materiales posteriores** del organizador.
- **Base para «Mis estancias»** si la persona guardó su acceso. Sin tienda ni puntos en la V1.

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

- **C7 · Lectura de archivos solo del autor en el kit.** Una opción de `uploads` (por ejemplo `readOwnOnly: true`) para que `GET files/:id` y `uploads/:id/verify` solo valgan para quien subió el archivo. Hoy `guests-api` cierra la lectura por su cuenta (§6.1).

### A Organizers (por Core)

- **O1 · URL de los materiales.** `organizers.guest_materials` no puede firmar URL desde SQL, y el `files/:id` de `guests-api` solo ve archivos de Guests (y está cerrado). Una ruta de `organizers-api` no sirve, porque los huéspedes no son miembros de Organizers. Propuesta: una ruta propia de `guests-api`, `GET materials/:fileId`, que compruebe con una lectura de Organizers que el material está publicado para la reserva del huésped y firme la URL con `createStorage`. Organizers lo confirma en su G2 de la fase 4.

### A UI (por Core)

- **U1 · Capa de traducción** (ya pedida por Core en `ui/RESPUESTAS.md`). Además: que `createFeedbackProgressiveForm` acepte catálogos con etiquetas por idioma.
- **U2 · Recuadro de firma en el kit** (`createSignaturePad` → `Blob` PNG recortado, con borrar y deshacer, accesible y usable con el dedo). Booking tiene uno propio en `apps/booking`; tenerlo en el kit lo comparten los dos. Si no, lo hago en `apps/guests`.
- **U3 · Estado de guardado por campo** (`guardando`, `guardado`, `pendiente`, `error` con reintento) y estado global, reutilizable por Organizers.
- **U4 · Icono propio de Guests** y la barra inferior oculta con `nav: []` (como C6 y C8 de Organizers).
