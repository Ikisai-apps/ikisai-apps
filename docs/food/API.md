# Ikisai Food · API y modelo de datos (puerta G2)

Fecha: 6 de octubre de 2026. Autor: equipo Food. Estado: **aprobado provisionalmente por Core el 6 de octubre de 2026 (puerta G2)**; las respuestas a las peticiones están en §14.1.

Fuentes: `AGENTS.md`, `docs/core/PLAN.md`, `docs/core/CONTRATO_SINCRONIZACION.md` (v0.1, normativo), `docs/core/PLANTILLA_API_APP.md`; handoff V3 (`02_HANDOFF_TECNICO_CORE_V3.md` §12–§26 y §32, `08_CANON_FUNCIONAL_BOOKING_FOOD.md` §13–§33) y `sources/Gestion_cocina_profesional_retiro.txt` como referencia de campos. Además se ha leído el núcleo ya implementado (`20261006_0001_core_base.sql`, `_kit`, `sync-client`, `scripts/lint_migrations.mjs`), porque varias decisiones de este documento dependen de cómo se comporta hoy.

Donde el handoff y el contrato se contradicen manda el contrato. Las diferencias están reunidas en §13. Lo que Food pidió a Core y a Booking, y cómo quedó resuelto, está en §14.

---

## 1. Dominio y límites

Food resuelve la cocina de un retiro: recetario con foto, maquinaria, menú por evento, lista de compra derivada, plan de preparación y la vista del menú para el organizador.

| Food es dueño de | Food lee de otros | Food no hace en V1 |
|---|---|---|
| recetas, ingredientes, maquinaria, menús, servicios, platos, lista de compra, preparación, entradas de stock (V2) | `booking.food_event_projection` (evento, personas, régimen, restricciones sin identificar, revisión) | inventario de despensa, caducidades, escandallos, APPCC, temperaturas, turnos, variantes de receta, galería de fotos, IA de menús, optimizador de maquinaria, envío de pasos a Tareas |

Reglas de frontera:

- Food **no copia la reserva**. De Booking solo guarda `event_id`, la revisión del evento contra la que se revisó el menú y una foto mínima de lo que se revisó (para poder decir «22 → 25 personas»). Nunca recibe huéspedes, documentos ni datos SES.
- Las restricciones alimentarias son de Booking. Food las muestra y las compara con sus recetas; no las edita.
- Las compras reales son de Invoices. En V1 Food solo publica ingredientes y maquinaria como destinos de asignación (§7.2). Las entradas de stock llegan en V2.
- Sin ámbitos: quien es miembro de `food` ve todo. Roles del núcleo: `reader` consulta, `editor` cocina, `owner` además administra miembros y vacía la papelera.

---

## 2. Tablas sincronizables (`food.*`)

Todas llevan las columnas del contrato §2.1 (`id`, `revision`, `created_at`, `updated_at`, `updated_by`, `deleted_at`) y se registran con `core.register_table('food', 'food', …)` en la migración que las crea, con los roles por defecto (`reader, editor, owner` leen; `editor, owner` escriben) y `never_purge = false`. No se repiten abajo.

Convenciones del schema:

- **Unidades** (`unit`, `preferred_unit`): `g kg ml l unidad paquete manojo otro`, como `check`. Solo se convierte dentro de masa (`g`↔`kg`) y de volumen (`ml`↔`l`).
- **Cantidades**: `numeric(12,3)`; raciones `numeric(8,2)`. Nunca negativas.
- **Orden manual**: `position numeric` (contrato §2.1), no `integer`.
- **Tablas puente** (`recipe_ingredients`, `recipe_equipment`) llevan `id` propio como cualquier tabla sincronizable; no hay clave primaria compuesta.
- **Columnas reservadas**: columnas que solo escriben los procedimientos de §3. Tienen que figurar en `writable_columns` porque `core.apply_row_op` valida contra esa lista, pero `beforeCommit` las rechaza en operaciones de fila (`INVALID_FIELDS`). Se marcan con ®.
- **FK al padre inmutable**: la columna que cuelga una fila de su padre (`recipe_id`, `menu_id`, `service_id`, `shopping_list_id`) se fija al insertar y no cambia.
- **Sin códigos humanos**: Food no registra prefijos en `core.next_code`. Recetas y menús se crean con `insert` offline y un código exigiría pasar por el servidor; el menú se identifica por el `EVT_…` de su evento y la receta por su nombre.

### 2.1 Catálogo

```text
food.recipes
  name                 text not null            1..160
  public_name          text                     nombre para el organizador; si falta se usa name
  public_description   text                     ≤ 600; sale en el menú del organizador
  category             text not null            desayuno | entrante | principal | guarnicion | postre |
                                                picnic | merienda | bebida | base | otro
  base_servings        numeric(8,2) not null    > 0; las cantidades de ingredientes se refieren a estas raciones
  method               text                     elaboración
  conservation         text
  freezable            boolean not null default false
  regeneration         text
  service_notes        text
  prep_minutes         integer                  0..2880; antelación para la propuesta de preparación
  status               text not null default 'en_prueba'    en_prueba | validada | archivada
  diet_tags            text[] not null default '{}'         ⊆ {vegetariano, vegano, sin_gluten, sin_lactosa}
  allergens            text[] not null default '{}'         ⊆ los 14 del Reglamento UE 1169/2011 (ver abajo)
  allergens_checked    boolean not null default false       «he revisado los alérgenos»; obligatorio para validada (trigger)
  photo_file_id        uuid                     core.files, versión de 1600 px
  photo_thumb_file_id  uuid                     core.files, miniatura de 480 px
writable: todas.  Índices: lower(name) y status, ambos where deleted_at is null.
```

Alérgenos: `gluten crustaceos huevos pescado cacahuetes soja lacteos frutos_de_cascara apio mostaza sesamo sulfitos altramuces moluscos`. `allergens_checked` existe porque una lista vacía es ambigua: «no tiene» y «nadie lo ha mirado» no pueden guardarse igual cuando hay una alergia en el grupo.

```text
food.ingredients
  name                text not null     1..120
  preferred_unit      text not null default 'g'
  preferred_supplier  text
  active              boolean not null default true
writable: todas.  Único: lower(btrim(name)) where deleted_at is null.

food.recipe_ingredients
  recipe_id      uuid not null → food.recipes        on delete cascade, inmutable
  ingredient_id  uuid not null → food.ingredients    on delete restrict
  quantity       numeric(12,3) not null   > 0, para base_servings
  unit           text not null
  position       numeric not null default 0
  notes          text
writable: todas.  Índices: recipe_id, ingredient_id.

food.equipment
  name      text not null     1..120
  category  text              libre, ≤ 60 (horno, fuego, olla…)
  quantity  integer not null default 1    ≥ 0
  capacity  text
  location  text
  status    text not null default 'operativo'    operativo | limitado | averiado | fuera_de_servicio
  notes     text
writable: todas.

food.recipe_equipment
  recipe_id          uuid not null → food.recipes      on delete cascade, inmutable
  equipment_id       uuid not null → food.equipment    on delete restrict
  quantity_required  integer not null default 1        ≥ 1
  notes              text
writable: todas.
```

Un mismo ingrediente puede aparecer dos veces en una receta: no hay único sobre `(recipe_id, ingredient_id)`. La interfaz lo evita y el cálculo de compra suma, así que dos dispositivos que añaden la misma línea sin red no provocan un rechazo.

### 2.2 Menú

