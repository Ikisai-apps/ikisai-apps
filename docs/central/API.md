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

`writable_columns`: `target_label, target_revision, due_on`. Las filas las inserta la Edge dentro de la ruta de §6 (no el cliente): `insert` directo desde el cliente → `INVALID_OPERATION`. El estado de la tarea (hecha o no) **no se guarda**: se lee de Tasks (§7.3).

### 2.7 `central.kpi_targets` — objetivos y umbrales (C01 `indicadores.objetivo_referencia`)

Lectura `{reader, editor, owner}`; escritura `{owner}`. Solo para el bloque 4.

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

### 2.9 Configuración común (bloque 5, por definir)

No propongo tabla todavía: no hay un parámetro sin dueño que alguna app esté esperando. Candidatos encontrados al cruzar las hojas, con mi opinión:

| Candidato | ¿Sin dueño hoy? | Opinión |
|---|---|---|
| Datos de la entidad (razón social, NIF, domicilio, contacto, logotipo) | Finance los necesita para facturas emitidas; los portales, para textos legales | **Sí, buen candidato**: una sola fila `central.organization`, publicada como proyección a las apps que la pidan. |
| Textos legales y versiones de consentimiento (RGPD, imagen, alergias) | Nadie; los necesitan Guests y Organizers | Candidato para la fase de portales, junto con el registro de tratamientos. |
| Plazos de conservación por tipo de dato | Booking ya fija 3 años para huéspedes en su dominio | Mejor como parte del registro de tratamientos (cumplimiento), no como parámetro. |
| Catálogo de espacios y zonas | Ya es de Booking (`booking.spaces`), Tasks lo lee | No: tiene dueño. |
| Tipos de evento, categorías de gasto | Booking e Invoices, respectivamente | No: tienen dueño. |
| Zona horaria, moneda | Fijas (Europe/Madrid, EUR) en todas | No hace falta tabla. |

Si se aprueba, el patrón sería: tablas tipadas en `central.*` (nunca un `settings` clave-valor en `jsonb`, contrato §2.1) y una proyección `central.<app>_organization_projection` registrada para cada app lectora. Pregunta 5 de §15.

---

## 3. Procedimientos y lecturas

### 3.1 Procedimientos (`call`)

Ninguno en V1. Todo cabe en operaciones de fila con validación en `beforeCommit` y en `validate_hooks`. La creación de tareas en Tasks no es un `call` (sale fuera de la base y necesita red): es una ruta de §6.

### 3.2 Lecturas registradas (`core.allow_read('central', …, 'function')`)

| Nombre | Rol | Qué devuelve |
|---|---|---|
| `central.due_items` | reader | Vencimientos unificados (C09 `vencimientos` + C05 documentación): `{items: [{source: requirement\|key_document\|person_record, id, code, title, kind, dueOn, daysLeft, state: vencido\|por_vencer\|al_dia, risk, blocksOperation, responsibleName, personId?}]}`. `args`: `{withinDays?=60, includeOverdue?=true}`. Las filas de `person_records` solo salen si el actor las puede ver (owner o editor con ámbito `people`); para el resto, solo un recuento sin nombres. |
| `central.people_status` | editor | Por persona, el estado documental y de formación derivado: `{items: [{personId, documents: completo\|pendiente\|caducado, training: ok\|pendiente\|caducado\|no_aplica, nextExpiry}]}`. Mismo filtro de visibilidad. |
| `central.compliance_summary` | reader | Recuentos para el panel: requisitos abiertos, vencidos, por vencer en 30 días, riesgos alto/crítico abiertos, que bloquean operación (C09 `panel`, sin expedientes). |

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

`central.check_invariants` comprueba lo que no puede romperse aunque la Edge falle: unicidad `people.user_id` viva, `person_private` única por persona viva, FK a filas vivas (un requisito no puede apuntar a una persona en la papelera) y las parejas `(kind, record_type)`.

### 4.3 Borrado y papelera

`people`: se borra lógicamente; si tiene `person_private` o `person_records` vivos, el borrado los arrastra en el mismo lote (la Edge añade las operaciones; restaurar la persona las devuelve). Si está enlazada en requisitos o documentos como responsable, el borrado se rechaza (`IN_USE`) y la interfaz propone desactivarla (`active = false`). `requirements` con documentos o tareas enlazadas: igual. Ninguna tabla es `never_purge`; «Vaciar papelera» del owner purga de hijos a padres.

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
| `POST requirements/:id/task` | editor | `{requestId, title?, dueOn?, projectId?, notes?}` → `{requirementTaskId, target: {app, kind, id, revision, label}}`. Pide la tarea a Tasks con el token del usuario (§7.3) y luego inserta `requirement_tasks` por `core.commit` con un `requestId` derivado. Idempotente: el mismo `requestId` devuelve la misma tarea. | `NOT_FOUND`, `TASKS_UNAVAILABLE 503`, `TASKS_FORBIDDEN 403` (sin acceso de editor en Tasks), `TASKS_REJECTED 422` (con el error de Tasks) |
| `GET requirements/tasks-status?ids=` | reader | Ids de `requirement_tasks` → `{items: [{id, done, deleted, title, revision, stale}]}` leyendo `tasks.targets` con el token del usuario. Sin acceso a Tasks: `unknown`. | — |
| `GET dashboard` | reader | `{computedAt, kpis: [{kpi, app, label, unit, period, value, target, state}], unavailable: [app]}`. Lee las proyecciones de §7.2 con la service key y aplica `kpi_targets`. Una app sin proyección o caída va en `unavailable`, no rompe el panel. | — |
| `GET people/:id/account` | owner | Cuenta enlazada con sus accesos por app (filtra `admin/accounts` por `userId`). | `NOT_FOUND` |
| `GET people/records/:id/file` | editor | URL firmada (10 min) del archivo de un registro de documentación, solo si el actor ve la fila (§5); mientras no exista P1. | `NOT_FOUND` (también si no la ve) |
| `POST people/:id/account` | owner | `{email?, memberships: [{app, role, scopes?}]}` → hace `admin/invite` (correo por defecto de `person_private.email`) y enlaza `people.user_id` en el mismo paso; devuelve la contraseña temporal una sola vez. | los de `admin/invite`; `ALREADY_LINKED 409` |

