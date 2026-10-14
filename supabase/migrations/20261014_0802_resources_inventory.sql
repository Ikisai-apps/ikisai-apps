-- Ikisai Recursos · fase R3: inventario base (artículos, unidades, lotes, movimientos, recuentos y costes a mano).
-- Diseño aprobado por el usuario el 13-10-2026: coordinacion/ampliacion/RECURSOS.md §5 y §11.2; docs/resources/API.md §3.
-- Toca solo el schema resources.
--
-- El stock es la suma de movimientos por artículo, sitio y lote: no hay campo «stock». Los movimientos solo se añaden;
-- se corrige con uno contrario. El recuento se cierra con `resources.close_count`, que crea los `ajuste_recuento`.
-- Escriben editor y owner; los tipos de artículo, solo el owner. Huéspedes, organizadores y outsiders no ven nada.

-- ---------------------------------------------------------------------------
-- Tipos de artículo (ampliables; los gestiona el owner)
-- ---------------------------------------------------------------------------
create table resources.item_kinds (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,30}$'),
  label text not null check (length(btrim(label)) between 1 and 40),
  -- true = se gasta (entra y sale, mínimo y lista de compra); false = se cuenta (solo baja por rotura, pérdida o baja).
  consumable boolean not null default true,
  position numeric not null default 0,
  active boolean not null default true
);
create unique index item_kinds_kind_idx on resources.item_kinds (kind) where deleted_at is null;
select core.register_table('resources', 'resources', 'item_kinds', array['kind', 'label', 'consumable', 'position', 'active'],
  '{reader,editor,owner}', '{owner}');

insert into resources.item_kinds (kind, label, consumable, position) values
  ('ingrediente', 'Ingrediente', true, 10),
  ('bebida', 'Bebida', true, 20),
  ('material', 'Material', true, 30),
  ('limpieza', 'Limpieza', true, 40),
  ('higiene', 'Higiene', true, 50),
  ('consumible', 'Consumible', true, 60),
  ('menaje', 'Menaje', false, 70),
  ('textil', 'Textil', false, 80),
  ('herramienta', 'Herramienta', false, 90),
  ('maquina', 'Máquina', false, 100),
  ('otro', 'Otro', true, 110);

-- ---------------------------------------------------------------------------
-- Artículos, unidades y lotes
-- ---------------------------------------------------------------------------
create table resources.items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  name text not null check (length(btrim(name)) between 1 and 120),
  kind text not null check (kind ~ '^[a-z][a-z0-9_]{1,30}$'),
  category text check (category is null or length(btrim(category)) between 1 and 60),
  base_unit text not null check (length(btrim(base_unit)) between 1 and 20),
  min_quantity numeric check (min_quantity is null or min_quantity >= 0),
  reorder_quantity numeric check (reorder_quantity is null or reorder_quantity > 0),
  default_space_id uuid,
  -- Proveedor habitual: vive en Finance (`invoices.suppliers`); sin clave foránea entre schemas.
  default_supplier_id uuid,
  tracks_lots boolean not null default false,
  tracks_expiry boolean not null default false,
  -- Herramientas y máquinas: marca, modelo, número de serie, factura de compra…
  attributes jsonb not null default '{}'::jsonb check (jsonb_typeof(attributes) = 'object'),
  active boolean not null default true,
  notes text check (notes is null or length(notes) <= 2000),
  -- De dónde viene (migraciones de R4–R6): `tasks.supply_item:<uuid>`, `food.ingredient:<uuid>`, `invoices.item_label:<uuid>`…
  source_refs text[] not null default '{}'
);
create unique index items_name_idx on resources.items (lower(btrim(name))) where deleted_at is null;
create index items_kind_idx on resources.items (kind) where deleted_at is null;
create index items_source_refs_idx on resources.items using gin (source_refs);
select core.register_table('resources', 'resources', 'items',
  array['name', 'kind', 'category', 'base_unit', 'min_quantity', 'reorder_quantity', 'default_space_id', 'default_supplier_id',
        'tracks_lots', 'tracks_expiry', 'attributes', 'active', 'notes', 'source_refs']);