```text
food.menus
  event_id                      uuid not null → booking.events(id)   on delete restrict, inmutable
  source_event_revision         bigint not null   ≥ 1; revisión del evento contra la que se revisó el menú (§2.4)
  source_event_snapshot         jsonb             lo que se revisó: {guest_count, start_date, end_date, meal_plan, menu_style, restrictions[]}
  status                        text not null default 'borrador'     borrador | revisar | validado | cerrado   ®
  validated_at                  timestamptz   ®
  validated_by                  uuid → auth.users   ®
  validated_warnings            jsonb         ®   avisos aceptados al validar: [{key, kind, text}]
  preparation_generated_at      timestamptz   ®
  preparation_source_revisions  jsonb         ®   §2.4
  notes                         text
  closing_notes                 text              cierre de cocina (canon §31): raciones reales, sobras, reposición, mejoras
  organizer_shared              boolean not null default false   cocina lo comparte con el organizador (§7.5)
writable: event_id, source_event_revision, source_event_snapshot, notes, closing_notes, organizer_shared + reservadas.
Único: event_id where deleted_at is null   (un menú por evento en V1)

food.menu_services
  menu_id       uuid not null → food.menus   on delete cascade, inmutable
  service_date  date not null
  service_type  text not null     desayuno | comida | cena | picnic | merienda | otro
  service_time  time
  position      numeric not null default 0
  notes         text
writable: todas.  Índice: (menu_id, service_date, position).

food.menu_items
  service_id  uuid not null → food.menu_services   on delete cascade, inmutable
  recipe_id   uuid not null → food.recipes         on delete restrict
  servings    numeric(8,2) not null   > 0
  position    numeric not null default 0
  notes       text
writable: todas.  Índices: service_id, recipe_id.

food.menu_comments                comentarios del organizador desde su portal (§7.5)
  menu_id       uuid not null → food.menus   on delete cascade   ®
  service_id    uuid → food.menu_services   on delete set null   ®
  menu_item_id  uuid → food.menu_items      on delete set null   ®
  kind          text not null     prefiero_que_no | comentario   ®
  message       text              ≤ 1000   ®
  author_id     uuid → auth.users   ®
  status        text not null default 'nuevo'   nuevo | visto | resuelto
  reply         text              ≤ 1000; respuesta de cocina, la ve el organizador
Los crea solo food.portal_menu_comment; en Food solo cambian status y reply (lo demás, inmutable por trigger).
```

`source_event_revision` y `source_event_snapshot` se escriben con `insert` al crear el menú; después solo las cambian `food.acknowledge_event` y `food.validate_menu`.

Las adaptaciones alimentarias son recetas propias y platos propios del servicio («Curry normal 16», «Curry adaptado 2»). No hay variantes.

### 2.3 Compra, preparación y stock

```text
food.shopping_lists
  menu_id           uuid not null → food.menus   on delete cascade   ®
  status            text not null default 'borrador'    borrador | revisada | cerrada
  generated_at      timestamptz not null   ®
  source_revisions  jsonb not null         ®   §2.4
  notes             text
writable: status, notes + reservadas.  Único: menu_id where deleted_at is null.

food.shopping_list_items
  shopping_list_id   uuid not null → food.shopping_lists   on delete cascade, inmutable
  ingredient_id      uuid not null → food.ingredients      on delete restrict
  required_quantity  numeric(12,3) not null default 0   ®   calculada
  unit               text not null                      ®   salvo al insertar una línea manual
  stock_quantity     numeric(12,3)                          lo que ya hay en casa; a mano en V1
  purchase_quantity  numeric(12,3) not null                 lo que se compra
  supplier           text
  status             text not null default 'pendiente'      pendiente | comprado | recibido
  manual_override    boolean not null default false         purchase_quantity fijada a mano
  manual             boolean not null default false         línea añadida a mano, ajena al cálculo
  notes              text
writable: shopping_list_id, ingredient_id, unit, stock_quantity, purchase_quantity, supplier, status,
          manual_override, manual, notes + reservadas.
Único: (shopping_list_id, ingredient_id, unit) where deleted_at is null and not manual.

food.preparation_items
  menu_id         uuid not null → food.menus    on delete cascade, inmutable
  menu_item_id    uuid → food.menu_items        on delete set null; lo rellena la propuesta
  recipe_id       uuid → food.recipes           on delete set null
  scheduled_date  date
  scheduled_time  time
  text            text not null   1..300
  responsible     text
  done            boolean not null default false
  position        numeric not null default 0
  manual          boolean not null default false    creada o reescrita por el cocinero
writable: todas.  Índice: (menu_id, scheduled_date, scheduled_time, position).
```

`purchase_quantity` vale `max(required_quantity − stock_quantity, 0)` mientras `manual_override` sea falso; al cambiarla a mano la interfaz pone `manual_override = true` en la misma operación. Quién revisó la lista y cuándo se lee en `core.changes`; no hay `validated_at` propio.

`food.stock_entries` queda **definida aquí y sin migración en V1**. Se crea en G4 junto con la proyección de Invoices que la alimenta (§7.3), para no fijar en una migración inmutable una forma que todavía depende de `docs/invoices/API.md`.

```text
food.stock_entries   (V2)
  ingredient_id    uuid not null → food.ingredients
  entry_date       date not null
  quantity         numeric(12,3) not null   > 0
  unit             text not null
  cost_amount      numeric(12,2)
  supplier         text
  event_id         uuid → booking.events(id)     compra hecha para un retiro concreto
  source_app       text not null     invoices | manual
  source_kind      text              allocation
  source_id        uuid
  source_revision  bigint
  notes            text
Único: (source_app, source_kind, source_id) where source_id is not null and deleted_at is null.
```

### 2.4 Obsolescencia por revisiones

No se guarda ningún indicador `stale`. Todo se calcula comparando revisiones (contrato §8).

**Evento → menú.** El menú está desactualizado cuando `event_revision` de la proyección es mayor que `menus.source_event_revision`. Se muestra «La información del evento ha cambiado. Revisar antes de validar» y, comparando la proyección con `source_event_snapshot`, qué cambió (personas, fechas, régimen, restricciones). Esto exige que `event_revision` cambie cuando cambia **cualquier** dato proyectado, también los que viven en `booking.reservations` y `booking.dietary_restrictions` (petición P5).

- Menú en `borrador` o `revisar`: «He revisado los cambios» llama a `food.acknowledge_event`, que sube `source_event_revision` a la actual.
- Menú `validado` o `cerrado`: no se toca en silencio. «Sigue siendo válido» repite `food.validate_menu`, que vuelve a calcular los avisos contra las restricciones nuevas; «Reabrir para cambiar» lo pasa a `revisar`.

**Menú → compra y preparación.** La revisión de la fila `menus` no sirve como origen: no cambia cuando cambian sus servicios o sus platos, y sí cambia al validar o cerrar, que no altera cantidades. Hacer que los hijos toquen al padre con un trigger se descartó porque rompe el deshacer del núcleo: el plan de `core.undo_plan` fija la `expectedRevision` del menú y la primera operación inversa sobre un plato la dejaría anticuada.

En su lugar cada artefacto derivado guarda el conjunto de revisiones de las filas con las que se generó, `source_revisions jsonb`, con la forma `{"<id de fila>": <revisión>}`:

| Artefacto | Columna | Filas que entran |
|---|---|---|
| Lista de compra | `shopping_lists.source_revisions` | platos vivos del menú, sus recetas, las líneas vivas de `recipe_ingredients` de esas recetas y sus ingredientes |
| Preparación | `menus.preparation_source_revisions` | servicios vivos, platos vivos y sus recetas |

El artefacto está desactualizado cuando el conjunto recalculado sobre el espejo local difiere del guardado, o cuando alguna fila implicada tiene cambios locales pendientes. Es obsolescencia por revisiones aplicada a un conjunto: detecta filas añadidas, quitadas y modificadas, y permite decir qué plato o qué receta cambió. Lo escribe el procedimiento en SQL y lo compara `domain-food` en el cliente; no hay hash que deba coincidir entre dos implementaciones. Un menú de siete días ronda 650 entradas (unos 30 KB).

La cadena completa del recorrido H: Booking cambia 22 → 25 → sube `event_revision` → aviso en el menú → el cocinero reabre o ajusta raciones → cambian revisiones de platos → aviso en compra y preparación → regeneración consciente. Nada se recalcula solo.

