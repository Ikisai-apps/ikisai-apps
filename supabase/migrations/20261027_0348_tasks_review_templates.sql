-- Ikisai Tasks · «Revisión de apertura», 1: plantillas de revisión (encargo de VG por Core, 27-10-2026; diseño en
-- MUELA/equipo/feedback/tasks/REVISION_APERTURA.md; docs/tasks/API.md §46). Toca solo el schema tasks y, del núcleo,
-- solo usa register_table, add_validate_hook, current_role y fail.
-- - tasks.review_templates: una plantilla (`name`, `note`, `active`). `tab_id` nulo = plantilla de la casa, para todas
--   las áreas; con área, solo de esa área.
-- - tasks.review_template_items: los ítems de una plantilla, cada uno con su zona, su oficio (Central, opcional), su tipo
--   de respuesta (`answer`: check = funciona o no, quantity = cantidad, photo = foto, reading = lectura, note =
--   observación), lo esperado (`expected`: {count} en una cantidad; {unit, min?, max?} en una lectura), sus instrucciones
--   y si es crítico (`critical`: sin él verificado, la revisión no está «lista para abrir»). `tab_id` copia el de su
--   plantilla.
-- - Quién: las de la casa, solo una owner; las de un área, owner o editor con el área entera (el ámbito lo comprueba
--   tasks.validate_batch, como el resto de tablas con área). Lo demás, el hook tasks.validate_review_templates (con el rol
--   con el que empezó el lote: core.current_role()).
-- - Siembra la plantilla de la casa «Revisión de apertura», con ítems genéricos por zona (sintéticos), críticos los de
--   agua caliente, electricidad, cámaras, accesos, barandillas, extintores y agua.

create table tasks.review_templates (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid references tasks.tabs(id),
  name text not null check (length(btrim(name)) between 1 and 120),
  note text not null default '' check (length(note) <= 2000),
  active boolean not null default true,
  position numeric not null default 0
);
create index review_templates_tab_idx on tasks.review_templates (tab_id) where deleted_at is null;
create trigger tasks_guard_immutable before update on tasks.review_templates for each row execute function tasks.guard_immutable('tab_id');

create table tasks.review_template_items (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  tab_id uuid references tasks.tabs(id),
  template_id uuid not null references tasks.review_templates(id),
  zone text not null check (zone in ('habitaciones', 'camas', 'aseos', 'duchas_acs', 'puertas', 'electricidad', 'cocina', 'maquinaria',
    'accesos', 'barandillas', 'comunes', 'limpieza', 'extintores', 'agua')),
  trade_id uuid,
  title text not null check (length(btrim(title)) between 1 and 200),
  instructions text not null default '' check (length(instructions) <= 2000),
  answer text not null check (answer in ('check', 'quantity', 'photo', 'reading', 'note')),
  expected jsonb not null default '{}'::jsonb check (jsonb_typeof(expected) = 'object'),
  critical boolean not null default false,
  position numeric not null default 0
);
create index review_template_items_template_idx on tasks.review_template_items (template_id, position) where deleted_at is null;
create trigger tasks_guard_immutable before update on tasks.review_template_items for each row execute function tasks.guard_immutable('tab_id', 'template_id');

select core.register_table('tasks', 'tasks', 'review_templates', array['tab_id','name','note','active','position']);
select core.register_table('tasks', 'tasks', 'review_template_items', array['tab_id','template_id','zone','trade_id','title','instructions','answer','expected','critical','position']);

-- Lo esperado según el tipo: {count} (entero ≥ 0) en una cantidad; {unit, min?, max?} en una lectura (min ≤ max); nada en el resto.
create or replace function tasks.review_expected_ok(p_answer text, p_expected jsonb)
returns boolean language sql immutable as $$
  select case p_answer
    when 'quantity' then (select bool_and(k = 'count') from jsonb_object_keys(p_expected) k) is not false
      and (not p_expected ? 'count' or (jsonb_typeof(p_expected->'count') = 'number' and (p_expected->>'count')::numeric >= 0 and (p_expected->>'count')::numeric = trunc((p_expected->>'count')::numeric)))
    when 'reading' then (select bool_and(k in ('unit', 'min', 'max')) from jsonb_object_keys(p_expected) k) is not false
      and jsonb_typeof(p_expected->'unit') = 'string' and length(btrim(p_expected->>'unit')) between 1 and 20
      and (not p_expected ? 'min' or jsonb_typeof(p_expected->'min') = 'number')
      and (not p_expected ? 'max' or jsonb_typeof(p_expected->'max') = 'number')
      and (not (p_expected ? 'min' and p_expected ? 'max') or (p_expected->>'min')::numeric <= (p_expected->>'max')::numeric)
    else p_expected = '{}'::jsonb end
$$;

create or replace function tasks.validate_review_templates(p jsonb)
returns void language plpgsql as $$
declare
  v_app text := p->>'app';
  v_cursor bigint := (p->>'cursor')::bigint;
  v_role text := core.current_role();
  c record;
  t tasks.review_templates;
  i tasks.review_template_items;