-- Conversiones hacia la unidad base: 1 saco = 25 000 g (opcionalmente, solo de un proveedor).
create table resources.item_units (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  item_id uuid not null references resources.items(id),
  unit text not null check (length(btrim(unit)) between 1 and 20),
  factor numeric not null check (factor > 0),
  supplier_id uuid
);
create unique index item_units_unique_idx on resources.item_units (item_id, lower(btrim(unit)), coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid)) where deleted_at is null;
select core.register_table('resources', 'resources', 'item_units', array['item_id', 'unit', 'factor', 'supplier_id']);

create table resources.lots (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  item_id uuid not null references resources.items(id),
  code text check (code is null or length(btrim(code)) between 1 and 60),
  expires_on date
);
create index lots_item_idx on resources.lots (item_id) where deleted_at is null;
select core.register_table('resources', 'resources', 'lots', array['item_id', 'code', 'expires_on']);

-- ---------------------------------------------------------------------------
-- Recuentos (antes que los movimientos, que apuntan a ellos)
-- ---------------------------------------------------------------------------
create table resources.counts (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  -- null = todo; un sitio = ese sitio y lo que cuelga de él.
  space_id uuid,
  status text not null default 'abierto' check (status in ('abierto', 'cerrado')),
  note text check (note is null or length(note) <= 1000),
  closed_at timestamptz,
  closed_by uuid references auth.users(id)
);
select core.register_table('resources', 'resources', 'counts', array['space_id', 'note']);