### 2.5 Papelera y purga

- Borrar un padre borra a sus hijos en el mismo lote. `domain-food` construye el lote (`deleteMenuBatch`, `deleteServiceBatch`, `deleteRecipeBatch`); restaurar es deshacer ese lote desde el historial.
- No se borra lo que está en uso: una receta con platos vivos (`RECIPE_IN_USE`, se archiva), un ingrediente con líneas vivas (`INGREDIENT_IN_USE`, se desactiva), una máquina requerida por recetas vivas (`EQUIPMENT_IN_USE`, se marca fuera de servicio).
- No se inserta ni se restaura un hijo bajo un padre borrado, ni un plato con una receta borrada (`PARENT_DELETED`).
- «Vaciar papelera» envía `tables` de hijos a padres: `shopping_list_items, shopping_lists, preparation_items, menu_items, menu_services, menus, recipe_ingredients, recipe_equipment, recipes, ingredients, equipment`. Con ese orden y las reglas anteriores ningún `DELETE` físico encuentra referencias vivas; los `on delete cascade` y `set null` son red de seguridad.

---

## 3. Procedimientos (`call`)

Firma común `food.<proc>(p jsonb) returns jsonb`, con `p = {app, actor, role, requestId, cursor, args}` tal como los invoca `core.commit`. Todas las escrituras van por `core.apply_row_op` con la revisión leída dentro de la transacción. Se registran con `core.allow_procedure('food', …)`.

Todo error de dominio es **422**. Aparte de los conflictos de versión, que gestiona él mismo, `sync-client` solo retira de la cola los lotes rechazados con 422; cualquier otro estado lo trata como fallo transitorio y reintenta, lo que bloquearía la cola (§10.4).

Un lote con `call` no se puede deshacer desde el historial (`UNDO_UNAVAILABLE`, comportamiento del núcleo). Los procedimientos de estado tienen su transición inversa; las regeneraciones se repiten.

| Procedimiento | `args` | Filas que toca | Resultado | Errores |
|---|---|---|---|---|
| `food.acknowledge_event` | `menu_id`, `expectedRevision`, `event_revision`, `event_snapshot` | `menus` | `{menu_id, source_event_revision}` | `VERSION_CONFLICT`, `MENU_LOCKED`, `EVENT_CHANGED` |
| `food.validate_menu` | `menu_id`, `expectedRevision`, `event_revision`, `event_snapshot`, `acknowledged[]` | `menus` | `{menu_id, status, validated_at}` | `VERSION_CONFLICT`, `INVALID_TRANSITION`, `MENU_EMPTY`, `EVENT_CHANGED`, `MENU_WARNINGS_UNACKNOWLEDGED` |
| `food.set_menu_status` | `menu_id`, `expectedRevision`, `status` | `menus` | `{menu_id, status}` | `VERSION_CONFLICT`, `INVALID_TRANSITION` |
| `food.regenerate_shopping` | `menu_id`, `list_id` | `shopping_lists`, `shopping_list_items` | `{list_id, created, inserted, updated, deleted, kept, status}` | `MENU_NOT_FOUND`, `LIST_CLOSED` |
| `food.regenerate_preparation` | `menu_id` | `preparation_items`, `menus` | `{inserted, updated, deleted, kept}` | `MENU_NOT_FOUND` |

### 3.1 Estados del menú

```text
borrador ⇄ revisar ──validate_menu──▶ validado ⇄ cerrado
                ◀──── reabrir ──────────┘
```

- `set_menu_status` admite `borrador→revisar`, `revisar→borrador`, `validado→revisar` (reabrir), `validado→cerrado` y `cerrado→validado`.
- `validate_menu` admite `borrador|revisar→validado` y `validado→validado` (revalidar tras un cambio del evento). Exige al menos un servicio vivo con un plato vivo. Escribe `status`, `validated_at = now()`, `validated_by`, `validated_warnings`, `source_event_revision` y `source_event_snapshot`.
- Las dos comprobaciones que no caben en SQL las hace la Edge en `beforeCommit` (§4.1): que `event_revision` sea la actual de la proyección y que `acknowledged` cubra todos los avisos. Las migraciones de Food no pueden leer `booking.food_event_projection` (el lint solo permite la FK a `booking.events`), así que el procedimiento recibe esos datos ya verificados.
- Con el menú `validado` o `cerrado` no se editan servicios ni platos (`MENU_LOCKED`). Siguen editables `notes`, `closing_notes`, la lista de compra y la preparación.

### 3.2 `food.regenerate_shopping`

1. Lee el menú. Si no hay lista viva la crea con `list_id` (uuid del cliente). Si la lista está `cerrada` falla con `LIST_CLOSED`.
2. Para cada plato vivo de cada servicio vivo: `factor = servings / base_servings` de su receta; para cada línea viva de `recipe_ingredients`, `cantidad = quantity × factor`.
3. Agrupa por ingrediente y familia de unidad. Masa se suma en gramos y volumen en mililitros; `unidad`, `paquete`, `manojo` y `otro` son cada una su propia familia y no se mezclan.
4. Unidad de salida: en masa y volumen, la `preferred_unit` del ingrediente si es de esa familia; si no, `kg` o `l` a partir de 1000 y `g` o `ml` por debajo. `required_quantity` se redondea a tres decimales al final.
5. Línea calculada existente (mismo ingrediente y familia, `manual = false`): actualiza `required_quantity` y `unit`. Si cambia la unidad dentro de la familia convierte `stock_quantity` y `purchase_quantity`. Si `manual_override` es falso recalcula `purchase_quantity`. No toca `supplier`, `status` ni `notes`.
6. Línea nueva: `supplier = preferred_supplier`, `purchase_quantity = required_quantity`, `status = pendiente`.
7. Línea calculada que ya no hace falta: se borra si está `pendiente` y sin `manual_override`; si no, se conserva con `required_quantity = 0` para no perder que ya se compró.
8. Las líneas `manual = true` no se tocan.
9. Actualiza la lista: `generated_at`, `source_revisions` y, si estaba `revisada`, vuelve a `borrador`.

Se puede generar con el menú en cualquier estado; si no está validado la interfaz marca la lista como provisional.

`domain-food` implementa el mismo cálculo como función pura (`computeShopping`) para la vista de cocinero (ingredientes escalados por plato) y para la vista previa. Los casos de `tests/food/fixtures/shopping/*.json` se ejecutan contra la función TypeScript y contra el procedimiento en PGlite y deben dar el mismo resultado.

### 3.3 `food.regenerate_preparation`

Propuesta determinista y deliberadamente simple: una fila por plato vivo, «Preparar ‹nombre de la receta›», con `scheduled_date` la del servicio y `scheduled_time = service_time − prep_minutes` (120 minutos si la receta no lo indica; sin hora si el servicio no la tiene; si la resta cruza la medianoche pasa al día anterior).

- Fila propuesta (`manual = false`) cuyo plato sigue vivo y no está hecha: se actualizan texto y horario si difieren.
- Plato vivo sin fila enlazada por `menu_item_id`: se inserta.
- Fila propuesta cuyo plato ya no existe: se borra, salvo que esté hecha.
- Filas con `manual = true` o `done = true`: no se tocan. La interfaz pone `manual = true` cuando el cocinero cambia el texto o el horario de una fila propuesta; marcar `done` o `responsible` no la convierte en manual.
- Escribe `preparation_generated_at` y `preparation_source_revisions` en el menú.

Los pasos no se envían a Tareas. «Crear tarea en Ikisai» para necesidades permanentes queda fuera de V1.

---

## 4. Hooks de validación

### 4.1 `beforeCommit` (Edge, reglas de `domain-food`)

Reglas puras, las mismas que corren en el cliente antes de encolar:

- Tipos, obligatorios, longitudes, enumerados, rangos y vocabularios de `diet_tags` y `allergens`. Todo lo que PostgreSQL rechazaría con un `check` o un error de conversión se rechaza antes con `INVALID_FIELDS` y el campo en `details`.
- Columnas reservadas ® fuera de un `call` → `INVALID_FIELDS`.
- `shopping_list_items`: un `insert` exige `manual = true` y `required_quantity` ausente o 0; con `manual_override = false`, `purchase_quantity` debe ser coherente con `stock_quantity` cuando el lote trae ambos.
- `recipes`: una operación que trae `status = 'validada'` y `allergens_checked = false` se rechaza (`ALLERGENS_UNCHECKED`); el caso en que solo viaja uno de los dos campos lo resuelve el trigger de §4.2.
- `menus`: `source_event_revision` y `source_event_snapshot` solo se aceptan en `insert`.

Reglas que leen datos:

- `insert` en `food.menus`: el evento existe en la proyección y `source_event_revision` no supera la revisión actual.
- `food.acknowledge_event` y `food.validate_menu`: `event_revision` es la actual de la proyección; si no, `EVENT_CHANGED` con la actual en `details`.
- `food.validate_menu`: recalcula los avisos con `menuWarnings` (§4.3) sobre el evento y el grafo del menú; si `acknowledged` no cubre todas las claves que requieren aceptación, `MENU_WARNINGS_UNACKNOWLEDGED` con la lista completa.

Entre `beforeCommit` y la transacción hay una ventana mínima. No compromete nada: si el evento cambia justo después, `source_event_revision` queda por debajo de la actual y el menú aparece desactualizado en la siguiente lectura.

No hay `afterCommit`.

### 4.2 Reglas en SQL

Food no registra `validate_hooks`: sus invariantes dependen de la fila que se escribe y se resuelven mejor con triggers del schema `food`, que fallan con `core.fail(código, 422, detalles)` dentro de la misma transacción. Un hook de fin de lote no puede saber qué filas tocó el lote, porque las migraciones de app no pueden leer `core.changes`. Los commits de una app están serializados por el bloqueo de `core.app_state`, así que estas comprobaciones no tienen carreras.

| Trigger | Tablas | Regla | Código |
|---|---|---|---|
| `guard_parent` | todas las que cuelgan de un padre | FK al padre inmutable; no insertar ni restaurar bajo un padre borrado | `IMMUTABLE_FIELD`, `PARENT_DELETED` |
| `guard_recipe` | `recipes` | `validada` exige `allergens_checked` | `ALLERGENS_UNCHECKED` |
| `guard_menu_children` | `menu_services`, `menu_items` | menú `validado` o `cerrado` no admite cambios en servicios ni platos | `MENU_LOCKED` |
| `guard_menu` | `menus` | `event_id` inmutable; un menú por evento; no borrar un menú validado o cerrado | `IMMUTABLE_FIELD`, `MENU_EXISTS {menuId}`, `MENU_LOCKED` |
| `guard_ingredient_name` | `ingredients` | nombre único sin distinguir mayúsculas | `DUPLICATE_NAME {existingId}` |
| `guard_in_use` | `recipes`, `ingredients`, `equipment` | no borrar lo que tiene referencias vivas | `RECIPE_IN_USE`, `INGREDIENT_IN_USE`, `EQUIPMENT_IN_USE` |
| `guard_item_recipe` | `menu_items` | la receta del plato no está borrada | `PARENT_DELETED` |
| `guard_shopping` | `shopping_lists`, `shopping_list_items` | lista `cerrada` no admite cambios en sus líneas; un cambio de `status` sí | `LIST_CLOSED` |

Los `check`, los índices únicos y las FK quedan como última línea. Una violación de restricción llega como 422 `CONSTRAINT_VIOLATION` con `details.sqlstate` (contrato §5.2), que el cliente aparta de la cola pero no sabe explicar; por eso los dos casos alcanzables por un usuario normal, nombre de ingrediente repetido y segundo menú para un evento, tienen además trigger con un código propio y el `id` de la fila existente.

### 4.3 Avisos del menú (`menuWarnings`)

Función pura de `domain-food`. Corre en el cliente para pintar la cabecera del menú y en la Edge al validar. Devuelve `{key, kind, requiresAck, text}` con `key` estable.

| Restricción del evento | Aviso | Requiere aceptación |
|---|---|---|
| `alergia`, `intolerancia` | uno por plato cuya receta declara el alérgeno, o que tiene un ingrediente cuyo nombre coincide con el `subject` | sí |
| `alergia`, `intolerancia` con un `subject` que no se reconoce | «No se puede comprobar automáticamente: revisar a mano» | sí |
| cualquier `alergia` o `intolerancia` | uno por receta del menú con `allergens_checked = false` | sí |
| `vegano`, `vegetariano`, `sin_gluten`, `sin_lactosa` | uno por servicio sin ningún plato compatible | sí |
| `preferencia`, `otra` | informativo | no |
| — | servicio fuera de las fechas del evento; receta `archivada` o `en_prueba` en el menú | no |

Compatibilidad: `vegano` exige la etiqueta `vegano`; `vegetariano` exige `vegetariano` o `vegano`; `sin_gluten` y `sin_lactosa` exigen que la receta no declare `gluten` o `lacteos`. El `subject` libre de Booking («pistacho») se normaliza y se busca en un diccionario de sinónimos de `domain-food` (pistacho, nuez, almendra, avellana, anacardo → `frutos_de_cascara`; etcétera) y en los nombres de los ingredientes de la receta.

Los avisos nunca impiden editar un borrador. Impiden validar sin aceptarlos uno a uno, y lo aceptado queda en `validated_warnings`. Una alergia nunca se trata como preferencia.

---

## 5. Visibilidad

Food no usa `memberships.scopes` ni define el hook `visible`. La visibilidad es la membresía.

---

## 6. Rutas propias (`/api/v1/...`)

Además de las del núcleo (contrato §5), con `uploads` configurado como en §8.

| Método y ruta | Entrada | Salida | Errores | Rol |
|---|---|---|---|---|
| `GET events` | `scope=upcoming` (por defecto: `end_date ≥ hoy − 7 días`) o `scope=all`; `from`, `to` opcionales | `{events: [fila de la proyección], serverTime}` | `PROJECTION_UNAVAILABLE 503` | `reader` |
| `GET events/:id` | — | `{event}` | `NOT_FOUND 404` | `reader` |
| `POST equipment/:id/fault` | `{name, status: limitado\|averiado\|fuera_de_servicio, location?, note?}` | `{created, routed, taskId}` | `INVALID_OPERATION 422`, `TASKS_FORBIDDEN 403`, `TASKS_REJECTED 422`, `TASKS_UNAVAILABLE 503` | `editor` |

Son las únicas. Lo que el handoff §25 listaba como rutas REST de cocina lo cubren `snapshot`, `changes` y `commands` sobre las tablas de §2; las regeneraciones son `call`. El panel de Inicio, la vista de cocinero y la del organizador se calculan en el cliente sobre el espejo local, que es lo que permite verlos sin red; no hay `GET dashboard`.

### 6.1 Peticiones a Tasks

Desde la ficha de una máquina que no está operativa, «Avisar a Tasks para repararla» llama a `POST equipment/:id/fault`, y la Edge de Food pide a Tasks con el token de la persona (`POST https://tasks.ikisai.com/api/v1/requests/task`, docs/tasks/API.md §19.6 y §20):
- `source: 'food'`, `kind: 'food.equipment_fault'`, `kind_label: 'Averías de cocina'`, sin área ni proyecto: Tasks la enruta con las reglas del usuario o la deja en «Por clasificar».
- `external_ref: 'equipment_fault:<id de la máquina>:<día en Madrid>'`: como mucho una petición por máquina y día; repetir el aviso devuelve la misma tarea (`created: false`).
- Título «Reparar: <nombre> (<ubicación>)» (averiada o fuera de servicio, prioridad `high`) o «Revisar: …» (limitada, `normal`); la nota es la de la ficha; `external_url` = `https://food.ikisai.com/#/maquinaria`.
- Necesita red y permiso de edición en Food; en Tasks, el de la persona (sin él, `TASKS_FORBIDDEN`). La base de Tasks sale de `IKISAI_TASKS_API_BASE` (por defecto `https://tasks.ikisai.com`).

