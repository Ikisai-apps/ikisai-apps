# Ikisai Central · API y modelo de datos (puerta G2)

Fecha: 7 de octubre de 2026 (revisión 1). Autor: agente Central (sesión `app-09`). Estado: **aprobado por Core** (ronda 1, 7 oct: orden V1-a → V1-b → V1.1 → V2; P2, P3 y P4 hechas en la PR #181). Las preguntas de §15 siguen con los valores por defecto que fijó Core hasta que responda el usuario. Sigue `docs/core/PLANTILLA_API_APP.md`; el contrato `docs/core/CONTRATO_SINCRONIZACION.md` es normativo y aquí no se repite.

Fuentes: encargo de Core (`coordinacion/central/RESPUESTAS.md`, 7 oct), contrato §2, §3.1–3.5, §4, §5 y §8; `coordinacion/ampliacion/VALORACION_CORE.md` y `CRUCE_SHEETS.md`; hojas C01 Dirección, C05 Equipo y C09 Legal (`C0x.md`, esquemas y listas de «App de gestión»); migración `0062_core_admin` y `_kit/admin.ts`; `docs/booking/API.md` §5 y §15.3 (huéspedes y personal en eventos), `docs/tasks/API.md` §6–7 e `docs/invoices/API.md` (patrón de lecturas entre apps).

---

## 0. Resumen para quien revisa

- **Central no copia datos de nadie.** Administra cuentas y accesos con las rutas `admin/*` que ya monta el kit (sin tablas nuevas), guarda lo que hoy no tiene dueño (personas, obligaciones legales, documentos clave) y lee el resto por proyecciones.
- **Persona ≠ cuenta.** `central.people` es la ficha de alguien que trabaja o colabora con Ikisai, tenga o no cuenta; la cuenta sigue siendo de Core (`auth.users`, `core.profiles`, `core.memberships`) y se enlaza de forma opcional.
- **Datos personales en dos niveles.** La ficha básica (nombre, relación, función, disponibilidad) la ve cualquier miembro de Central. Contacto, vinculación laboral, documentos y formación viven en tablas aparte que solo ven el `owner` y los `editor` con ámbito `people` (§5). Nada de DNI, domicilio, fecha de nacimiento, cuenta bancaria ni datos de salud o discapacidad como campos: si hace falta, va dentro de un documento.
- **Cumplimiento** (C09): requisitos con vencimiento, riesgo y responsable; documentos clave versionados; panel de vencimientos; «Crear tarea en Tasks» por la API de Tasks con el token del usuario (petición a Tasks vía Core).
- **Dirección** (C01): un contrato común de proyección de KPIs (`<schema>.central_kpi_projection`) que cada app publica; Central solo guarda objetivos y umbrales.
- **Orden propuesto** (§13): V1 = cuentas y permisos + personas; V1.1 = cumplimiento; V2 = dirección cuando haya proyecciones; configuración común cuando haya un parámetro con demanda real.
- Peticiones a Core en §14 y en `docs/central/PETICIONES.md`. La más importante: **visibilidad de archivos** en `files/:id` (P1), porque los documentos de personas no pueden depender solo de que nadie conozca el id.

---

## 1. Dominio y límites

**Qué resuelve.** `central.ikisai.com` (alias `encarna.ikisai.com`) es la app de dirección del ecosistema:

1. **Cuentas y permisos** de todas las apps: quién entra, en qué app y con qué rol; altas con contraseña temporal; agentes; registro de accesos. Lo hace sobre `admin/*` del kit (contrato §3.5).
2. **Personas** (C05): ficha de quien trabaja o colabora, con o sin cuenta, y su documentación y formación con caducidad.
3. **Cumplimiento** (C09): obligaciones legales y concesionales, seguros, licencias, revisiones; documentos clave; vencimientos y acciones.
4. **Dirección** (C01): panel de KPIs leídos de las otras apps, con objetivos y umbrales.
5. **Configuración común**: parámetros del ecosistema que hoy no tienen dueño (§2.9, por definir).

**Qué no hace.**

- No gestiona turnos, horas ni coste de personal: los turnos son de Booking (`booking.staff_assignments`, que ya prevé un enlace tipado a la persona de Central), los pagos de Invoices/Finance. Central solo es dueña de la **ficha** de la persona.
- No ejecuta revisiones técnicas recurrentes: las ejecuta Tasks (Cuida). Central registra la **obligación** y su vencimiento, y pide el trabajo a Tasks (frontera de `CRUCE_SHEETS.md`).
- No registra pagos de seguros, canon o tasas: es Invoices/Finance. Un requisito puede marcar `generates_cost`, sin importe.
- No es un gestor documental general: guarda los documentos que respaldan una obligación o una persona.
- No sustituye a la gestoría ni al asesor laboral: no hay nóminas, contratos generados ni modelos oficiales.
- **Fuera de la primera versión** (en el orden de §13 o como pregunta al usuario): expedientes de subvenciones y licitaciones (C09, decisión del usuario del 6 oct: «después»), incidencias de equipo (C05), revisión semanal, OKR y registro de decisiones (C01), registro de tratamientos RGPD.

**Datos de otras apps.** Cuentas, perfiles y pertenencias: Core, por `admin/*`. KPIs: proyecciones de cada app (§7.2). Tareas: API de Tasks con el token del usuario (§7.3). Central guarda como mucho una etiqueta de cortesía y la revisión del destino (contrato §8), nunca una copia como fuente de verdad.

**Agentes de IA.** El núcleo no admite agentes en Central (`0062_core_admin`: ningún agente es miembro de `central`). Central no publica herramientas MCP propias en V1; las genéricas quedan para personas con sesión.

---

## 2. Tablas sincronizables (`central.*`)

Todas llevan las columnas del contrato §2.1, se registran con `core.register_table` en la misma migración y entran en el espejo local. Fechas `date` salvo indicación. Texto libre con longitud acotada (`check (length(x) <= N)`). Listas cerradas como `check`. Escritura `{editor, owner}` salvo indicación.

### 2.1 `central.people` — ficha básica (C05 `equipo`)

Lectura `{reader, editor, owner}`. Sin datos de contacto ni laborales.

| Columna | Tipo | Restricciones / notas |
|---|---|---|
| `code` | `text unique not null` | `PER_AAAA_NNN` (`core.next_code('PER', año de alta)`), por trigger en el `insert`. No escribible. |
| `display_name` | `text not null` | 1–80. Nombre con el que se le conoce («Marga»). |
| `relation` | `text not null` | `equipo`, `colaborador`, `voluntario`, `practicas`, `otro`. Relación con Ikisai (encargo de Core). |
| `base_role` | `text not null default 'otro'` | Lista de C05 `rol_base`: `direccion_general`, `direccion_operativa_comercial`, `cocina`, `mantenimiento_logistica`, `limpieza`, `apoyo_tecnico_sonido`, `apoyo_implantacion_alojativa`, `refuerzo_eventual`, `otro`. **No** es el rol de `core.memberships`. |
| `coverage` | `text not null default 'todo'` | C05 `ambito_cobertura`: `todo`, `solo_eventos`, `solo_mantenimiento`, `solo_cocina`, `solo_limpieza`, `solo_tecnico`, `solo_comercial`. |
| `availability` | `text not null default 'segun_calendario'` | C05: `alta`, `media`, `baja`, `segun_calendario`, `no_disponible`. |
| `availability_notes` | `text null` | ≤ 300. «Solo fines de semana». La interfaz advierte: sin datos de salud ni motivos personales. |
| `active` | `boolean not null default true` | C05 `activo`. Una baja es `active = false`, no un borrado. |
| `committed_post` | `boolean not null default false` | C05 `es_puesto_comprometido` (puesto comprometido en la licitación de la concesión). |
| `user_id` | `uuid null references auth.users(id)` | Cuenta enlazada (opcional). Única entre filas vivas. Solo la escribe el `owner` (§4.1). |
| `position` | `numeric null` | Orden manual (decisión del usuario del 6 oct). |

`writable_columns`: `display_name, relation, base_role, coverage, availability, availability_notes, active, committed_post, user_id, position`. Índices: `unique (user_id) where deleted_at is null and user_id is not null`; `(active, relation)`.

**Lo que no se porta de C05** y por qué: `perfil_puntuable` (DENO, mayor de 45, **discapacidad**) es categoría especial o casi; si una licitación lo exige, va como documento (§2.3) y no como campo. `estado_documental` y `estado_formacion_minima` no se guardan: se **calculan** de §2.3 (§3.2). `fecha_alta` es `created_at`. `archivado` es `active = false` o la papelera.

### 2.2 `central.person_private` — contacto y vinculación (1:1)

Lectura `{editor, owner}` **y** visibilidad §5 (owner, o editor con ámbito `people`). Un `reader` nunca la recibe.

| Columna | Tipo | Notas |
|---|---|---|
| `person_id` | `uuid not null references central.people(id)` | Inmutable. `unique (person_id) where deleted_at is null`. |
| `legal_name` | `text null` | ≤ 160. Nombre completo, si hace falta para contratos o certificados. |
| `phone` | `text null` | ≤ 32. |
| `email` | `text null` | ≤ 320, forma de correo. Es el que se propone al dar cuenta a la persona (§9.2). |
| `engagement` | `text null` | C05 `tipo_vinculacion` + voluntariado: `contrato_indefinido`, `contrato_temporal`, `autonomo`, `colaborador_externo`, `apoyo_puntual`, `voluntariado`, `sin_vinculo`. |
| `engaged_from` | `date null` | Inicio de la relación actual. |
| `engaged_until` | `date null` | Fin previsto o real. `engaged_until ≥ engaged_from`. |
| `emergency_contact` | `text null` | ≤ 160. Nombre y teléfono de contacto de emergencia (retiros y estancias). Opcional; pregunta 3 de §15. |
| `notes` | `text null` | ≤ 1000. Notas reservadas. Misma advertencia que `availability_notes`. |

`writable_columns`: `person_id` (solo en `insert`), `legal_name, phone, email, engagement, engaged_from, engaged_until, emergency_contact, notes`.

**Por qué una tabla aparte** y no columnas en `people`: la visibilidad del núcleo es por fila (`visible`) y por tabla (`readable_roles`), no por columna. Separar es la única forma de que un lector de Central vea el directorio sin ver teléfonos ni contratos.

### 2.3 `central.person_records` — documentación y formación con caducidad (C05 `documentacion`)

Lectura `{editor, owner}` + visibilidad §5, igual que §2.2.

| Columna | Tipo | Notas |
|---|---|---|
| `person_id` | `uuid not null references central.people(id)` | Inmutable. |
| `kind` | `text not null` | `documento`, `formacion`. |
| `record_type` | `text not null` | Documentos (C05): `contrato_o_vinculo`, `alta_ss_o_reta`, `datos_fiscales`, `prl_basico`, `certificado_delitos_sexuales`, `otro_documento`. Formación: `manipulador_alimentos`, `prl_basico`, `primeros_auxilios`, `socorrismo`, `otra_formacion`. `check` de pareja `(kind, record_type)`. |
| `title` | `text null` | ≤ 120. Obligatorio con `otro_documento` / `otra_formacion`. |
| `status` | `text not null default 'pendiente'` | C05: `ok`, `pendiente`, `en_revision`, `no_aplica`. **`caducado` no se guarda**: se deriva de `expires_on` (§3.2). |
| `issued_on` | `date null` | Fecha del documento o del curso. |
| `expires_on` | `date null` | Caducidad (null = no caduca). |
| `reviewed_on` | `date null` | Última comprobación. |
| `file_id` | `uuid null` | `core.files` del bucket `central-documents` (sin FK mientras el lint no la admita, validado en la Edge como en Booking P5). |
| `notes` | `text null` | ≤ 500. |
| `position` | `numeric null` | |

`writable_columns`: `person_id` (solo `insert`), `kind, record_type, title, status, issued_on, expires_on, reviewed_on, file_id, notes, position`. Índices: `(person_id)`, `(expires_on) where deleted_at is null and expires_on is not null`.

`certificado_delitos_sexuales` está porque Ikisai acoge familias con menores (C04, servicio infantil): en España es obligatorio para quien trabaja en contacto habitual con menores. Solo se registra que se ha aportado y su fecha; el certificado, si se guarda, va como archivo.

### 2.4 `central.requirements` — obligaciones (C09 `requisitos_legales`)

Lectura `{reader, editor, owner}`.

| Columna | Tipo | Notas |
|---|---|---|
| `code` | `text unique not null` | `LEG_AAAA_NNN` (C09). Por trigger; no escribible. |
| `name` | `text not null` | 1–160. «Póliza de responsabilidad civil», «Revisión anual de la piscina». |
| `requirement_type` | `text not null` | C09: `concesion`, `licencia_autorizacion`, `seguro`, `laboral_ss`, `prl`, `proteccion_datos`, `garantia`, `entrega_recepcion`, `revision_tecnica`, `documentacion_contractual`, `cumplimiento_operativo`, `subvencion_ayuda_publica`, `licitacion_concesion`, `reversion`, `otro`. |
| `description` | `text null` | ≤ 2000. |
| `source` | `text null` | ≤ 300. C09 `fuente_origen`: norma, pliego, contrato… |
| `authority` | `text null` | ≤ 160. C09 `organismo`. |
| `responsible_person_id` | `uuid null references central.people(id)` | Responsable (C09 `responsable`). Solo el nombre visible de la ficha básica. |
| `status` | `text not null default 'pendiente'` | `pendiente`, `en_revision`, `cumplido`, `bloqueado`, `no_aplica`, `cerrado`. **`vencido` se deriva** (§3.2): en C09 es un estado manual que se olvida de poner; aquí lo da la fecha. |
| `reference_date` | `date null` | C09 `fecha_referencia` (concesión, última revisión). |
| `expires_on` | `date null` | Vencimiento. |
| `frequency` | `text not null default 'unica'` | `unica`, `mensual`, `trimestral`, `semestral`, `anual`, `bienal`, `trienal`, `quinquenal`, `otra`. |
| `frequency_months` | `int null` | Obligatorio con `otra` (1–120). |
| `notice_days` | `int not null default 30` | Antelación del aviso (0–365). |
| `risk` | `text not null default 'medio'` | C09: `bajo`, `medio`, `alto`, `critico`. |
| `impact` | `text null` | C09: `legal`, `administrativo`, `economico`, `operativo`, `reputacional`, `mixto`. |
| `blocks_operation` | `boolean not null default false` | C09 `bloquea_operacion`. |
| `generates_cost` | `boolean not null default false` | C09 `genera_coste`. El importe es de Finance. |
| `next_action` | `text null` | ≤ 300. |
| `next_action_on` | `date null` | |
| `notes` | `text null` | ≤ 1000. |
| `position` | `numeric null` | |

`writable_columns`: todas salvo `code`. Índices: `(expires_on)`, `(status)`, `(requirement_type)`.

**Al cumplir una obligación periódica** la persona marca `cumplido`, pone la nueva `reference_date` y la app propone `expires_on` = referencia + frecuencia (regla de `_domain/central`). No se crean filas por periodo: el historial de renovaciones está en `core.changes` y en los documentos (§2.5) con sus fechas.

### 2.5 `central.key_documents` — documentos clave (C09 `documentos_clave`)

Lectura `{reader, editor, owner}`. Documentos de la entidad (concesión, pólizas, licencias, actas), **no** de personas (eso es §2.3).

| Columna | Tipo | Notas |
|---|---|---|
| `code` | `text unique not null` | `DOC_AAAA_NNN`. Por trigger. |
| `requirement_id` | `uuid null references central.requirements(id)` | Requisito al que respalda (evidencia). |
| `document_type` | `text not null` | C09: `contrato`, `anexo`, `poliza`, `certificado`, `licencia`, `autorizacion`, `acta`, `inventario`, `protocolo`, `justificante_pago`, `factura`, `resolucion`, `memoria_justificativa`, `requerimiento`, `otro`. |
| `name` | `text not null` | 1–160. |
| `description` | `text null` | ≤ 1000. |
| `status` | `text not null default 'vigente'` | `vigente`, `pendiente`, `en_revision`, `sustituido`. `caducado` se deriva. |
| `document_date` | `date null` | |
| `reviewed_on` | `date null` | |
| `expires_on` | `date null` | |
| `version` | `text null` | ≤ 40. |
| `signed` | `boolean not null default false` | |
| `file_id` | `uuid null` | `core.files` en `central-documents`. |
| `external_url` | `text null` | ≤ 500, `https://`. Enlace a Drive mientras el original siga allí. |
| `responsible_person_id` | `uuid null references central.people(id)` | |
| `notes` | `text null` | ≤ 1000. |

`writable_columns`: todas salvo `code`. Una factura o justificante de pago que ya está en Finance **no se sube otra vez**: se enlaza con `external_url` o, más adelante, con un enlace tipado a Finance (§7.4).

### 2.6 `central.requirement_tasks` — trabajo pedido a Tasks

Lectura `{reader, editor, owner}`. Una fila por tarea creada en Tasks a partir de un requisito (una por renovación, revisión o subsanación).

| Columna | Tipo | Notas |
|---|---|---|
| `requirement_id` | `uuid not null references central.requirements(id)` | Inmutable. |
| `target_app` | `text not null default 'tasks' check (target_app = 'tasks')` | Contrato §8. |
| `target_kind` | `text not null default 'task' check (target_kind = 'task')` | |
| `target_id` | `uuid not null` | Id de la tarea en Tasks. |
| `target_label` | `text null` | ≤ 200. Título de cortesía, para verlo sin red. |
| `target_revision` | `bigint null` | Revisión al enlazar (obsolescencia por comparación). |
| `due_on` | `date null` | Fecha pedida. |

Columnas además de las de la tabla: `external_ref` (`<código>:<requestId>`, la referencia enviada a Tasks). Las filas las inserta la ruta de §6 con `core.commit` directo (id derivado del `requestId`, reintento idempotente); `insert` desde el cliente → `INVALID_OPERATION`. El cliente solo puede cambiar `target_label`, `target_revision` y `due_on`. El estado de la tarea (hecha, por clasificar, borrada) **no se guarda**: se lee de Tasks (§7.3). Migración `0510_central_compliance`.

### 2.7 `central.kpi_targets` — objetivos y umbrales (C01 `indicadores.objetivo_referencia`)

Lectura `{reader, editor, owner}`; escritura `{owner}`. Migración `0520_central_kpis`, que también crea `central.central_kpi_projection` (los KPIs de Central con el contrato de §7.2). Lleva además `notes text null` (≤ 300).

| Columna | Tipo | Notas |
|---|---|---|
| `kpi` | `text not null` | Clave del catálogo (§7.2), p. ej. `booking.occupancy_rate`. |
| `period` | `text not null default '*'` | `*` (siempre), `AAAA`, `AAAA-MM` o `AAAAT1`–`T4`. `unique (kpi, period) where deleted_at is null`. |
| `target` | `numeric null` | Objetivo. |
| `warn_at` | `numeric null` | Umbral de «atención». |
| `critical_at` | `numeric null` | Umbral de «crítico». |
| `direction` | `text not null default 'up'` | `up` (más es mejor) o `down`. Decide cómo se aplican los umbrales. |

El estado `ok | atencion | critico` de C01 se calcula al leer; no se guarda.

### 2.8 Códigos humanos

`PER` (personas), `LEG` (requisitos, como C09), `DOC` (documentos clave). Registro en este documento (contrato §2.3). `EXP` queda reservado para expedientes cuando entren.

### 2.9 Configuración común · Entidad (aprobado por el usuario, ronda 3)

Primer bloque de configuración común: los datos legales de Ikisai. Migración `0501_central_entity`. Los datos reales no van en Git: los escribe el owner en la pantalla **Entidad**.

`central.entity` — una sola fila viva (`unique ((true)) where deleted_at is null`). Lectura `{reader, editor, owner}`; **escritura solo `{owner}`**.

| Columna | Tipo | Notas |
|---|---|---|
| `legal_name` | `text not null` | Razón social, 1–200. |
| `trade_name` | `text null` | Nombre comercial, ≤ 120. |
| `tax_id` | `text not null` | NIF/CIF normalizado (mayúsculas, sin espacios ni guiones; `^[A-Z0-9]{8,15}$`). Con `country = 'ES'`, `_domain/central` comprueba el control de NIF, NIE o CIF. |
| `address_line`, `postal_code`, `city` | `text not null` | Domicilio fiscal. |
| `province` | `text null` | |
| `country` | `text not null default 'ES'` | ISO de dos letras. |
| `email`, `phone`, `website` | `text null` | Contacto de la entidad (no personal); la web empieza por `https://`. |
| `logo_file_id` | `uuid null` | Archivo de Central verificado, PNG, JPEG o WebP. Se sube **sin recomprimir** si pesa hasta 2 MB (un logotipo no es una foto: excepción explícita al contrato §11.3); si pesa más, se reduce en el cliente. |

**Proyección `central.common_entity_projection`** (registrada para `booking`, `invoices` y `central`):

```text
entity_id, legal_name, trade_name, tax_id, address_line, postal_code, city, province, country, email, phone, website,
entity_revision, updated_at, logo_file_id, logo_bucket, logo_path, logo_mime, logo_sha256, logo_provider
```

La leen Booking (documento de la propuesta al organizador) y Finance (facturas emitidas) con `GET read/central.common_entity_projection` en su propia API. El **logotipo** va como referencia al archivo verificado (`logo_bucket`, `logo_path`, `logo_provider`): la Edge lectora lo firma con `createStorage(supabase).readUrl({ bucket: logo_bucket, path: logo_path, storage_provider: logo_provider })` (contrato §3.9; nunca llamando a `/storage/v1/object…` directamente) o lo descarga con `.download(…)` para incrustarlo. Migración `0550` (columna `logo_provider`, la última de la vista). `entity_revision` sirve para saber si un documento ya emitido usó datos anteriores (contrato §8).

Otros candidatos de configuración común, sin hacer hasta que alguien los pida: textos legales y versiones de consentimiento (fase de portales), plazos de conservación (irán con el registro de tratamientos). Espacios, tipos de evento y categorías de gasto ya tienen dueño.

### 2.10 `central.decisions` — registro de decisiones (C01 «decision_clave», aprobado por el usuario en la ronda 9)

Migración `0530_central_decisions`. Lectura `{reader, editor, owner}`; escritura `{editor, owner}`.

**Tres niveles de lectura** (condición del usuario):
1. **Nombre**, en lenguaje llano: que lo entienda alguien de 18 años sin contexto técnico. Es lo que se ve en la lista.
2. **Descripción**, también llana: qué se decidió y por qué, en pocas frases. Se despliega al tocar el nombre.
3. **Explicación técnica**, sin pasarse: cómo se aplica, qué apps o tablas toca, alternativas descartadas. Plegada dentro de la descripción.

| Columna | Tipo | Notas |
|---|---|---|
| `code` | `text unique` | `DEC_AAAA_NNN` (C01). Por trigger. |
| `decided_on` | `date not null` | |
| `name` | `text not null` | Nivel 1, 1–160. |
| `summary` | `text not null` | Nivel 2, 1–2000. |
| `technical` | `text null` | Nivel 3, ≤ 8000. |
| `responsible_person_id` | `uuid null → central.people` | Persona de Central. |
| `status` | `text not null default 'vigente'` | `vigente`, `sustituida`, `revocada`. |
| `superseded_by` | `uuid null → central.decisions` | Obligatorio si y solo si `sustituida`; nunca ella misma. |
| `scopes` | `text[] not null default '{}'` | Apps o áreas afectadas: `ecosistema`, `central`, `tasks`, `invoices`, `booking`, `food`, `guests`, `organizers` (≤ 10). |
| `link_url`, `link_label` | `text null` | Enlace `https://` a un documento, una tarea o un PR, con su texto. |

Invariantes (`central.check_decisions`): una decisión viva no puede estar sustituida por una que esté en la papelera (`ORPHAN_CHILD`); el responsable no puede estar en la papelera (`PERSON_IN_USE`).

**Pantalla Decisiones** (se abre desde Inicio): lista de nombres, más recientes primero, con código, fecha, estado y apps; cada decisión es un bloque plegable con su descripción, el enlace «Sustituida por», la explicación técnica plegada, el responsable y el enlace. Búsqueda por texto sin acentos (código, nombre, descripción y explicación) y filtros por app y estado (`filterDecisions` en `_domain/central/decisions.ts`). Funciona sin red como el resto de tablas. Las decisiones ya tomadas en V1 y V2 las carga Core desde la app, no por Git.

### 2.11 Equipos (`central.teams`, `central.person_teams`; aprobado por el usuario el 7-10-2026)

Para la audiencia por equipo de la medición de uso (`coordinacion/ampliacion/USO.md` §2.3). Migración `0540_central_teams`.

- **`central.teams`**: `name` (1–60, único entre los vivos sin distinguir mayúsculas), `color` (`#rrggbb`, opcional), `position` (orden manual). Papelera.
- **`central.person_teams`**: `person_id → central.people`, `team_id → central.teams`, únicos entre los vivos; ambos inmutables. Una persona puede estar en varios equipos. Quitar a alguien de un equipo es borrar la fila.
- **Permisos**: todos los miembros de Central leen; escriben el owner y el editor con ámbito `people`. Lo comprueban la Edge (`beforeCommit`) y la base (`central.check_teams`, con el actor del lote).
- **Invariantes**: ninguna pertenencia viva con la persona o el equipo en la papelera (`ORPHAN_CHILD`). La interfaz borra y restaura la persona o el equipo junto con sus pertenencias en el mismo lote.
- **Semilla**: sin datos en Git. Si no hay equipos, la pantalla propone crear los habituales (Cocina, Mantenimiento, Limpieza, Dirección, Administración, Recepción) en un solo lote.
- **Proyección `central.common_team_projection`** (`team_id, name, user_id`): solo personas **activas con cuenta enlazada** en equipos vivos. Registrada con `core.allow_read('central', …, 'view')` y con `select` para `service_role`, para que la Edge del núcleo la lea con la clave de servicio (matriz de uso por equipo). Sin más datos personales que el id de la cuenta.
- **Interfaz**: en Personas, filtro por equipo, chips de equipo en cada fila y el enlace «Equipos» a su pantalla (orden manual, alta con color, renombrar, papelera). En la ficha, el bloque «Equipos» con chips y «Cambiar».

### 2.12 «Textos y contacto» (`central.texts`; regla del usuario del 7-10-2026)

**Regla de producto:** los textos legales, avisos, declaraciones y datos de contacto que ven las personas y los portales se editan **siempre desde Central**, nunca fijos en el código. Migración `0570_central_texts`.

- **`central.texts`** (sincronizada; escribe solo el owner, leen todos los miembros):
  - `key` única entre los vivos e inmutable (`portal.privacy`, `organizers.declaration`, `contact.email`, `contact.phone`…).
  - `title`, `body` (texto o Markdown sencillo, ≤ 8000) y `kind` (`legal | mensaje | contacto`).
  - `position` y papelera.
  - `version` la lleva la base: `v1` al crear, y sube (`v2`, `v3`…) cuando cambian el título, el cuerpo o el tipo; reordenar no la cambia. No es escribible.
- **Versiones** (`central.text_versions`, tabla cerrada que escribe un disparador): guarda cada versión con su cuerpo tal como se escribió y **ya sustituido en ese momento**. Así, una declaración aceptada se muestra exactamente como se aceptó aunque luego cambien la Entidad o el contacto.
  - Ojo: un cambio en la Entidad o en el contacto **no** crea versión nueva de los textos que los usan; la proyección muestra siempre los datos actuales, y la versión guardada, los de su momento.
- **Marcadores**, sustituidos al leer (`central.render_text`, y `renderMarkers` en `_domain/central/texts.ts` para la vista previa sin red): `{{entidad.razon_social}}`, `{{entidad.nif}}`, `{{entidad.domicilio}}`, `{{contacto.correo}}` y `{{contacto.telefono}}` (los dos últimos salen de los textos `contact.email` y `contact.phone`). Lo que falta se escribe «—».
- **Proyección `central.common_texts_projection`** (`key, title, body` ya sustituido, `version, kind, updated_at`): registrada con `core.allow_read` para **organizers, guests, booking y central**. Sin datos personales. Uso: `GET read/central.common_texts_projection?where[key]=portal.privacy`.
- **Lecturas:**
  - `central.text_version` (`{key, version?}` → `{key, version, kind, title, body, createdAt}`, con el cuerpo sustituido de esa versión; sin `version`, la vigente), para organizers, guests, booking y central. Una app que guarde una aceptación debe guardar la `version` y mostrarla después con esta lectura.
  - `central.text_history` (`{key}` → versiones, más reciente primero), solo para central.
- **Semilla:** `central.seed_texts()`, con `core.apply_migration_operations`. Siembra `contact.email` (organiza@ikisai.com), `contact.phone` (614 76 57 96), `organizers.declaration` (legal) y `portal.privacy` (legal, «Protección de datos»), todos en `v1`. No hace nada con una clave que ya exista, y solo se ejecuta si Central ya tiene miembros (en producción, sí).
- **Pantalla «Textos y contacto»** (desde Inicio):
  - Lista por tipo con la versión de cada texto.
  - Editor (owner) con: ayuda para insertar marcadores, aviso de marcadores desconocidos, vista previa ya sustituida, el aviso «Al guardar se crea la versión vN; las aceptaciones anteriores conservan su versión» y las versiones anteriores.
  - Los demás miembros lo ven sin poder editar.

---

## 3. Procedimientos y lecturas

### 3.1 Procedimientos (`call`)

Ninguno en V1. Todo cabe en operaciones de fila con validación en `beforeCommit` y en `validate_hooks`. La creación de tareas en Tasks no es un `call` (sale fuera de la base y necesita red): es una ruta de §6.

### 3.2 Lecturas registradas y vencimientos

**Vencimientos sin lectura del servidor (cambio respecto a la propuesta).** Los vencimientos unificados (C09 `vencimientos` + C05 documentación) se calculan **en el dispositivo** con `dueItems` de `_domain/central/compliance.ts`, sobre el espejo local: funcionan sin red y solo incluyen la documentación de personas si quien mira la recibe (§5). El estado documental de una persona es `personStatus` (`people.ts`). Las lecturas `central.due_items`, `central.people_status` y `central.compliance_summary` no se construyen: harán falta en V2, cuando Central publique sus KPIs, y entonces irán como proyección `central.central_kpi_projection`.

Lecturas registradas que sí existen:

| Nombre | Rol | Para qué |
|---|---|---|
| `central.app_catalog` | owner | Catálogo completo de apps (Accesos). |
| `central.record_file` | editor | Archivo de un registro de documentación, si se ve la fila (§8). |
| `central.requirement_brief` | editor | Código, nombre, vencimiento y riesgo de una obligación, para pedir su tarea a Tasks. |
| `central.common_entity_projection` | todos | Proyección de la entidad (§2.9). |

La **regla de estado derivado** vive en `_domain/central` (la usa el cliente sin red) y se repite en SQL para las lecturas:

```text
vencido     expires_on < hoy  y  status ∉ {no_aplica, cerrado, sustituido}
por_vencer  hoy ≤ expires_on ≤ hoy + notice_days (requisitos) o 30 días (documentos y registros)
al_dia      el resto
```

---

## 4. Validación

### 4.1 `beforeCommit` (Edge; reglas compartidas en `_domain/central`)

- Tipos, longitudes y listas cerradas de §2 (las mismas que los `check`, para fallar sin red con un mensaje claro).
- `people.user_id`: solo un `owner` lo escribe; la cuenta debe existir y no ser un agente (`FORBIDDEN` / `INVALID_FIELDS`). Ver P3.
- `person_private` y `person_records`: el actor debe poder verlas (§5); si no, `FORBIDDEN` aunque sea `editor`.
- `file_id`: el archivo existe en `core.files`, es de la app `central`, está verificado y no está referenciado por otra fila de otra persona (`FILE_NOT_FOUND`, `FILE_IN_USE`).
- Fechas coherentes (`engaged_until ≥ engaged_from`, `expires_on ≥ issued_on`); `frequency = 'otra'` exige `frequency_months`; `title` obligatorio con los tipos `otro_*`.
- `requirement_tasks`: rechaza `insert` del cliente (solo la Edge).
- `kpi_targets`: `kpi` debe estar en el catálogo de `_domain/central`.

### 4.2 `validate_hooks` (SQL)

`central.check_account_link` (migración `0502`): si el lote cambia `people.user_id` (alta con valor o modificación) y quien escribe no es owner de Central → `FORBIDDEN 403`; borrar o restaurar una persona enlazada no cuenta como cambio. `central.check_invariants` comprueba lo que no puede romperse aunque la Edge falle: unicidad `people.user_id` viva, `person_private` única por persona viva, FK a filas vivas (un requisito no puede apuntar a una persona en la papelera) y las parejas `(kind, record_type)`.

### 4.3 Borrado y papelera

`people`: se borra lógicamente. Si tiene `person_private` o `person_records` vivos, el lote debe borrarlos también (el cliente lo compone; restaurar la persona devuelve sus hijos en el mismo lote); si no, `central.check_invariants` responde `ORPHAN_CHILD`. La interfaz propone antes desactivarla (`active = false`). Cuando existan requisitos y documentos (V1.1), una persona responsable de alguno no se podrá borrar. Ninguna tabla es `never_purge`; «Vaciar papelera» del owner purga de hijos a padres.

---

## 5. Visibilidad y permisos

### 5.1 Roles en Central

| Rol | Puede |
|---|---|
| `owner` | **Administra el ecosistema** (`admin/*` en todas las apps, contrato §3.5) y todo lo de Central, también los datos reservados de personas. |
| `editor` | Edita personas (ficha básica), requisitos, documentos clave. Datos reservados de personas **solo con ámbito `people`**. No administra cuentas. No toca objetivos de KPIs. |
| `reader` | Ve el panel de dirección, cumplimiento, documentos clave y el directorio básico de personas. Nunca datos reservados. |

### 5.2 Ámbitos (`core.memberships.scopes` de `central`)

```json
{ "people": true }
```

```ts
function visible(table, row, ctx) {
  if (table !== 'central.person_private' && table !== 'central.person_records') return true;
  return ctx.membership.role === 'owner'
      || (ctx.membership.role === 'editor' && ctx.membership.scopes?.people === true);
}
```

`readable_roles '{editor,owner}'` en esas dos tablas hace que el núcleo no se las entregue a un `reader`; el hook filtra a los editores sin ámbito en `snapshot`, `changes` e `history`.

### 5.3 Quién ve datos personales (lo que pide el encargo)

| Dato | Dónde | Lo ven | No lo ven |
|---|---|---|---|
| Nombre visible, relación, función, disponibilidad, activo | `people` | Todos los miembros de Central | Otras apps (salvo el id que Booking enlaza en turnos, sin datos) |
| Nombre completo, teléfono, correo, vinculación, fechas, contacto de emergencia, notas reservadas | `person_private` | Owner; editor con `people` | Reader, editores sin ámbito, otras apps |
| Documentos y formación (tipo, estado, fechas, archivo) | `person_records` + bucket | Owner; editor con `people` | Ídem |
| Correo de la cuenta, último acceso, accesos por app | `admin/accounts` (Core) | Solo owner de Central | Todos los demás |

**En el dispositivo:** las dos tablas reservadas se borran del espejo al cerrar sesión (`clearOnLogout: ['central.person_private', 'central.person_records']`) y `sync-client` re-sincroniza al cambiar los ámbitos. **En el historial:** `core.changes` guarda antes y después; el derecho de supresión de una persona se ejerce con `core.purge_row_history` a petición de Core, como en Booking. **Archivos:** ver P1.

**Datos que no se recogen** (minimización): DNI o NIE, número de la Seguridad Social, fecha de nacimiento, domicilio, cuenta bancaria, salud, discapacidad, antecedentes. Si un trámite los necesita, están en el documento correspondiente y en la gestoría.

---

## 6. Rutas propias (`/api/v1/...`)

`central-api` se crea con `createApp({ app: 'central', slug: 'central-api', admin: true, uploads: { bucket: 'central-documents', … }, hooks, routes })` y pasa `packages/test-kit` antes de añadir rutas propias. Además de las genéricas (§5 del contrato) y de `admin/*` (§3.5):

| Método y ruta | Rol | Entrada → salida | Errores |
|---|---|---|---|
| `POST requirements/:id/task` | editor | `{requestId, title?, due?, note?}` → `{requirementTaskId, created, routed, task}`. Pide la tarea a Tasks (`POST /api/v1/requests/task`) con el token de la persona: `source: 'central'`, `external_ref: '<LEG_…>:<requestId>'`, `kind: 'central.compliance_due'` con `kind_label`, `external_url` a la ficha (`https://central.ikisai.com/#/cumplimiento/<id>`), prioridad por el riesgo (crítico → `critical`, alto → `high`); **sin área ni proyecto** (las reglas de Tasks deciden o queda «Por clasificar»). Después inserta el enlace en `requirement_tasks`. Idempotente: el mismo `requestId` da la misma tarea y el mismo enlace. | `NOT_FOUND`, `TASKS_FORBIDDEN 403`, `EXTERNAL_REF_IN_USE 409`, `TASKS_REJECTED 422`, `TASKS_UNAVAILABLE 503` |
| `POST requirements/tasks-status` | reader | `{ids: [id de tarea]}` (hasta 200) → `{items, missing}` de `tasks.targets` con el token de quien mira (`pending`, `request`, `visible`, `done`, `deleted`). | `TASKS_*` |
| `GET catalog/apps` | owner | Catálogo completo de apps (`central.app_catalog`) para la pantalla Accesos; `GET apps` del kit solo da las de la cuenta. | `FORBIDDEN` |
| `GET dashboard` | reader | `{computedAt, items: [{app, kpi, label, value, unit, period, periodStart, periodEnd, direction, link, computedAt, target, state}], unavailable: [app]}`. Lee las proyecciones de §7.2 (`KPI_SOURCES`) y aplica `kpi_targets`. Una app sin proyección o caída va en `unavailable`, no rompe el panel. | — |
| — | owner | **Dar cuenta** desde la ficha no tiene ruta propia: la interfaz llama a `admin/invite` (correo propuesto desde `person_private.email`, accesos iniciales) y después enlaza `people.user_id` con un `update` normal. «Enlazar cuenta existente» y «Desenlazar» son también un `update`. | los de `admin/invite` |

No hay rutas propias de escritura para personas, requisitos ni documentos: todo va por `commands`, para que funcione sin red.

---

## 7. Proyecciones y enlaces

### 7.1 Lo que publica Central

| Vista | Lectora | Columnas | Motivo |
|---|---|---|---|
| `central.booking_person_projection` | booking | `person_id, code, display_name, base_role, active, revision` | Booking ya prevé `staff_assignments.person_ref_*` para elegir a la persona del turno sin copiarla (§15.3 de su `API.md`). Solo el nombre visible y la función, nunca contacto. **Se publica cuando Booking lo pida**; nota: Booking lo apunta como `target_app = 'encarna'` y debería ser `'central'`. |
| `central.booking_blocking_projection` (V2) | booking, tasks | `requirement_id, code, name, blocks_operation, state, expires_on` de requisitos vencidos que bloquean la operación | C09 «bloquea operación»: aviso en Booking y Tasks. Se propone; no entra en V1. |
| `central.common_entity_projection` | booking, invoices, central | §2.9 | Datos legales y logotipo de Ikisai para propuestas y facturas emitidas. |
| `central.<destino>_kpi_projection` de Central | central | Como §7.2 | Vencimientos y riesgos también son KPIs del panel. |

### 7.2 Contrato de KPIs (lo que Central pide a cada app)

Propuesta para que Core la reparta (ronda 6). Cada app que quiera aparecer en el panel de dirección publica **una** vista `<schema>.central_kpi_projection` en una migración suya y la registra con `select core.allow_read('central', '<schema>.central_kpi_projection', 'view');`. Central la lee con su clave de servicio al abrir el panel (`GET /api/v1/dashboard`); no copia nada.

| Columna | Tipo | Contenido |
|---|---|---|
| `kpi` | `text` | Clave estable `<app>.<nombre>` en minúsculas (`booking.events_next_30d`). Es la que usan los objetivos. |
| `label` | `text` | Etiqueta en español para la tarjeta (≤ 60 caracteres): «Eventos en los próximos 30 días». |
| `value` | `numeric` | El valor; `null` si no hay dato. |
| `unit` | `text` | `count`, `pct` (0–100), `eur`, `days`, `persons` o `nights`. |
| `period` | `text` | `actual` (foto de hoy), `AAAA-MM`, `AAAAT1`…`T4` o `AAAA`. |
| `period_start`, `period_end` | `date` | Límites del periodo (para `actual`, hoy o la ventana que mide). |
| `direction` | `text` | `up` (más es mejor), `down` (menos es mejor) o `null`. Es el sentido por defecto de los umbrales. |
| `link` | `text` | URL absoluta a la pantalla de la app donde se ve el detalle (`https://booking.ikisai.com/#/…`), o `null`. |
| `computed_at` | `timestamptz` | `now()` en la vista. |

**Reglas.**
- **Solo agregados**: ningún nombre, contacto ni importe de una persona.
- **Importes (`unit = 'eur'`) solo para owner y editor de Central** (ronda 8): `GET dashboard` no los entrega a un lector. El resto de indicadores los ve cualquier miembro de Central.
- Horizonte fijo, porque las vistas no reciben parámetros: lo actual y, en mensuales, los 12 meses anteriores y los 3 siguientes como mucho (≤ 500 filas).
- Fechas de «hoy» en hora de Madrid: `(now() at time zone 'Europe/Madrid')::date`.
- La clave y su fórmula se documentan en el `API.md` de la app dueña. Cambiar el significado de una clave es crear otra.
- Una app sin vista o con error no rompe el panel: aparece en «Aún sin indicadores».

Ejemplo (Booking):

```sql
create view booking.central_kpi_projection as
select 'booking.events_next_30d'::text as kpi, 'Eventos en los próximos 30 días'::text as label,
       count(*)::numeric as value, 'count'::text as unit, 'actual'::text as period,
       (now() at time zone 'Europe/Madrid')::date as period_start, (now() at time zone 'Europe/Madrid')::date + 30 as period_end,
       'up'::text as direction, 'https://booking.ikisai.com/#/calendario'::text as link, now() as computed_at
  from booking.events e
 where e.deleted_at is null
   and e.start_date between (now() at time zone 'Europe/Madrid')::date and (now() at time zone 'Europe/Madrid')::date + 30;
revoke all on booking.central_kpi_projection from public, anon, authenticated;
grant select on booking.central_kpi_projection to service_role;
select core.allow_read('central', 'booking.central_kpi_projection', 'view');
```

**Catálogo inicial que propongo** (de los 20 KPIs base de C01; cada equipo decide la fórmula exacta):

| App | Claves |
|---|---|
| Central (hecho, `0520`) | `central.legal_overdue`, `central.legal_due_soon`, `central.blocking_overdue`, `central.risks_high_open`, `central.documents_expired`, `central.people_active`, `central.people_records_expired` |
| Booking | `booking.reservations_confirmed_90d`, `booking.guests_expected_90d`, `booking.events_next_30d`, `booking.deposits_pending`, `booking.occupancy_rate` (mensual), `booking.staff_needs_open`; `booking.leads_new` y `booking.leads_converted` cuando exista el CRM |
| Finance | `invoices.expenses_month` (mensual), `invoices.pending_review`, `invoices.unpaid`, `invoices.unpaid_amount`, `invoices.income_issued_month` (mensual) |
| Tasks | `tasks.open`, `tasks.overdue`, `tasks.purchase_requests_open`, `tasks.supplies_below_min`, `tasks.requests_pending` (por clasificar) |
| Food | `food.events_without_menu_30d`, `food.shopping_lists_open` |

**Objetivos y estado.** `central.kpi_targets` (§2.7) guarda objetivo, umbral de atención, umbral crítico y sentido por clave y periodo (`*`, `AAAA`, `AAAA-MM`, `AAAAT1`): se aplica el del periodo exacto, si no el del año y si no el general. El estado `ok | atencion | critico` de C01 lo calcula `GET dashboard` (`kpiState` de `_domain/central/kpis.ts`); solo el owner fija objetivos.

### 7.3 Trabajo en Tasks

Contrato §8: «si una app necesita que otra haga algo, lo pide por su API con el token del usuario, y la dueña decide». Propuesta (petición a Tasks vía Core, P5):

- **Crear:** una ruta de Tasks para que otra app pida una tarea, p. ej. `POST /api/v1/intake {requestId, source: {app: 'central', kind: 'requirement', id, code}, title, notes?, dueDate?, projectId?}` → `{taskId, revision, projectId}`. Tasks decide dónde va (el proyecto pedido si el usuario puede escribir en él, o un proyecto de entrada «Cumplimiento» configurado en Tasks), aplica sus reglas (etiquetas por defecto, ámbitos) y es idempotente por `requestId`. Así Central no necesita conocer las tablas de Tasks.
- **Consultar:** `GET read/tasks.targets` con `{kind: 'task', id}`, que ya existe; pido que admita una lista de ids para no hacer una llamada por tarea.
- **Alternativa sin cambios en Tasks** (si Tasks prefiere no abrir ruta): Central compone el lote y lo envía a `POST commands` de Tasks con el token del usuario. Funciona, pero acopla Central al modelo de Tasks; no la recomiendo.

Crear la tarea necesita red: sin conexión, el botón explica que hace falta.

### 7.4 Enlaces que Central consume

Destinos tipados futuros en `key_documents` (factura o justificante de Finance) y en `requirements` (proyecto o activo de Tasks). No en V1.

---

## 8. Archivos

- Bucket privado `central-documents` (ya creado; `scripts/apps.py`): PDF, WebP, JPEG, PNG; 25 MB por archivo.
- Fotos de certificados o carnés: recompresión en cliente (1600 px, WebP) según el contrato §11.3; PDF tal cual.
- Referencias: `person_records.file_id` y `key_documents.file_id`. Subida sin red con el marcador `{"$blob": sha}` de `sync-client`.
- **Riesgo:** `GET files/:id` comprueba hoy solo la pertenencia a la app; un `reader` que conociera el id de un documento de una persona obtendría la URL. Los ids no se exponen a quien no ve la fila, pero no basta para documentación laboral. Petición P1: hook de visibilidad de archivos en el kit. Mientras no exista: las rutas del kit se resuelven antes que las de la app, así que `files/:id` no se puede sustituir. La interfaz de Central pedirá los documentos reservados por una ruta propia, `GET people/records/:id/file` (comprueba la visibilidad de la fila y firma la URL con la service key), y los ids de esos archivos solo llegan a quien ve la fila. El hueco que queda (alguien sin permiso que obtenga un id por otra vía) lo cierra P1.
- **Retención** (contrato §3.9, migración `0560`): `entity.logo_file_id` es `permanent`; `person_records.file_id` y `key_documents.file_id` son `legal`. La recogida de huérfanos del núcleo está activada para Central: un archivo que alguna vez fue `legal` o `permanent` nunca se borra solo, y un huérfano espera 30 días.

---

## 9. Pantallas y navegación

Cuatro entradas en la barra (Inicio, Cumplimiento, Personas y, para el owner, Accesos), con el lanzador del kit en el icono de la cabecera. **Entidad** se abre desde Inicio: con cinco entradas, los nombres se cortaban en el móvil.

### 9.1 Inicio (dirección)

Lectura: panel **Dirección** con tarjetas de KPIs agrupadas por app, estado (`ok`, `atencion`, `critico`) y objetivo; cada tarjeta enlaza con su `link`. El owner fija el objetivo desde la tarjeta. Sin red se pinta la última lectura guardada en el dispositivo (solo agregados), con su hora. Debajo, «Vence pronto», el enlace a Entidad y, para el owner, el resumen de accesos. Bloque «Vence pronto» (los 5 primeros de `central.due_items`). Móvil: una columna, tarjetas plegables por app.

### 9.2 Personas

Lista con buscador y filtros (relación, función, activo), orden manual. Ficha:

- **Básico** (todos): nombre, relación, función, cobertura, disponibilidad, puesto comprometido.
- **Contacto y vinculación** (plegable; solo quien ve datos reservados).
- **Documentación y formación** (plegable; ídem): lista con estado derivado y fecha; adjuntar foto o PDF.
- **Cuenta** (solo owner): cuenta enlazada y sus accesos por app, con «Dar cuenta» (alta con contraseña temporal y accesos iniciales; correo propuesto desde el contacto) o «Enlazar cuenta existente».

### 9.3 Cumplimiento

Pestañas **Vencimientos** (C09 `vencimientos` + documentación de personas, por fecha, con filtros de riesgo y tipo), **Requisitos** (lista y ficha con documentos, tareas pedidas a Tasks y su estado, botón «Crear tarea en Tasks», «Marcar cumplido» que propone el siguiente vencimiento) y **Documentos** (documentos clave por tipo y estado).

### 9.4 Accesos (solo owner)

- **Cuentas:** tabla de cuentas × apps con el rol en cada celda (móvil: lista de cuentas con chips por app). Tocar una celda: dar, cambiar o quitar el acceso, con los errores `LAST_OWNER` y `CURRENT_ACCOUNT` explicados. Los **ámbitos** de cada app se muestran en solo lectura con un enlace «Editar en <app>» (las pantallas de miembros de cada app ya los editan, y cada app interpreta los suyos); ver pregunta 4 de §15.
- **Alta:** correo, nombre y accesos iniciales → contraseña temporal mostrada una vez, con botón de copiar. Ofrece enlazar o crear la ficha de persona.
- **Agentes:** claves de todas las apps, último uso, caducidad, revocar.
- **Registro:** registro de accesos de todas las apps, filtrable por app, paginado.

Todo «Accesos» necesita red (lee y escribe en Core en el momento); sin conexión se muestra la última lista leída **en esta sesión** con su hora (solo en memoria: lleva correos y no se guarda en el dispositivo) y los cambios fallan con «Esta acción necesita conexión». Central edita el único ámbito propio (`people`) en la ficha de la cuenta; los de las demás apps se ven en solo lectura con enlace a la app.

### 9.5 «Sugerencias y QA» y uso semántico (fase 4 del feedback)

- Cáscara con `createFeedback`, `createFeedbackReview` (revisor) y el lanzador del kit 0.18 con los interruptores «Señalar para comentar» y «Revisor de QA» y la entrada **Sugerencias y QA** (`createAppLauncher({ feedback, review, center })`, guía `packages/ui-kit/demo/adopcion.ts`); sin botón propio en la cabecera. `onSessionEnd` borra borradores y totales del dispositivo.
- `data-feedback-id="central.<pantalla>.<sección>.<elemento>"` con su `data-feedback-label` en todo control con significado y en las secciones. Raíces: `inicio`, `direccion`, `accesos`, `entidad`, `personas`, `persona`, `equipos`, `cumplimiento`, `obligacion`, `decisiones`, `conflictos`, `cabecera`, `navegacion`, `avisos`. Sin uuids ni datos de negocio; lo comprueba `tests/central/feedback-ids.test.ts`.
- `data-feedback-ignore` en datos personales y en lo que se copia: correos, teléfonos, contacto y vinculación, nombres en filas y cabeceras, contraseña temporal, NIF/CIF y domicilio de la entidad, códigos `PER_`/`LEG_`/`DOC_`/`DEC_` y enlaces externos.
- `createUsage` (USO.md) con el aviso al equipo la primera vez. Operaciones contadas con éxito o error: `central.accesos.alta.crear`, `central.accesos.cuenta.cambiar_acceso`, `central.accesos.cuenta.contrasena`, `central.accesos.agentes.revocar`, `central.persona.cuenta.dar`, `central.persona.documentacion.guardar`, `central.obligacion.crear_tarea`, `central.obligacion.marcar_cumplido`, `central.entidad.guardar`, `central.decisiones.guardar` y `central.direccion.objetivo.guardar`.

---

## 10. Offline

- **Espejo local:** todas las tablas `central.*`. Las reservadas se borran al cerrar sesión (§5.3).
- **Sin red se puede:** crear y editar personas, contacto, documentación y formación (con adjuntos en cola), requisitos y documentos clave; marcar cumplido; ver vencimientos (calculados en el cliente con la misma regla de `_domain/central`).
- **Sin red no se puede:** administrar cuentas (`admin/*`), crear tareas en Tasks, refrescar KPIs. La interfaz lo dice y muestra lo último conocido con su hora.
- Pendientes y conflictos con los componentes del kit (contrato §6.3–6.4).

---

## 11. Aceptación

### 11.1 Recorrido (PC y Android, sobre `central.ikisai.com`)

1. Entrar desde otra app por el lanzador sin contraseña (sesión única).
2. Accesos: ver la tabla de cuentas; dar de alta a una persona con acceso de editor a Tasks; ver la contraseña temporal una vez; entrar con ella en Tasks.
3. Cambiar ese acceso a lector y quitarlo; intentar quitar al último propietario de una app y ver `LAST_OWNER`.
4. Revocar una clave de agente; verla revocada en el registro.
5. Personas: crear una persona sin cuenta con contacto y un certificado de manipulador con caducidad; adjuntar una foto sin red; reconectar y ver el adjunto subido.
6. Con una cuenta lectora de Central: ver la persona en el directorio sin contacto ni documentos (también en la red: no llegan).
7. Dar cuenta a una persona existente desde su ficha.
8. Cumplimiento: crear un requisito anual con vencimiento en 20 días; verlo en Vencimientos como «por vencer»; crear tarea en Tasks; completarla en Tasks y ver «hecha» en Central; marcar cumplido y aceptar el siguiente vencimiento.
9. Documento clave con PDF enlazado a un requisito.
10. Inicio: KPIs de Central; con una app sin proyección, el panel la marca como no disponible y sigue.
11. Sin red: editar un requisito y una persona, recargar, reconectar, ver todo sincronizado; un conflicto solapado se resuelve campo a campo.

### 11.2 Automatización

- Conformidad `packages/test-kit` de `central-api`.
- PGlite: invariantes, visibilidad de las tablas reservadas (reader y editor sin ámbito no las reciben en `snapshot`, `changes` ni `history`), `people.user_id` solo por owner, `due_items` sin filas reservadas para quien no las ve.
- Rutas: `requirements/:id/task` con un Tasks simulado (éxito, 403, 503, idempotencia); `dashboard` con una proyección ausente.
- Playwright: escenario offline de personas con adjunto y de requisitos; accesos con `admin/*` simulado.

---

## 12. Reparto entre agentes

Un agente (Central) hace modelo, migraciones, Edge y dominio; no se delegan (regla 11). Con subagentes `sonnet`: pantallas repetidas a partir de una aprobada (Documentos a partir de Requisitos), fixtures y escenarios Playwright siguiendo el patrón de Booking, y ejecutar suites.

Archivos: `supabase/migrations/*_0500…0599_central_*`, `supabase/functions/central-api`, `supabase/functions/_domain/central`, `packages/domain-central`, `apps/central`, `tests/central`, `docs/central`.

---

## 13. Orden y alcance propuestos

| Fase | Contenido | Dependencias |
|---|---|---|
| **V1-a · Cuentas y permisos** | `central-api` con conformidad y `admin: true`; pantalla Accesos completa; esqueleto PWA con lanzador. **Sin tablas propias**: se puede publicar en cuanto se apruebe este documento. | Kit (lanzador de UI) |
| **V1-b · Personas** | Migración `0500_central_people` (§2.1–2.3); ficha, documentación con archivos, «Dar cuenta». | Ninguna bloqueante (P1 mejora la protección de los archivos; P2 y P3, la gestión de cuentas) |
| **V1.1 · Cumplimiento** | Migración `0510_central_compliance` (§2.4–2.6); Vencimientos, Requisitos, Documentos; crear tarea en Tasks. | P5 (Tasks) para crear tareas; sin ella, todo menos el botón |
| **V2 · Dirección** | `0520_central_kpis` (§2.7); panel con las proyecciones que existan. | Proyecciones de cada equipo (§7.2) |
| **Después** | Configuración común, expedientes (EXP), incidencias de equipo, revisión semanal, OKR y decisiones, registro de tratamientos RGPD, bloqueo de operación hacia Booking/Tasks. | Decisiones del usuario |

Coincide con la recomendación de Core (1 y 2 primero; 3 después; 4 cuando haya proyecciones) y separa 1 de 2 porque Accesos no necesita migración y es lo que más falta hace con siete apps.

---

## 14. Peticiones a Core

Detalle y estado en `docs/central/PETICIONES.md`.

| # | Petición | Para qué | Alternativa mientras tanto |
|---|---|---|---|
| P1 | Visibilidad de archivos: hook `fileVisible(file, ctx)` en `files/:id` (o que `core_file_get` compruebe la fila que lo referencia). Es la P5 de Booking, aún pendiente. | Documentos de personas | Ruta propia `GET people/records/:id/file` que comprueba la fila; los ids solo llegan a quien la ve (§8) |
| P2 ✅ #181 | `admin`: restablecer la contraseña temporal de una cuenta existente (`POST admin/accounts/:userId/password`) y desactivar o reactivar una cuenta (bloqueo en Auth, revoca pases y sesiones). Hoy `admin/invite` sobre una cuenta existente no devuelve contraseña y quitar todos los accesos no cierra la sesión de Auth. | Altas y bajas de personal | Quitar todos los accesos (cada petición relee la pertenencia) |
| P3 ✅ #181 | Que las migraciones de `central` puedan leer `core.profiles` (y comprobar que existe un `auth.users.id`) para validar `people.user_id` en `validate_hooks`. | Enlace persona–cuenta | Validación solo en la Edge con `core_admin_accounts` (owner) |
| P4 ✅ #181 | `admin/accounts`: incluir `bannedUntil`/estado cuando exista P2, y `memberships[].updatedAt`. | Pantalla Accesos | — |
| P5 | Petición a **Tasks**: ruta para que otra app pida una tarea (§7.3) y `tasks.targets` con lista de ids. | Cumplimiento → trabajo | Sin botón «Crear tarea»; el responsable la crea a mano en Tasks |
| P6 | Petición a **Booking**: usar `target_app = 'central'` (no `'encarna'`) en `staff_assignments.person_ref_app` y decir si quiere ya `central.booking_person_projection`. | Turnos con la persona de Central | — |
| P7 | Llevar a los equipos el contrato de KPIs (§7.2) cuando se apruebe, para que cada uno publique su `central_kpi_projection` en su ronda. | Panel de dirección | Panel solo con KPIs de Central |
| P8 | Lanzador del kit y registro de despliegue de `apps/central` (Pages `ikisai-central`, dominio `central.ikisai.com` atado explícitamente, alias `encarna`). | Publicar V1-a | — |

---

## 15. Preguntas de producto (para el usuario, vía Core)

1. **Quién administra.** Hoy ser `owner` de Central es ser administrador de todo el ecosistema. ¿Habrá alguien que deba llevar personas y cumplimiento sin poder tocar accesos? Propuesta: sí → `editor` de Central con ámbito `people`; el `owner` queda para una o dos personas de dirección.
2. **Avisos de vencimiento.** (a) Solo en el panel de Central (V1, recomendado de entrada); (b) además, crear sola una tarea en Tasks N días antes (necesita una acción de sistema en Tasks); (c) además, correo cuando esté el SMTP de Google Workspace. Recomendación: (a) ahora y (b) cuando Tasks tenga su entrada.
3. **Contacto de emergencia** en la ficha reservada: ¿sí o no? Útil en retiros; es un dato de un tercero. Recomendación: sí, opcional.
4. **Ámbitos de cada app en Central.** (a) Central solo muestra los ámbitos y enlaza a la pantalla de miembros de cada app (recomendado: cada app sabe qué significan); (b) Central los edita todos (más cómodo, pero acopla Central a cada app).
5. **Configuración común.** ¿Arrancamos con los datos de la entidad (razón social, NIF, domicilio, logotipo) como única pieza, o lo dejamos hasta que una app lo pida? Recomendación: dejarlo hasta que Finance o los portales lo necesiten.
6. **Incidencias de equipo** (C05: ausencias, retrasos, conflictos): ¿entran en Central? Son información laboral sensible. Recomendación: no en V1.

**Respuestas del usuario** (7 oct, vía Core, ronda 2): 1) sí, editor de Central con ámbito `people` lleva personas y cumplimiento sin tocar accesos; 2) (a) avisos solo en el panel de Central; 3) sí, contacto de emergencia opcional; 4) sí, ámbitos de cada app en solo lectura con enlace a su pantalla de miembros; 5) pendiente (Core le explica qué son los datos de la entidad); no se empieza; 6) incidencias de equipo fuera de V1.