create table resources.count_lines (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  count_id uuid not null references resources.counts(id),
  item_id uuid not null references resources.items(id),
  space_id uuid not null,
  lot_id uuid references resources.lots(id),
  quantity numeric not null check (quantity >= 0),
  note text check (note is null or length(note) <= 500)
);
create index count_lines_count_idx on resources.count_lines (count_id) where deleted_at is null;
create unique index count_lines_unique_idx on resources.count_lines (count_id, item_id, space_id, coalesce(lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) where deleted_at is null;
select core.register_table('resources', 'resources', 'count_lines', array['count_id', 'item_id', 'space_id', 'lot_id', 'quantity', 'note']);

-- ---------------------------------------------------------------------------
-- Movimientos (registro que nunca se borra)
-- ---------------------------------------------------------------------------
create table resources.movements (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  item_id uuid not null references resources.items(id),
  space_id uuid not null,
  lot_id uuid references resources.lots(id),
  -- En la unidad base, con signo: entradas en positivo, salidas en negativo.
  quantity numeric not null check (quantity <> 0),
  kind text not null check (kind in ('entrada_factura', 'entrada_manual', 'consumo_servicio', 'consumo_tarea', 'salida_manual', 'traslado', 'ajuste_recuento')),
  reason text check (reason is null or reason in ('uso', 'merma', 'rotura', 'caducado', 'regalo', 'otro')),
  unit_cost numeric check (unit_cost is null or unit_cost >= 0),
  -- Las dos filas de un traslado comparten `transfer_id` y suman cero.
  transfer_id uuid,
  count_id uuid references resources.counts(id),
  source_app text check (source_app is null or source_app ~ '^[a-z][a-z0-9_]{0,39}$'),
  source_ref text check (source_ref is null or length(source_ref) <= 200),
  note text check (note is null or length(note) <= 500),
  at timestamptz not null default now()
);
create index movements_item_idx on resources.movements (item_id, space_id) where deleted_at is null;
create index movements_source_idx on resources.movements (source_app, source_ref) where source_ref is not null;
select core.register_table('resources', 'resources', 'movements',
  array['item_id', 'space_id', 'lot_id', 'quantity', 'kind', 'reason', 'unit_cost', 'transfer_id', 'count_id', 'source_app', 'source_ref', 'note', 'at'],
  '{reader,editor,owner}', '{editor,owner}', true);

-- ---------------------------------------------------------------------------
-- Costes a mano (transporte, alquiler de andamio…) de una tarea, proyecto o servicio
-- ---------------------------------------------------------------------------
create table resources.cost_entries (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  target_app text not null check (target_app ~ '^[a-z][a-z0-9_]{0,39}$'),
  target_ref text not null check (length(target_ref) between 1 and 200),
  amount numeric not null,
  description text not null check (length(btrim(description)) between 1 and 200),
  at timestamptz not null default now()
);
create index cost_entries_target_idx on resources.cost_entries (target_app, target_ref) where deleted_at is null;
select core.register_table('resources', 'resources', 'cost_entries', array['target_app', 'target_ref', 'amount', 'description', 'at']);

-- ---------------------------------------------------------------------------
-- Lecturas: stock y coste medio (se calculan, no se guardan)
-- ---------------------------------------------------------------------------
create or replace view resources.stock_levels as
select m.item_id, m.space_id, m.lot_id, sum(m.quantity) as quantity, max(m.at) as last_at
  from resources.movements m
 where m.deleted_at is null
 group by m.item_id, m.space_id, m.lot_id
having sum(m.quantity) <> 0;

-- Coste medio ponderado con las entradas que tienen coste; las entradas sin coste no lo alteran.
create or replace view resources.item_costs as
select m.item_id,
       round(sum(m.quantity * m.unit_cost) / nullif(sum(m.quantity), 0), 6) as average_cost,
       sum(m.quantity) as costed_quantity
  from resources.movements m
 where m.deleted_at is null and m.unit_cost is not null and m.quantity > 0 and m.kind in ('entrada_factura', 'entrada_manual')
 group by m.item_id;

select core.allow_read('resources', 'resources.stock_levels', 'view', '{reader,editor,owner}');
select core.allow_read('resources', 'resources.item_costs', 'view', '{reader,editor,owner}');

-- ---------------------------------------------------------------------------
-- Cerrar un recuento: ajuste por cada línea frente a lo calculado, en el mismo lote
-- ---------------------------------------------------------------------------
create or replace function resources.close_count(p jsonb)
returns jsonb language plpgsql as $$
declare
  v_app text := p->>'app'; v_actor uuid := (p->>'actor')::uuid; v_role text := p->>'role';
  v_request text := p->>'requestId'; v_cursor bigint := (p->>'cursor')::bigint;
  v_count resources.counts; v_line record; v_diff numeric; v_adjust int := 0;
begin
  begin v_count.id := (p->'args'->>'count_id')::uuid; exception when others then v_count.id := null; end;
  select * into v_count from resources.counts where id = v_count.id and deleted_at is null for update;
  if v_count.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'resources.counts')); end if;
  if v_count.status <> 'abierto' then perform core.fail('COUNT_CLOSED', 409, jsonb_build_object('countId', v_count.id)); end if;
  perform set_config('resources.closing_count', v_count.id::text, true);
  for v_line in
    select l.item_id, l.space_id, l.lot_id, l.quantity,
           coalesce((select sum(m.quantity) from resources.movements m
                      where m.item_id = l.item_id and m.space_id = l.space_id and m.lot_id is not distinct from l.lot_id and m.deleted_at is null), 0) as computed
      from resources.count_lines l where l.count_id = v_count.id and l.deleted_at is null
  loop
    v_diff := v_line.quantity - v_line.computed;
    continue when v_diff = 0;
    perform core.apply_row_op(v_app, v_actor, v_role, v_request, v_cursor, jsonb_build_object('op', 'insert', 'table', 'resources.movements',
      'id', gen_random_uuid(), 'fields', jsonb_build_object('item_id', v_line.item_id, 'space_id', v_line.space_id, 'lot_id', v_line.lot_id,
        'quantity', v_diff, 'kind', 'ajuste_recuento', 'count_id', v_count.id)));
    v_adjust := v_adjust + 1;
  end loop;
  update resources.counts set status = 'cerrado', closed_at = now(), closed_by = v_actor where id = v_count.id;
  insert into core.changes (app, cursor, seq, actor_id, request_id, schema_name, table_name, row_id, op, revision, before, after)
  select v_app, v_cursor, core.next_seq(v_app, v_cursor), v_actor, v_request, 'resources', 'counts', c.id, 'update', c.revision,
         to_jsonb(v_count), to_jsonb(c)
    from resources.counts c where c.id = v_count.id;
  return jsonb_build_object('countId', v_count.id, 'adjustments', v_adjust);
end $$;
select core.allow_procedure('resources', 'resources.close_count');