V2 (G4): `POST stock-entries/sync`, que lee la proyección de compras de Invoices y crea las entradas de stock (§7.3).

---

## 7. Proyecciones y enlaces

### 7.1 Lo que Food consume: `booking.food_event_projection`

La lee la Edge de Food como lectura registrada (contrato §5.1: Booking la registra con `core.allow_read('food', 'booking.food_event_projection', 'view')`) y la sirve en `GET events`. Booking la publicó el 6 de octubre de 2026 (`20261006_0006_booking_guests.sql`) con las columnas del contrato y las cuatro de su ampliación (`reservation_status`, `guest_count_is_final`, `requires_meals`, `meal_notes`); las restricciones llegan como `{type, subject, severity, servings, kitchen_notes}`. La vista de pruebas `food.event_projection_stub`, que cubrió el hueco unas horas, se retiró en `20261006_0140_food_retire_event_stub.sql`. Columnas del contrato: `event_id, event_code, reservation_code, title, event_type, start_date, end_date, arrival_time, departure_time, guest_count, minors_count, meal_plan, menu_style, dietary_restrictions, event_revision`. Food necesita además lo siguiente (petición P5, a cerrar con Booking):

| Necesidad | Para qué |
|---|---|
| `reservation_status`, o al menos un booleano `active` | una reserva cancelada conserva su evento; Food debe dejar de pedir menú y compra |
| `guest_count_is_final` | distinguir personas finales de previstas en la cabecera y en Inicio |
| `meal_notes` | las notas de alimentación de la reserva son dato de servicio |
| forma fija de `dietary_restrictions`: `[{restriction_type, subject, severity, servings, kitchen_notes}]`, sin `guest_id` ni nombre | cabecera de restricciones y `menuWarnings` |
| `event_revision` monótona que cambie con **cualquier** columna proyectada, incluidas fechas, personas previstas y restricciones | toda la obsolescencia de §2.4; es el paso 45 del recorrido |
| catálogo cerrado de `meal_plan` y `menu_style` | propuesta de servicios |

`food.menus.event_id` es FK a `booking.events(id)` con `on delete restrict`: Booking no podrá purgar un evento que tenga menú.

El feed de cambios de Food solo trae cambios de `food.*`. Los eventos se refrescan con `GET events` en cada ciclo de pull y al volver a primer plano.

### 7.2 Lo que Food publica

Para Invoices, como destinos de asignación `target_app = 'food'`:

```text
food.invoices_ingredient_projection   ingredient_id, name, preferred_unit, active, ingredient_revision
food.invoices_equipment_projection    equipment_id, name, category, status, equipment_revision
```

Solo filas no borradas. `target_kind` aceptados: `ingredient` y `equipment`. Sin datos personales.

No se publica nada para Booking en V1. Si Booking quiere derivar su «estado cocina» del menú, una `food.booking_menu_projection (event_id, menu_status, source_event_revision, shopping_status)` es trivial y se añade en G4.

### 7.3 Entradas de stock (V2)

No hay escrituras cruzadas: Invoices no inserta en `food.stock_entries`. Propuesta para G4: Invoices publica `invoices.food_purchase_projection` (líneas validadas asignadas a `food:ingredient`, con cantidad, unidad, fecha, importe, proveedor, evento opcional y revisión de la asignación) y Food la materializa con `POST stock-entries/sync`, idempotente por `(source_app, source_kind, source_id)`. Con eso `stock_quantity` de la lista de compra podrá proponerse en vez de teclearse.

### 7.4 Indicadores para Central

Vista `food.central_kpi_projection` (`20261007_0170_food_central_kpi.sql`), con el contrato de `docs/central/API.md` §7.2, registrada con `core.allow_read('central', 'food.central_kpi_projection', 'view')`. Solo agregados; `period = 'actual'` y «hoy» en hora de Madrid. Las fechas del evento de las claves de menús y listas son las de `food.menus.source_event_snapshot`: lo que la cocina tenía delante al crear, revisar o validar el menú.

| Clave | Etiqueta | Fórmula | Unidad · sentido | Enlace |
|---|---|---|---|---|
| `food.menus_unvalidated_30d` | Menús sin validar en los próximos 30 días | Menús vivos en `borrador` o `revisar` cuyo evento empieza entre hoy y hoy + 30. `period_end` = hoy + 30. | `count` · `down` | `#/menus` |
| `food.shopping_lists_open` | Listas de la compra abiertas | Listas vivas con estado distinto de `cerrada`, de un menú vivo y no cerrado, cuyo evento termina hoy o después. | `count` · `down` | `#/menus` |
| `food.events_without_menu_30d` | Eventos sin menú en los próximos 30 días | Eventos de `booking.food_event_projection` que piden menú (misma regla que `needsMenu`: reserva no cancelada ni perdida, `requires_meals` distinto de `false`, régimen distinto de `no_aplica`), empiezan entre hoy y hoy + 30 y no tienen menú vivo. `period_end` = hoy + 30. Desde `20261007_0190`. | `count` · `down` | `#/eventos` |

