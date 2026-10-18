# Recursos · API del módulo común (espacios e inventario)

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

## 3. Inventario (fase R3, migración 0802)

Diseño en `RECURSOS.md` §5 y §11.2. Escriben editor y owner; los tipos de artículo, solo el owner. Huéspedes, organizadores y outsiders no lo ven.

| Tabla | Campos | Notas |
|---|---|---|
| `item_kinds` | `kind`, `label`, `consumable`, `position`, `active` | 11 de partida. `consumable = false` (menaje, textil, herramienta, máquina): se cuentan, no se gastan |
| `items` | `name` (único), `kind`, `category`, `base_unit`, `min_quantity`, `reorder_quantity`, `default_space_id`, `default_supplier_id` (Finance), `tracks_lots`, `tracks_expiry`, `attributes`, `active`, `notes`, `source_refs` | Con movimientos no se borra (`ITEM_IN_USE`): se archiva |
| `item_units` | `item_id`, `unit`, `factor` (> 0, hacia la base), `supplier_id` | Distinta de la base (`INVALID_UNIT`) |
| `lots` | `item_id`, `code`, `expires_on` | |
| `movements` | `item_id`, `space_id`, `lot_id`, `quantity` (con signo, en la base), `kind`, `reason`, `unit_cost`, `transfer_id`, `count_id`, `source_app`, `source_ref`, `note`, `at` | **Solo se añaden** (`MOVEMENT_IMMUTABLE`) |
| `counts` y `count_lines` | `space_id` (null = todo), `note` · `count_id`, `item_id`, `space_id`, `lot_id`, `quantity` | Las líneas solo en abierto (`COUNT_CLOSED`) |
| `cost_entries` | `target_app`, `target_ref`, `amount`, `description`, `at` | Costes a mano de una tarea, proyecto o servicio |

**Reglas de los movimientos (`INVALID_MOVEMENT`):**
- `entrada_factura` y `entrada_manual` son positivas y son las únicas con `unit_cost`.
- `consumo_servicio`, `consumo_tarea` y `salida_manual` son negativas. `salida_manual` lleva `reason`: `uso`, `merma`, `rotura`, `caducado`, `regalo` u `otro`.
- `traslado` son dos filas con el mismo `transfer_id`: mismo artículo y lote, dos sitios distintos y suma cero (`INVALID_TRANSFER`).
- `ajuste_recuento` solo lo crea `resources.close_count`.
- Sitio vivo (`INVALID_SPACE`) y lote del artículo (`INVALID_LOT`).

**Recuento:** `{op: 'call', procedure: 'resources.close_count', args: {count_id}}` crea un `ajuste_recuento` por línea con la diferencia frente a lo calculado (artículo, sitio y lote) y cierra el recuento. Es parcial: lo que no se cuenta no cambia.

**Lecturas** (`read/resources.stock_levels` y `read/resources.item_costs`, con `where`):
- `stock_levels`: `item_id`, `space_id`, `lot_id`, `quantity`, `last_at`, solo las que no suman cero;
- `item_costs`: `item_id`, `average_cost` (ponderado con las entradas con coste) y `costed_quantity`.

Sin red, el cliente puede sumar `movements` de su espejo.

**Espacios:** uno con stock no se borra ni se archiva (`SPACE_HAS_STOCK`); primero se traslada.

**Apoyo a R4 y R5 (0803):**
- **Consumo por lotes:** `{op: 'call', procedure: 'resources.consume', args: {item_id, quantity, kind: 'consumo_servicio' | 'consumo_tarea', space_ids?, default_space_id?, source_app, source_ref, note?, at?}}`.
  - Gasta primero lo que caduca antes y después lo más antiguo.
  - Con `once: true` (0806), si ya hay consumos de ese artículo con el mismo `source_app` y `source_ref`, no hace nada (`skipped: 'already_consumed'`).
  - Lo que falta se apunta sin lote en `default_space_id` (o en el primer sitio pedido, o en el habitual del artículo), con `shortfall: true`.
- **`movement_costs`** (`movement_id`, `unit_cost`, `source_app`, `source_ref`): el coste que llega después a una entrada que entró sin él. Uno por entrada y solo se añade. `item_costs` lo usa.
- **`attributes.status`** de un artículo: `operativo`, `limitado`, `averiado` o `fuera_de_servicio` (`INVALID_ITEM_ATTRIBUTE`).
- **Cuadre de entradas (0804, R4):** `{op: 'call', procedure: 'resources.reconcile_entries', args: {source_app, entries: [{source_ref, item_id, space_id, quantity, unit_cost?, at?}], refs?}}`.
  - Deja cada `source_ref` y artículo con la cantidad neta pedida, creando la diferencia. Es idempotente.
  - El contrario (una `entrada_factura` negativa, con el coste y el sitio de lo que deshace) solo lo crea este procedimiento.
  - Un ref de `refs` sin entrada queda a 0 (anulación o vuelta a revisión).
  - `item_costs` cuenta los contrarios.
- **Lectura desde otras apps:** sus migraciones pueden leer `items`, `item_kinds`, `item_units`, `lots`, `movements`, `movement_costs`, `stock_levels` e `item_costs`, como los espacios.

## 4. Lo que viene

- **R1, segunda parte:** migración inicial con vista previa: zonas de Tasks («Zona: Espacio») y espacios y camas de Booking, cada zona en su altura.
- **R2:** Booking y Tasks leen de aquí.
- **R3, segunda parte:** piezas del kit (UI) y montaje en Tasks y Food. **R4–R6:** Finance, Food y Tasks enlazan con artículos y movimientos.
