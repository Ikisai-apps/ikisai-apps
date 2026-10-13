# Recursos · API del módulo común (espacios; inventario en R3)

Módulo del núcleo `resources` («Recursos»): espacios e inventario compartidos por todas las apps. Lo mantiene Core. Sus pantallas son componentes del kit (`createSpaceTree` y `createSpacePicker`, de UI) que cada app monta donde quiera. Diseño aprobado por el usuario el 13-10-2026 en `coordinacion/ampliacion/RECURSOS.md`. Este documento es la referencia técnica.

## 1. Cómo se sirve

- **Es un módulo, no una app.**
  - Está en `core.apps` con `kind = 'module'`, sin dominio ni PWA.
  - El lanzador (`GET /api/v1/apps`) y la administración de cuentas de Central no lo enseñan.
- **Cada Edge lo sirve** en `/api/v1/resources/…` con el mismo kit (`_kit/handler.ts`, `MODULES`). Así, desde `tasks.ikisai.com` es `/api/v1/resources/bootstrap`, sin CORS ni dominios nuevos.
- **Rutas:** las del núcleo de sincronización, con la misma semántica que las de cualquier app (contrato §5):

  | Ruta | Para qué |
  |---|---|
  | `GET bootstrap` | Rol, tablas y cursor del módulo |
  | `GET snapshot`, `GET changes` | Espejo y cambios |
  | `POST commands` | Escrituras (lote con `requestId`) |
  | `GET history`, `POST history/:cursor/undo-plan`, `POST history/:cursor/undo` | Historial y deshacer |
  | `POST trash/purge` | Vaciar la papelera |
  | `GET\|POST read/:name`, `POST invoke/:name` | Lecturas y acciones registradas |

  - No hay `members`, `invite`, `proposals` ni rutas de autenticación: la sesión es la de la app.
- **Pertenencia derivada:** quien es miembro de Booking, Tasks, Food, Finance (`invoices`) o Central lo es de Recursos, con el rol más alto que tenga en ellas.
  - Un agente, como mucho, es editor.
  - La mantiene un trigger del núcleo (`core.module_sources` y `core.sync_module_memberships`). Darla a mano falla con `MODULE_MEMBERSHIP_DERIVED`.
  - Los ámbitos (`scopes`) de la app de origen no pasan al módulo.
- **En el navegador**, un segundo `sync-client` (0.6.0) con la sesión del principal:

  ```ts
  const resources = createSyncClient({
    app: 'resources', apiBase: '/api/v1/resources',
    sessionFrom: client,            // el cliente de la app
    clearOnLogout: true,
  });
  await resources.start();
  ```

  - Refresca a través del principal y se cierra con él.
  - Su espejo va en `ikisai-resources-v1`, uno por dominio.
  - Funciona sin red como cualquier cliente.

## 2. Espacios (fase R1)

Árbol de cuatro niveles como mucho. Las alturas existen desde la migración (`Altura 1` a `Altura 5`, con su descripción en `notes`):

```
Altura 1–5 › Edificio | Exterior › Habitación, Sala, Baño, Cocina, Comedor, Oficina, Zona de paso, Instalación técnica, Almacén, Otro › Cama | Ubicación
```

### 2.1 `resources.spaces`

| Campo | Tipo | Qué es |
|---|---|---|
| `parent_id` | uuid o null | Padre; null = raíz (solo alturas y, durante la migración, edificios o exteriores «sin altura») |
| `kind` | text | Uno de `resources.space_kinds` |
| `name` | text, de 1 a 80 | Único entre hermanos (sin distinguir mayúsculas ni espacios de los lados) |
| `public_name` | text o null | El que ven huéspedes y organizadores; sin él, `name` |
| `code` | text o null | Código corto único (`[A-Za-z0-9._-]{1,20}`) |
| `position` | numeric | Orden entre hermanos |
| `active` | boolean | false = archivado |
| `notes` | text o null, hasta 1000 | Descripción (en las alturas, el subtítulo) |
| `attributes` | jsonb | Datos propios del tipo (2.3) |
| `source_refs` | text[] | De dónde viene: `tasks.label:<uuid>`, `booking.space:<uuid>`, `booking.bed:<uuid>`. Lo usa la fase R2 para enlazar; solo lo cambia el owner |