-- ---------------------------------------------------------------------------
-- Reglas (al final de cada lote)
-- ---------------------------------------------------------------------------
create or replace function resources.check_inventory(p jsonb)
returns void language plpgsql as $$
declare
  v_cursor bigint := (p->>'cursor')::bigint;
  v_change record;
  v_item resources.items;
  v_row record;
  v_closing text := current_setting('resources.closing_count', true);
begin
  if not exists (select 1 from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources'
                  and c.table_name in ('item_kinds', 'items', 'item_units', 'lots', 'movements', 'counts', 'count_lines', 'spaces')) then
    return;
  end if;

  for v_change in select c.table_name, c.op, c.row_id, c.before, c.after from core.changes c
                   where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' order by c.seq loop
    -- Movimientos: solo se añaden.
    if v_change.table_name = 'movements' then
      if v_change.op <> 'insert' then
        perform core.fail('MOVEMENT_IMMUTABLE', 422, jsonb_build_object('id', v_change.row_id, 'reason', 'movements are only added; correct with an opposite one'));
      end if;
      if (v_change.after->>'kind') = 'ajuste_recuento' and coalesce(v_closing, '') is distinct from (v_change.after->>'count_id') then
        perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_change.row_id, 'reason', 'count adjustments come from close_count'));
      end if;
    -- Recuentos: se cierran solo con close_count; un cerrado no cambia.
    elsif v_change.table_name = 'counts' and v_change.op <> 'insert' and coalesce(v_closing, '') is distinct from v_change.row_id::text then
      if (v_change.before->>'status') = 'cerrado' then perform core.fail('COUNT_CLOSED', 409, jsonb_build_object('countId', v_change.row_id)); end if;
    elsif v_change.table_name = 'count_lines' then
      if (select status from resources.counts where id = coalesce((v_change.after->>'count_id')::uuid, (v_change.before->>'count_id')::uuid)) is distinct from 'abierto' then
        perform core.fail('COUNT_CLOSED', 409, jsonb_build_object('countId', coalesce(v_change.after->>'count_id', v_change.before->>'count_id')));
      end if;
    -- Un artículo con movimientos no se borra: se archiva.
    elsif v_change.table_name = 'items' and v_change.op = 'delete'
          and exists (select 1 from resources.movements m where m.item_id = v_change.row_id and m.deleted_at is null) then
      perform core.fail('ITEM_IN_USE', 409, jsonb_build_object('itemId', v_change.row_id));
    -- Un tipo de artículo en uso no se borra ni se archiva.
    elsif v_change.table_name = 'item_kinds' and (v_change.op = 'delete' or (v_change.after->>'active') = 'false')
          and exists (select 1 from resources.items i where i.kind = coalesce(v_change.before->>'kind', v_change.after->>'kind') and i.deleted_at is null) then
      perform core.fail('ITEM_KIND_IN_USE', 409, jsonb_build_object('kind', coalesce(v_change.before->>'kind', v_change.after->>'kind')));
    -- Un espacio con stock no se borra ni se archiva (RECURSOS.md §2.4): primero se traslada.
    elsif v_change.table_name = 'spaces' and (v_change.op = 'delete' or ((v_change.before->>'active') = 'true' and (v_change.after->>'active') = 'false'))
          and exists (select 1 from resources.stock_levels s where s.space_id = v_change.row_id) then
      perform core.fail('SPACE_HAS_STOCK', 409, jsonb_build_object('spaceId', v_change.row_id));
    end if;
  end loop;

  -- Artículos tocados: tipo existente y sitio habitual vivo.
  for v_item in select i.* from resources.items i
                 where i.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'items')
                   and i.deleted_at is null loop
    if not exists (select 1 from resources.item_kinds k where k.kind = v_item.kind and k.deleted_at is null and k.active) then
      perform core.fail('INVALID_ITEM_KIND', 422, jsonb_build_object('kind', v_item.kind));
    end if;
    if v_item.default_space_id is not null and not exists (select 1 from resources.spaces s where s.id = v_item.default_space_id and s.deleted_at is null) then
      perform core.fail('INVALID_SPACE', 422, jsonb_build_object('spaceId', v_item.default_space_id));
    end if;
  end loop;

  -- Unidades: distintas de la base.
  for v_row in select u.*, i.base_unit from resources.item_units u join resources.items i on i.id = u.item_id
                where u.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'item_units')
                  and u.deleted_at is null loop
    if lower(btrim(v_row.unit)) = lower(btrim(v_row.base_unit)) then
      perform core.fail('INVALID_UNIT', 422, jsonb_build_object('unit', v_row.unit, 'reason', 'same as base unit'));
    end if;
  end loop;

  -- Movimientos y líneas de recuento nuevos: artículo vivo, sitio vivo, lote del artículo, signo según el tipo.
  for v_row in select m.*, i.tracks_lots, i.deleted_at as item_deleted from resources.movements m join resources.items i on i.id = m.item_id
                where m.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'movements') loop
    if v_row.item_deleted is not null then perform core.fail('INVALID_ITEM', 422, jsonb_build_object('itemId', v_row.item_id)); end if;
    if not exists (select 1 from resources.spaces s where s.id = v_row.space_id and s.deleted_at is null) then
      perform core.fail('INVALID_SPACE', 422, jsonb_build_object('spaceId', v_row.space_id));
    end if;
    if v_row.lot_id is not null and not exists (select 1 from resources.lots l where l.id = v_row.lot_id and l.item_id = v_row.item_id and l.deleted_at is null) then
      perform core.fail('INVALID_LOT', 422, jsonb_build_object('lotId', v_row.lot_id));
    end if;
    if v_row.kind in ('entrada_factura', 'entrada_manual') and v_row.quantity < 0
       or v_row.kind in ('consumo_servicio', 'consumo_tarea', 'salida_manual') and v_row.quantity > 0 then
      perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_row.id, 'reason', 'sign does not match kind', 'kind', v_row.kind));
    end if;
    if v_row.kind = 'salida_manual' and v_row.reason is null then
      perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_row.id, 'reason', 'manual exits need a reason'));
    end if;
    if v_row.kind = 'traslado' and v_row.transfer_id is null then
      perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_row.id, 'reason', 'transfers need transfer_id'));
    end if;
    if v_row.unit_cost is not null and v_row.kind not in ('entrada_factura', 'entrada_manual') then
      perform core.fail('INVALID_MOVEMENT', 422, jsonb_build_object('id', v_row.id, 'reason', 'only entries carry a cost'));
    end if;
  end loop;
  -- Cada traslado del lote: mismo artículo y lote, suma cero, de un sitio a otro.
  for v_row in select m.transfer_id, count(*) as n, sum(m.quantity) as total, count(distinct m.item_id) as items,
                      count(distinct coalesce(m.lot_id, '00000000-0000-0000-0000-000000000000'::uuid)) as lots,
                      count(distinct m.space_id) as spaces, bool_and(m.kind = 'traslado') as all_transfers
                 from resources.movements m
                where m.transfer_id in (select (c.after->>'transfer_id')::uuid from core.changes c where c.app = 'resources' and c.cursor = v_cursor
                                         and c.schema_name = 'resources' and c.table_name = 'movements' and c.after->>'transfer_id' is not null)
                group by m.transfer_id loop
    if v_row.n <> 2 or v_row.total <> 0 or v_row.items <> 1 or v_row.lots <> 1 or v_row.spaces <> 2 or not v_row.all_transfers then
      perform core.fail('INVALID_TRANSFER', 422, jsonb_build_object('transferId', v_row.transfer_id));
    end if;
  end loop;

  for v_row in select l.* from resources.count_lines l
                where l.id in (select c.row_id from core.changes c where c.app = 'resources' and c.cursor = v_cursor and c.schema_name = 'resources' and c.table_name = 'count_lines')
                  and l.deleted_at is null loop
    if not exists (select 1 from resources.spaces s where s.id = v_row.space_id and s.deleted_at is null) then
      perform core.fail('INVALID_SPACE', 422, jsonb_build_object('spaceId', v_row.space_id));
    end if;
    if v_row.lot_id is not null and not exists (select 1 from resources.lots l where l.id = v_row.lot_id and l.item_id = v_row.item_id) then
      perform core.fail('INVALID_LOT', 422, jsonb_build_object('lotId', v_row.lot_id));
    end if;
  end loop;
end $$;
select core.add_validate_hook('resources', 'resources.check_inventory');