begin
  for c in select ch.table_name, ch.row_id, ch.op, ch.before, ch.after from core.changes ch
            where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'tasks' and ch.table_name in ('review_templates', 'review_template_items')
              and ch.op in ('insert', 'update', 'delete', 'restore') loop
    -- Las de la casa (sin área), solo una owner.
    if coalesce(c.after, c.before)->>'tab_id' is null and coalesce(v_role, '') <> 'owner' then
      perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'tasks.' || c.table_name, 'id', c.row_id, 'reason', 'house templates: owner'));
    end if;
    if c.table_name = 'review_template_items' and c.op in ('insert', 'update', 'restore') then
      select * into i from tasks.review_template_items where id = c.row_id;
      select * into t from tasks.review_templates where id = i.template_id;
      if t.id is null or t.deleted_at is not null or t.tab_id is distinct from i.tab_id then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'tasks.review_template_items', 'id', c.row_id, 'field', 'template_id', 'reason', 'a live template of the same area'));
      end if;
      if not tasks.review_expected_ok(i.answer, i.expected) then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'tasks.review_template_items', 'id', c.row_id, 'field', 'expected',
          'reason', 'quantity: {count}; reading: {unit, min?, max?}; otherwise {}'));
      end if;
    end if;
  end loop;
end $$;
select core.add_validate_hook('tasks', 'tasks.validate_review_templates');

revoke all on function tasks.review_expected_ok(text, jsonb) from public, anon, authenticated;
grant execute on function tasks.review_expected_ok(text, jsonb) to service_role;
revoke all on function tasks.validate_review_templates(jsonb) from public, anon, authenticated;
grant execute on function tasks.validate_review_templates(jsonb) to service_role;

-- La plantilla de la casa «Revisión de apertura» (ids fijos derivados de su nombre: repetir la migración no duplica).
do $$
declare
  v_tpl uuid := md5('ikisai-tasks-review-template:apertura')::uuid;
  v_item jsonb;
  v_pos int := 0;
begin
  insert into tasks.review_templates (id, tab_id, name, note, position)
  values (v_tpl, null, 'Revisión de apertura', 'Antes de cada evento: lo que tiene que estar bien para abrir. Los ítems críticos tienen que estar verificados.', 1024)
  on conflict (id) do nothing;
  for v_item in select * from jsonb_array_elements($items$[
    {"zone": "habitaciones", "title": "Habitaciones ventiladas y sin desperfectos", "answer": "check", "instructions": "Abre ventanas, mira paredes, suelo y mobiliario. Si algo está roto, foto en la observación."},
    {"zone": "camas", "title": "Camas montadas con ropa limpia", "answer": "quantity", "instructions": "Cuenta las camas listas. Lo esperado es el número de plazas del evento."},
    {"zone": "aseos", "title": "Aseos limpios, con papel y jabón", "answer": "check", "instructions": ""},
    {"zone": "duchas_acs", "title": "Agua caliente en las duchas", "answer": "reading", "expected": {"unit": "°C", "min": 50}, "critical": true, "instructions": "Deja correr el agua un minuto en la ducha más alejada y mide la temperatura."},
    {"zone": "puertas", "title": "Puertas y cerraduras funcionan", "answer": "check", "instructions": "Prueba llaves y cierres de las habitaciones y de las zonas comunes."},
    {"zone": "electricidad", "title": "Cuadro eléctrico y luces de emergencia", "answer": "check", "critical": true, "instructions": "Ningún diferencial saltado; prueba las luces de emergencia."},
    {"zone": "cocina", "title": "Cocina limpia y en orden", "answer": "check", "instructions": ""},
    {"zone": "maquinaria", "title": "Cámaras frigoríficas a temperatura", "answer": "reading", "expected": {"unit": "°C", "max": 5}, "critical": true, "instructions": "Lee el termómetro de cada cámara."},
    {"zone": "accesos", "title": "Accesos y salidas de emergencia despejados", "answer": "check", "critical": true, "instructions": "Nada que bloquee puertas, pasillos ni la señalización."},
    {"zone": "barandillas", "title": "Barandillas firmes", "answer": "check", "critical": true, "instructions": "Empuja cada tramo; si se mueve, falla."},
    {"zone": "comunes", "title": "Zonas comunes montadas", "answer": "photo", "instructions": "Una foto de cada sala montada."},
    {"zone": "limpieza", "title": "Productos de limpieza repuestos", "answer": "check", "instructions": ""},
    {"zone": "extintores", "title": "Extintores en su sitio y en fecha", "answer": "check", "critical": true, "instructions": "Mira la etiqueta de revisión y que el manómetro esté en verde."},
    {"zone": "agua", "title": "Cloro del agua", "answer": "reading", "expected": {"unit": "ppm", "min": 0.2, "max": 1}, "critical": true, "instructions": "Mide en el grifo de la cocina."},
    {"zone": "comunes", "title": "Observaciones generales", "answer": "note", "instructions": "Lo que no encaje en otro ítem."}
  ]$items$::jsonb) loop
    v_pos := v_pos + 1024;
    insert into tasks.review_template_items (id, tab_id, template_id, zone, title, instructions, answer, expected, critical, position)
    values (md5('ikisai-tasks-review-template:apertura/' || v_pos)::uuid, null, v_tpl, v_item->>'zone', v_item->>'title', coalesce(v_item->>'instructions', ''),
      v_item->>'answer', coalesce(v_item->'expected', '{}'::jsonb), coalesce((v_item->>'critical')::boolean, false), v_pos)
    on conflict (id) do nothing;
  end loop;
end $$;