`food.events_without_menu_30d` es la única clave que lee `booking.food_event_projection`: el lint lo permite solo para esa proyección (petición P14, PR #265 de Core).

### 7.5 El menú en los portales (fase 4: Fd2/FD1 y Fd3)

Migración `20261008_0191_food_portal_menu.sql`. Decisiones del usuario (8-10-2026): el organizador ve el menú solo cuando cocina pulsa **«Compartir con el organizador»** (`menus.organizer_shared`), y puede comentar un menú validado, pero su comentario lo devuelve a «por revisar».

Ámbito: `core.portal_in_scope(portal, actor, reservation_id, guest_id?)` (K1); la reserva se liga con el evento por `booking.food_event_projection.reservation_id`. Fuera de ámbito, con otra reserva o con un id inválido, la misma respuesta: `OUT_OF_SCOPE 403`.

| Nombre | Portal | Tipo | Entrada → salida |
|---|---|---|---|
| `food.portal_menu` | `organizers`, `guests` | lectura | `{reservation_id, guest_id?}` (Guests con su `guest_id`) → `{reservation_id, available, status: provisional\|confirmado, menu_ids, updated_at, services: [{service_id, menu_id, date, type, time, dishes: [{menu_item_id, name, description, category, diet_tags, allergens, allergens_checked, photo_thumb_file_id}]}], restrictions}` |
| `food.portal_menu_comment` | `organizers` | acción | `{reservation_id, menu_item_id?, service_id?, kind: prefiero_que_no\|comentario, message?}` → `{id, status: 'nuevo', menu_status, cursor}`. `prefiero_que_no` exige plato; `comentario`, mensaje. Errores: `INVALID_OPERATION`, `INVALID_FIELDS`, `OUT_OF_SCOPE`, `MENU_CLOSED` |
| `food.portal_my_menu_comments` | `organizers` | lectura | `{reservation_id}` → `{items: [{id, menu_item_id, service_id, dish, kind, message, status, reply, created_at, mine}]}` |

- **Solo lo compartido**: sin menú compartido, `available: false` y `services: []`.
- **Guests** solo ve menús validados o cerrados, y `restrictions: null`. Qué módulos ve cada huésped lo decide Organizers (`guest_experience_for`); Food no lo duplica.
- `status` es `provisional` mientras algún menú siga en borrador o por revisar.
- **Nombre del plato**: `public_name` si lo hay; si no, `name`. Descripción: `public_description`.
- `restrictions` (solo el organizador): el resumen agregado que ya publica Booking, sin `kitchen_notes`.
- **Nunca** salen raciones, ingredientes, elaboración, conservación, notas del menú, del servicio o del plato, costes, compra, preparación, avisos ni quién validó.
- **Fotos** (C8, `20261008_0192_food_portal_photos.sql`): cada plato trae `photo_thumb_file_id` (la miniatura de 480 px, nunca la grande), y el portal la abre con `GET /api/v1/portal-files/:fileId`. El resolutor `food.portal_dish_photo`, registrado para los dos portales, solo dice que sí si el archivo es la miniatura de un plato de un menú compartido de una reserva del ámbito del miembro (en Guests, validado o cerrado).
- **Comentario sobre un menú validado**: el mismo lote del portal (`core.apply_portal_operations`) inserta el comentario y pasa el menú a `revisar`. Un menú cerrado no admite comentarios.
- **En Food**: la ficha del menú enseña «Comentarios del organizador» con «Visto», «Resuelto» y una respuesta que el organizador lee en `portal_my_menu_comments`.

---

## 8. Archivos

- Bucket `kitchen-media` (privado, ya creado). `uploads: { bucket: 'kitchen-media', maxBytes: 2 MB, allowedMime: ['image/webp', 'image/jpeg'] }`.
- Solo la foto principal de la receta: subir, ver, reemplazar y quitar. Sin galería.
- **Tratamiento en cliente** (contrato §11.3): la imagen elegida o tomada con la cámara se decodifica, se corrige la orientación y se generan dos archivos: 1600 px de lado mayor, WebP de calidad media (100–300 KB), y miniatura de 480 px (unos 25 KB). Si el navegador no codifica WebP se usa JPEG. **No se conserva el original.**
- La miniatura alimenta las tarjetas del recetario y el selector de platos; la de 1600 px, la ficha y la vista del organizador. Sin miniatura, una rejilla de treinta recetas descargaría varios megas en la wifi de la cocina.
- `recipes.photo_file_id` y `photo_thumb_file_id` son FK a `core.files(id)`. El comando lleva el marcador `{"$blob": "<sha256>"}` en cada campo y `sync-client` lo sustituye por el `file_id` cuando el blob está subido y verificado, también si la foto se hizo sin red (contrato §8). La receta nunca apunta a un archivo inexistente. Quitar es poner ambas a `null`.
- La Edge comprueba en `beforeCommit` que el archivo referenciado existe, es de la app `food`, está verificado y es una imagen.
- Lectura con `GET files/{id}` (URL firmada de 10 minutos). Para offline, §10.2.

- **Campos de archivo** (contrato §3.9, `20261007_0180_food_file_fields.sql`): `recipes.photo_file_id` y `recipes.photo_thumb_file_id` registrados con `core.register_file_field` como `operational`, y recogida de huérfanos activada con `core.enable_file_gc('food')`. Así se resuelve P6: al reemplazar o quitar una foto, el archivo anterior queda huérfano y Core lo borra pasados 30 días. Food no llama nunca a `/storage/v1/object…`: sube y lee con `sync-client` y `GET files/{id}`.

---

## 9. Pantallas y navegación

Cinco entradas: **Inicio · Eventos · Menús · Recetario · Maquinaria**. Lectura primero; `Editar` abre el formulario. Compra y preparación viven dentro del menú. Ingredientes no tienen pantalla: se gestionan desde el selector de la receta.

**Inicio.** Solo lo que pide acción. Una tarjeta por evento próximo con fecha, título, personas y régimen, y cuatro líneas: Menú (sin crear, borrador, por revisar, validado, ⚠ desactualizado), Restricciones (número), Compra (sin generar, borrador, revisada, cerrada, ⚠) y Preparación (sin generar, «6 de 14», ⚠). Sin gráficos. Cada línea lleva a su sitio.

**Eventos.** Lista de la proyección: fechas, título, personas (finales o previstas), régimen, restricciones resumidas y estado del menú. Filtros: próximos, pasados, sin menú. La ficha muestra los datos del evento en lectura y la acción «Crear menú» o «Abrir menú». Los eventos sin comidas o cancelados aparecen atenuados y sin acciones.

**Menús.** Lista de menús por evento con estado y avisos. La ficha del menú tiene cabecera fija con evento, personas, régimen y el bloque **⚠ Restricciones** siempre visible, el aviso de evento cambiado cuando toca, y cinco pestañas:

- *Menú*: constructor por días. Servicio → platos. Añadir, quitar y reordenar servicios; cambiar hora; añadir plato desde el recetario visual; cambiar raciones (por defecto las personas del evento). Al crear el menú se ofrece una propuesta de servicios según el régimen que el usuario acepta o edita antes de guardar. Conmutador «vista de cocinero»: cada plato con sus ingredientes escalados, maquinaria y elaboración.
- *Compra*: tabla Producto · Necesario · Unidad · En casa · Comprar · Proveedor · Estado. «Generar» o «Regenerar» con el resumen de lo que cambió; añadir una línea a mano; marcar comprado o recibido.
- *Preparación*: lista por día y hora con casilla, responsable y edición en línea; «Generar propuesta»; añadir un paso.
- *Organizador*: vista de presentación (abajo).
- *Cierre*: `closing_notes` con una guía de qué anotar.

**Recetario.** Rejilla de tarjetas con foto, nombre, categoría y dieta. Búsqueda y filtros por categoría, dieta, alérgeno y estado. Ficha en este orden: foto, nombre, descripción pública, categoría y etiquetas, raciones base, ingredientes, elaboración, seguridad (alérgenos y dietas, con «alérgenos revisados»), maquinaria, conservación y servicio. Edición por bloques: Presentación, Ingredientes, Cocina, Seguridad, Maquinaria.

**Maquinaria.** Lista con nombre, cantidad y estado. Ficha: tipo, cantidad, capacidad, ubicación, estado y notas. La ficha de receta avisa si requiere más unidades de las que hay o una máquina averiada; no hay optimizador.

**Vista del organizador e impresión.** Ruta propia que lee el espejo local. Contiene marca Ikisai, título del evento, fechas, días → servicios → platos con foto, nombre público, descripción pública, dietas y alérgenos. No contiene cantidades, ingredientes, proceso, maquinaria, stock, proveedores ni notas internas. Con el menú sin validar lleva la marca «BORRADOR». Botón «Imprimir / Guardar PDF» con CSS de impresión: `@page { size: A4; margin: 14mm }`, `break-inside: avoid` por servicio y por plato, colores con `print-color-adjust: exact` y espera a que todas las fotos estén decodificadas antes de `window.print()`. Sin generación de PDF en servidor.

**Móvil.** Barra inferior con las cinco entradas, `Guardar` fijo abajo mientras hay cambios, pestañas del menú desplazables, y tablas de compra y preparación como listas con la acción principal (comprado, hecho) al alcance del pulgar. Estado de sincronización, pendientes y conflictos con los componentes de `ui-kit`.

---

## 10. Offline

La cocina tiene mala wifi. Todo lo que se consulta o se marca con las manos ocupadas funciona sin red.

### 10.1 Espejo local

Las once tablas de V1 van al espejo de `sync-client`: `recipes, ingredients, recipe_ingredients, equipment, recipe_equipment, menus, menu_services, menu_items, shopping_lists, shopping_list_items, preparation_items`.

### 10.2 Cachés propias de la app

- **Eventos.** La proyección no es una tabla sincronizable. `apps/food` guarda la última respuesta de `GET events` en una base propia `ikisai-food-cache-v1` con su fecha; sin red la muestra con la leyenda «datos del evento a fecha de …».
- **Fotos.** Los archivos son inmutables por `file_id`. La app descarga el blob con la URL firmada y lo guarda en Cache Storage con una clave estable por `file_id`; el service worker lo sirve desde ahí. Se precargan todas las miniaturas y las fotos de 1600 px de las recetas de los menús de eventos próximos; el resto, al abrirlas. Tope configurable (200 MB) con descarte de las menos usadas.
- Cerrar sesión borra ambas cachés.

### 10.3 Qué se puede hacer sin red

| Sin red sí | Solo con red |
|---|---|
| consultar recetario, maquinaria, menús, compra, preparación, vista de cocinero y organizador, e imprimir | validar un menú, cambiar su estado, dar por revisado un cambio del evento |
| crear y editar recetas, ingredientes y maquinaria; hacer una foto (queda en cola) | generar o regenerar compra y preparación |
| crear un menú desde un evento en caché; editar servicios y platos de un borrador | refrescar eventos |
| corregir «En casa» y «Comprar», marcar comprado o recibido, añadir líneas manuales | vaciar papelera, miembros |
| marcar pasos de preparación, asignar responsable, añadir y editar pasos | |

Las acciones «solo con red» son los `call`. Dependen de la verdad del servidor (revisión del evento, cálculo autoritativo) y `sync-client` no puede anticipar su efecto en el espejo. La interfaz primero vacía la cola (`sync()`), comprueba que no quedan pendientes ni conflictos, envía el `call` con `api('/commands')` para recibir el resultado o el error en el momento, y vuelve a sincronizar. Sin red el botón está deshabilitado y dice por qué.

### 10.4 Pendientes, conflictos y rechazos

- Filas con cambios sin confirmar: marca «pendiente de sincronizar». «Guardado» solo con confirmación del servidor.
- Campos disjuntos se fusionan solos con aviso discreto. Ejemplo normal: la tableta marca una línea como comprada mientras la oficina regenera la lista, que cambia `required_quantity`.
- Campos solapados van al banner de conflictos campo a campo. Ejemplo: la tableta fija «Comprar» a mano y la regeneración recalcula esa misma cantidad.
- Rechazos de dominio (422): `sync-client` aparta el lote sin bloquear la cola y lo deja visible (`rejected()`, con reintento o descarte); el espejo vuelve a la base y la interfaz explica el motivo con el código: `MENU_LOCKED` («el menú se validó mientras editabas sin red»), `DUPLICATE_NAME` («ya existe Tomate: usar el existente»), `MENU_EXISTS`, `LIST_CLOSED`, `PARENT_DELETED`. Para que un rechazo no deje huérfanos en la cola, `domain-food` agrupa en un solo lote lo que solo tiene sentido junto: ingrediente nuevo con su línea de receta, servicio con sus platos propuestos, borrados en cascada.
- Foto: el comando que la referencia no se envía hasta que la subida está verificada. Si la subida falla, la receta conserva la foto anterior y la interfaz lo dice.

---

## 11. Aceptación

### 11.1 Recorrido F–H (handoff §32, numeración original)

Precondición, pasos D y E de Booking: existe el evento `Retiro Test`, viernes a domingo, llegada 17:00, salida 12:00, 22 personas finales, pensión completa, con 1 alergia a pistacho y 2 veganos. Hasta que Booking exista, la precondición se cumple con una proyección de prueba en PGlite y en la API falsa de Playwright.

**F. Receta**

25. Crear la receta «Curry de verduras», categoría principal.
26. Subir una foto: se generan la versión de 1600 px y la miniatura, no se guarda el original, la lectura es autenticada.
27. Añadir nombre y descripción públicos.
28. Fijar 20 raciones base.
29. Añadir ingredientes en g, kg y l; crear uno nuevo desde el selector.
30. Declarar alérgenos y dietas y marcar «alérgenos revisados».
31. Elegir maquinaria; aviso si se piden más unidades de las que hay.
32. Marcar validada (rechazado si los alérgenos no están revisados).

**G. Menú**

33. Desde Eventos, crear el menú de `Retiro Test`: cabecera con 22 personas, pensión completa y las restricciones, sin ningún dato de huésped.
34. Aceptar la propuesta de servicios y ajustarla: añadir, quitar, cambiar una hora.
35. Añadir platos desde el recetario visual, con 22 raciones por defecto, editables; incluir un «Pesto» con frutos de cáscara.
36. Validar: aparecen el aviso de alergia a pistacho contra el Pesto y el de cada servicio sin opción vegana; no valida sin aceptarlos; tras aceptarlos pasa a `validado` y los platos quedan bloqueados.
37. Generar la lista de compra.
38. Comprobar cantidades: raciones × cantidad ÷ raciones base, mismo ingrediente agrupado, 800 g + 1,5 kg sumados como 2,3 kg, `unidad` sin mezclar con masa.
39. Cambiar «Comprar» a mano en una línea y marcar otra como comprada.
40. Generar el plan de preparación, editar un paso (pasa a manual), añadir otro y marcar uno como hecho.
41. Abrir la vista del organizador: sin cantidades ni notas internas.
42. Imprimir o guardar PDF en A4 con las fotos, sin platos partidos entre páginas.

**H. Obsolescencia**

43. En Booking (o en la proyección de prueba), cambiar las personas finales.
44. 22 → 25.
45. Sube `event_revision`.
46. Food detecta que el menú se validó contra la revisión anterior.
47. Muestra el aviso con «Personas: 22 → 25» en el menú y en Inicio.
48. «Reabrir para cambiar», subir raciones a 25 y validar de nuevo: `source_event_revision` queda en la actual.
49. La compra y la preparación aparecen desactualizadas. Se regeneran a conciencia: las cantidades suben, la línea corregida a mano conserva su «Comprar», la comprada sigue comprada, el paso manual y el hecho se conservan.

### 11.2 Pruebas automáticas

- **Conformidad** (`packages/test-kit`): `food-api` pasa la suite del contrato §9 con `food.equipment` como tabla de muestra.
- **SQL en PGlite**: `check`, FK, triggers de §4.2, transiciones de estado, `regenerate_shopping` con las fixtures compartidas, conservación de datos manuales al regenerar, `regenerate_preparation`, `source_revisions`.
- **`domain-food`**: validación, `computeShopping`, `menuWarnings` (diccionario de alérgenos incluido), propuesta de servicios, comparación de `source_revisions`.
- **Playwright**, en 390 px y 1440 px:
  1. Recetario sin red tras una primera carga: tarjetas con miniatura desde la caché, ficha completa.
  2. Corte de red editando una receta, recarga con la cola pendiente, reconexión y vaciado.
  3. Foto tomada sin red: en cola, se sube al reconectar, la receta no cambia de foto hasta que está verificada.
  4. Preparación: marcar pasos sin red en un dispositivo, editar otro paso en otro, fusión automática al reconectar.
  5. Compra: «Comprar» fijado sin red mientras otro regenera; conflicto solapado con decisión humana.
  6. Platos editados sin red en un menú que otro valida: rechazo `MENU_LOCKED` explicado, espejo restaurado, cola no bloqueada.
  7. Botones de validar y regenerar deshabilitados sin red, con motivo.
  8. Vista del organizador sin red e impresión: `page.pdf()` en A4 con fotos presentes y sin platos partidos.
  9. Recorrido H completo contra la API falsa.

---

## 12. Reparto entre agentes

Primero la base, en serie y corta; después tres verticales en paralelo.

| Fase | Backend (SQL + Edge + dominio) | Frontend (Vite + UI) |
|---|---|---|
| Base | migración `food_catalog`; `food-api` sobre `_kit` con conformidad en verde; esqueleto de `domain-food` (tipos, unidades, validación) | esqueleto `apps/food` copiando el patrón de `apps/invoices` (login, shell de cinco entradas, cliente, SW), cachés de eventos y fotos |
| Vertical 1 · Recetario y maquinaria | reglas de receta, triggers de catálogo, validación de archivos, proyecciones para Invoices | rejilla, ficha, edición por bloques, selector de ingredientes, foto con recompresión, maquinaria |
| Vertical 2 · Menú | migración `food_menus`, `GET events`, procedimientos de estado, `menuWarnings`, triggers de bloqueo | Eventos, constructor, selector visual, cabecera de restricciones, avisos, flujo de validación y de evento cambiado, Inicio |
| Vertical 3 · Compra, preparación y organizador | migración `food_planning`, regeneraciones, fixtures de paridad, `source_revisions` | pestañas Compra y Preparación, vista de cocinero, vista del organizador con impresión, Cierre |

Archivos:

- Backend: `supabase/migrations/*_food_*.sql`, `supabase/functions/food-api/`, `supabase/functions/_domain/food/`, `tests/food/` (SQL y API).
- Frontend: `apps/food/`, `tests/food/*.spec.ts`. Consume `packages/domain-food` y propone cambios por PR al backend.
- El código de dominio vive en `supabase/functions/_domain/food/` (se empaqueta con la función) y `packages/domain-food` solo lo reexporta para Vite. Es la frontera: el backend es su dueño y el frontend lo importa. Sus tipos y funciones públicas (`computeShopping`, `menuWarnings`, `proposeServices`, constructores de lotes) se acuerdan al cerrar la base.

Dependencias externas:

- El vertical 1 no depende de Booking y puede publicarse solo.
- `food_menus` necesita que `booking.events` exista en una migración anterior de la secuencia (P7). Hasta entonces el vertical 2 avanza en el dominio y en la interfaz contra la vista de pruebas.

---

## 13. Diferencias respecto al handoff

| Handoff V3 | Aquí | Motivo |
|---|---|---|
| `food.members` | `core.memberships(app = 'food')` | contrato §3 |
| V1 sin edición offline | offline completo salvo los `call` | plan v2 y contrato |
| Rutas REST por recurso (§25) | `snapshot`, `changes`, `commands` y dos rutas propias | contrato §5 |
| `photo_original_path`, `photo_display_path`; conservar el original | `photo_file_id`, `photo_thumb_file_id`; sin original | contrato §11.3 y `core.files` |
| `recipe_ingredients` con PK compuesta | `id` propio | contrato §2.1 |
| `position integer` | `position numeric` | contrato §2.1 |
| `source_menu_revision` en lista y preparación | `source_revisions` (conjunto de revisiones) | §2.4: la revisión del menú no refleja sus platos |
| `shopping_lists.validated_at` | se lee en `core.changes` | evitar una fecha de reloj de cliente |
| `preparation_items.scheduled_at timestamptz` | `scheduled_date` + `scheduled_time` | hora de pared de la cocina, como `menu_services`; sin conversiones de zona sin red |
| `GET dashboard` | cálculo local | tiene que verse sin red |

Añadidos, con su justificación en el texto: `public_name`, `prep_minutes`, `allergens_checked`, `photo_thumb_file_id`, `source_event_snapshot`, `validated_by`, `validated_warnings`, `closing_notes`, `shopping_list_items.manual`, `preparation_items.menu_item_id` y `manual`.

---

## 14. Peticiones y decisiones para Core

Tal como se entregaron. La resolución está en §14.1; las peticiones nuevas van a `docs/food/PETICIONES.md`.

| # | A quién | Petición | Sin ella |
|---|---|---|---|
| P1 | Core | Una forma de leer desde la Edge de app `booking.food_event_projection` y, por `id`, las tablas propias. Hoy `_kit` solo ofrece `rpc` sobre wrappers `public.core_*` y el lint impide a las apps definir wrappers `public.*`. Opciones: un `public.core_read_projection(app, proyección, filtro)` con lista blanca, o exponer los schemas de app a PostgREST solo para `service_role` con un helper `select` en `_kit`. | No hay `GET events` ni validación contra la revisión del evento. Para las tablas propias hay apaño con `core_snapshot_table`, que trae la tabla entera. |
| P2 | Core | Que `_kit/supabase.ts` traduzca los SQLSTATE de clase 23 (y 22) a **422** `CONSTRAINT_VIOLATION` con el nombre de la restricción. Hoy acaban en 503 `BACKEND_UNAVAILABLE`, que `sync-client` trata como transitorio: reintenta sin fin y la cola se queda bloqueada detrás de ese lote. Confirmar además la convención «error de dominio = 422», porque un 404 o un 409 que no sea de versión tampoco se retira de la cola. | Food valida todo antes en `beforeCommit` y con triggers, pero una FK hacia una fila que otro lote no llegó a crear bloquearía la cola de ese dispositivo. |
| P3 | Core | En `sync-client`, sustituir en `fields` una referencia a un blob en cola por su `file_id` cuando la subida se verifica (por ejemplo `{"$blob": "<sha256>"}`). Hoy el cliente guarda `fileId` en el registro del blob pero no lo lleva al comando. | La foto solo puede subirse con red, justo el caso que el offline de cocina quería cubrir. |
| P4 | Core | Permitir en el lint `references core.files(id)` desde migraciones de app, o confirmar que la referencia es un `uuid` sin FK validado en la Edge con `core_file_get`. | `photo_file_id` queda como `uuid` sin FK. |
| P5 | Core + Booking | Columnas y semántica de `booking.food_event_projection` de §7.1, en especial que `event_revision` cambie con cualquier dato proyectado. | El paso 45 del recorrido falla cuando el cambio está en la reserva o en una restricción y no en la fila del evento. |
| P6 | Core | Política para archivos que dejan de estar referenciados (foto reemplazada o quitada). No hay ruta de borrado y borrar al instante rompería el deshacer. Propuesta: limpieza periódica de Core de archivos sin referencia viva ni en el historial reciente. | Se acumulan en `kitchen-media` (unos 300 KB por reemplazo). |
| P7 | Core + Booking | Orden de migraciones: `booking.events` antes que `food_menus`. Si Booking va más lento, una migración temprana de Booking con `reservations` y `events` ya aprobados. | El vertical de menú no puede fusionar su migración ni pasar PGlite. |
| P8 | Core | Menor: si Booking o Invoices necesitan también una caché de lecturas no sincronizadas, convertir la de §10.2 en una función de `sync-client`. | Food la implementa en `apps/food`. |

Decisiones que se piden a Core al revisar:

1. `source_revisions` como mecanismo de obsolescencia entre menú, compra y preparación (§2.4), en lugar de `source_menu_revision`.
2. Triggers con `core.fail(…, 422)` para las invariantes de fila, sin `validate_hooks` (§4.2).
3. Columnas reservadas dentro de `writable_columns` protegidas por `beforeCommit` (§2). La alternativa sería que `core.register_table` distinguiera columnas escribibles solo desde procedimientos.
4. Los `call` como acciones solo con red, enviadas con `api('/commands')` tras vaciar la cola (§10.3).
5. `food.stock_entries` definida ahora y migrada en G4 (§2.3), y el modelo de proyección de Invoices más materialización en Food (§7.3).
6. Nombres de las proyecciones `food.invoices_ingredient_projection` y `food.invoices_equipment_projection` (§7.2).

### 14.1 Resolución de Core (6 de octubre de 2026)

Las seis decisiones quedan **aprobadas** como se proponían. Peticiones:

| # | Resolución |
|---|---|
| P1 | Lecturas registradas (contrato §5.1): `GET /api/v1/read/booking.food_event_projection?where[event_id]=…`; las funciones de lectura propias se registran con `core.allow_read('food', 'food.<fn>', 'function')`. |
| P2 | Los errores SQL llegan como 422 definitivos con `details.sqlstate` (contrato §5.2) y `sync-client` 0.2 deja visibles los lotes rechazados sin bloquear la cola. |
| P3 | Marcador `{"$blob": "<sha256>"}` en `sync-client` 0.2. |
| P4 | El lint permite FK y lecturas a `core.files`, `core.memberships`, `core.changes` y `core.synced_tables`. |
| P5 | `event_revision` es un contador propio de Booking que avanza con fechas, personas, régimen y restricciones (contrato §8). Las columnas adicionales de §7.1 se cierran con Booking. |
| P6, P7, P8 | Sin respuesta explícita; no bloquean el arranque. Siguen abiertas en `docs/food/PETICIONES.md`. |