No hay rutas propias de escritura para personas, requisitos ni documentos: todo va por `commands`, para que funcione sin red.

---

## 7. Proyecciones y enlaces

### 7.1 Lo que publica Central

| Vista | Lectora | Columnas | Motivo |
|---|---|---|---|
| `central.booking_person_projection` | booking | `person_id, code, display_name, base_role, active, revision` | Booking ya prevé `staff_assignments.person_ref_*` para elegir a la persona del turno sin copiarla (§15.3 de su `API.md`). Solo el nombre visible y la función, nunca contacto. **Se publica cuando Booking lo pida**; nota: Booking lo apunta como `target_app = 'encarna'` y debería ser `'central'`. |
| `central.booking_blocking_projection` (V2) | booking, tasks | `requirement_id, code, name, blocks_operation, state, expires_on` de requisitos vencidos que bloquean la operación | C09 «bloquea operación»: aviso en Booking y Tasks. Se propone; no entra en V1. |
| `central.<destino>_kpi_projection` de Central | central | Como §7.2 | Vencimientos y riesgos también son KPIs del panel. |

### 7.2 Contrato de KPIs (lo que Central pide a cada app)

Cada app que quiera aparecer en el panel publica **una** vista `<schema>.central_kpi_projection` y la registra con `core.allow_read('central', '<schema>.central_kpi_projection', 'view')`:

```text
kpi          text         clave '<app>.<nombre>', estable (p. ej. 'booking.occupancy_rate')
period       text         'actual' | 'AAAA-MM' | 'AAAAT1'..'T4' | 'AAAA'
period_start date null
period_end   date null
value        numeric      siempre numérico; null si no hay dato
unit         text         'count' | 'pct' | 'eur' | 'nights' | 'persons' | 'days'
computed_at  timestamptz  now() en la vista
```

Reglas: solo agregados, ningún dato personal ni importe por persona; horizonte fijo (los 12 meses anteriores, el actual y los 3 siguientes) porque las vistas no reciben parámetros; la clave y su significado se documentan en el `API.md` de la app dueña, y Central mantiene en `_domain/central/kpis.ts` el catálogo con etiqueta, unidad y sentido. **Nada se copia**: el panel se calcula al abrirlo y se guarda en el dispositivo solo como caché con su hora.

Catálogo inicial que propongo a cada equipo (de los 20 KPIs base de C01, los que tienen dato en las apps actuales):

| App | Claves propuestas |
|---|---|
| Booking | `reservations_confirmed_90d`, `guests_expected_90d`, `events_next_30d`, `deposits_pending`, `occupancy_rate` (mensual, cuando haya espacios), `staff_needs_open`, `leads_new` y `leads_converted` (cuando exista el CRM) |
| Invoices/Finance | `expenses_month` (total de facturas validadas por mes), `invoices_pending_review`, `invoices_unpaid` (recuento) y `invoices_unpaid_amount`, `income_issued_month` (emitidas) |
| Tasks | `tasks_open`, `tasks_overdue`, `purchase_requests_open`, `supplies_below_min`, `preventive_overdue` (cuando haya recurrencias) |
| Food | `events_without_menu_30d`, `shopping_lists_open` |
| Central | `legal_due_30d`, `legal_overdue`, `risks_critical_open`, `people_records_expired` |

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
- Borrado de archivos (Booking P6): al sustituir un documento, el anterior queda en el bucket. Aceptable en V1.

---

## 9. Pantallas y navegación

Cuatro entradas en la barra, con el lanzador del kit en el icono de la cabecera:

### 9.1 Inicio (dirección)

Lectura: tarjetas de KPIs por app con estado (`ok`, `atencion`, `critico`) cuando haya proyecciones; mientras tanto, los de Central (vencimientos, riesgos, documentación de personas caducada) y accesos rápidos. Bloque «Vence pronto» (los 5 primeros de `central.due_items`). Móvil: una columna, tarjetas plegables por app.

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

Todo «Accesos» necesita red (lee y escribe en Core en el momento); sin conexión se muestra la última lista con su hora y los botones desactivados.

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