### 2.2 `resources.space_kinds` (tipos ampliables)

`kind`, `label`, `level` (1–4), `parents` (tipos de los que puede colgar; `root` = raíz), `attribute_keys`, `position` y `active`. Solo los escribe el owner. Semilla:

| Nivel | Tipos | Cuelgan de | Datos propios |
|---|---|---|---|
| 1 | `altura` | raíz | — |
| 2 | `edificio`, `exterior` | `altura` o raíz | `bookable`, `capacity`, `accessible` (Booking reserva el albergue entero) |
| 3 | `habitacion`, `sala`, `bano`, `cocina`, `comedor`, `oficina`, `zona_paso`, `instalacion`, `almacen`, `otro` | `edificio`, `exterior` | Según el tipo: `bookable`, `capacity`, `accessible`, `en_suite`, `storage` |
| 4 | `cama` | `habitacion`, `sala` | `bed_kind`, `capacity`, `extra_capacity` |
| 4 | `ubicacion` | `almacen`, `cocina`, `comedor`, `instalacion`, `otro` | `storage` |

### 2.3 Datos propios (`attributes`)

| Clave | Valor |
|---|---|
| `bookable`, `accessible`, `en_suite` | booleano |
| `capacity` | entero entre 0 y 999 (en una cama, las plazas fijas) |
| `extra_capacity` | entero entre 0 y 999: plazas supletorias que se pueden activar (litera partida 1 + 1; litera o sofá cama supletorio 0 + 2 o 0 + 1) |
| `bed_kind` | `individual`, `doble`, `litera` o `sofa_cama` |
| `storage` | `ambiente`, `frio` o `congelado` |

Una clave que el tipo no admite, o con otra forma, da `INVALID_SPACE_ATTRIBUTE`.

### 2.4 Reglas (hook `resources.check_spaces`, al final de cada lote)

| Regla | Error |
|---|---|
| El tipo existe | `INVALID_SPACE_KIND` |
| El padre es de un tipo permitido; sin ciclos; como mucho 4 niveles | `INVALID_SPACE_PARENT` |
| Una altura se llama `Altura 1`…`Altura 5` | `INVALID_SPACE_NAME` |
| Nada vivo dentro de algo borrado, ni activo dentro de algo archivado: se archiva o se borra **con todo lo de dentro en el mismo lote** | `ORPHAN_CHILD` |
| Un tipo en uso no se borra ni se archiva | `SPACE_KIND_IN_USE` |
| Nombre repetido entre hermanos, código repetido | `CONSTRAINT_VIOLATION` |
| **Editor:** cambia `name`, `public_name`, `code`, `notes`, `attributes` y `position`. **Crear, borrar, restaurar, mover (`parent_id`), cambiar `kind`, archivar (`active`) o tocar `source_refs`: owner** | `FORBIDDEN` |

En R2 se añadirá el bloqueo de archivar o borrar un espacio con reservas futuras, stock o tareas abiertas.

## 2.5 Lectura desde otras apps

- **Hooks y vistas:** las migraciones de cualquier app pueden **leer** `resources.spaces` y `resources.space_kinds`, por ejemplo para validar un `space_id` (lo permite el lint). Nunca escriben en ellas.
- **Referencias:** `space_id` es un uuid sin clave foránea entre schemas; lo valida el hook de la app (que esté vivo y activo).

## 3. Lo que viene

- **R1, segunda parte:** migración inicial con vista previa: zonas de Tasks («Zona: Espacio») y espacios y camas de Booking, cada zona en su altura.
- **R2:** Booking y Tasks leen de aquí.
- **R3:** inventario (artículos, unidades, lotes, movimientos, recuentos, costes) en este mismo módulo.
