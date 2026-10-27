-- Ikisai Core · inventario de campos (P15, pedido por Central #769 y UI-kit #771, ui-kit 0.59): el `feature-catalog.json` de
-- cada release trae `fields` (campos declarados con `data-field-id`, `fieldAttrs`/`markField` o la opción `field` del kit) y
-- `fieldsUninstrumented` (inputs, selects, textareas y campos del kit sin declarar). Solo metadatos del código, nunca valores.
-- Lo sube la publicación (`scripts/usage_catalog_ingest.py`) y lo sirve `GET usage/inventory` al owner de Central
-- (Revisión › Uso y cobertura, `inventorySources`). Contrato §3.8.

create table core.field_inventory (
  field_id text primary key check (field_id ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$'),
  app text not null references core.apps(id),
  screen text,
  route text,
  anchor_id text,
  label text,
  type text,
  entity text,
  prop text,
  required text,
  sensitivity text check (sensitivity is null or sensitivity in ('public','internal','personal','sensitive')),
  since text not null,                                -- primera release en que se vio
  last_seen text not null,                            -- última release que lo declaraba
  active boolean not null default true,               -- false: la última release de su app ya no lo declara
  removed_release text,
  raw jsonb not null default '{}'::jsonb,             -- la entrada tal cual (permission, since declarado, source, file, line…)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index field_inventory_app_idx on core.field_inventory (app, active);

-- Foto de la última release de cada app: se reemplaza entera en cada carga (no hay clave estable: es archivo y línea).
create table core.field_uninstrumented (
  id bigint generated always as identity primary key,
  app text not null references core.apps(id),
  screen text,
  file text,
  line integer,
  tag text,
  type text,
  anchor_id text,
  label text,
  release text not null,
  created_at timestamptz not null default now()
);
create index field_uninstrumented_app_idx on core.field_uninstrumented (app);

do $$
declare t text;
begin
  foreach t in array array['field_inventory','field_uninstrumented'] loop
    execute format('alter table core.%I enable row level security', t);
    execute format('revoke all on core.%I from public, anon, authenticated', t);
    execute format('grant all on core.%I to service_role', t);
  end loop;
end $$;

-- Carga de una release de una app: altas y cambios (conserva `since`), retirada de lo que ya no declara y foto nueva de lo
-- sin instrumentar. Las entradas de otra app o con un id inválido se saltan (se cuentan en `skipped`).
create or replace function core.ingest_field_inventory(p_app text, p_release text, p_fields jsonb, p_uninstrumented jsonb)
returns jsonb language plpgsql as $$
declare v jsonb; v_ids text[] := '{}'; v_id text; v_skipped int := 0; v_removed int; v_un int := 0; v_line int;
  t constant int := 200;
begin
  if not exists (select 1 from core.apps where id = p_app) then perform core.fail('APP_NOT_FOUND', 404, jsonb_build_object('app', p_app)); end if;
  if coalesce(p_release, '') = '' or char_length(p_release) > 80 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'release required')); end if;
  p_fields := coalesce(p_fields, '[]'::jsonb); p_uninstrumented := coalesce(p_uninstrumented, '[]'::jsonb);
  if jsonb_typeof(p_fields) <> 'array' or jsonb_array_length(p_fields) > 5000 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'fields must be an array of at most 5000')); end if;
  if jsonb_typeof(p_uninstrumented) <> 'array' or jsonb_array_length(p_uninstrumented) > 10000 then perform core.fail('INVALID_OPERATION', 422, jsonb_build_object('reason', 'fieldsUninstrumented must be an array of at most 10000')); end if;

  for v in select * from jsonb_array_elements(p_fields) loop
    v_id := case when jsonb_typeof(v) = 'object' then v->>'fieldId' end;
    if coalesce(v_id, '') !~ '^[a-z][a-z0-9_]*(\.[a-z0-9_-]+){1,7}$' or split_part(v_id, '.', 1) <> p_app
       or coalesce(v->>'app', p_app) <> p_app or v_id = any (v_ids) then v_skipped := v_skipped + 1; continue; end if;
    v_ids := v_ids || v_id;
    insert into core.field_inventory as f (field_id, app, screen, route, anchor_id, label, type, entity, prop, required, sensitivity, since, last_seen, raw)
    values (v_id, p_app, left(v->>'screen', t), left(v->>'route', t), left(v->>'anchorId', t), left(v->>'label', t), left(v->>'type', 40),
      left(v->>'entity', t), left(v->>'prop', t), left(v->>'required', t),
      case when v->>'sensitivity' in ('public','internal','personal','sensitive') then v->>'sensitivity' end, p_release, p_release, v)
    on conflict (field_id) do update set app = excluded.app, screen = excluded.screen, route = excluded.route, anchor_id = excluded.anchor_id,
      label = excluded.label, type = excluded.type, entity = excluded.entity, prop = excluded.prop, required = excluded.required,
      sensitivity = excluded.sensitivity, last_seen = p_release, active = true, removed_release = null, raw = excluded.raw, updated_at = now();
  end loop;
  update core.field_inventory set active = false, removed_release = p_release, updated_at = now()
   where app = p_app and active and not (field_id = any (v_ids));
  get diagnostics v_removed = row_count;

  delete from core.field_uninstrumented where app = p_app;
  for v in select * from jsonb_array_elements(p_uninstrumented) loop
    if jsonb_typeof(v) <> 'object' or coalesce(v->>'app', p_app) <> p_app then v_skipped := v_skipped + 1; continue; end if;
    v_line := case when v->>'line' ~ '^\d{1,9}$' then (v->>'line')::int end;
    insert into core.field_uninstrumented (app, screen, file, line, tag, type, anchor_id, label, release)
    values (p_app, left(v->>'screen', t), left(v->>'file', t), v_line, left(v->>'tag', 40), left(v->>'type', 40), left(v->>'anchorId', t), left(v->>'label', t), p_release);
    v_un := v_un + 1;
  end loop;
  return jsonb_build_object('fields', coalesce(array_length(v_ids, 1), 0), 'removed', v_removed, 'uninstrumented', v_un, 'skipped', v_skipped);
end $$;

-- Lectura para Revisión › Uso y cobertura: lo declarado en la última release (activo) y lo sin instrumentar, solo para el
-- owner de Central. p_app: 'all' (o null) o el id de una app.
create or replace function core.field_inventory_read(p_actor uuid, p_app text)
returns jsonb language plpgsql stable as $$
begin
  if not core.feedback_is_ecosystem_owner(p_actor) then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'field inventory is for the ecosystem owner')); end if;
  return jsonb_build_object(
    'fields', coalesce((select jsonb_agg(jsonb_build_object('fieldId', f.field_id, 'app', f.app, 'screen', f.screen, 'route', f.route,
        'anchorId', f.anchor_id, 'label', f.label, 'type', f.type, 'entity', f.entity, 'prop', f.prop, 'required', f.required,
        'permission', f.raw->>'permission', 'sensitivity', f.sensitivity, 'since', f.since, 'lastSeen', f.last_seen,
        'declaredSince', f.raw->>'since', 'source', f.raw->>'source') order by f.app, f.field_id)
      from core.field_inventory f where f.active and (p_app is null or p_app = 'all' or f.app = p_app)), '[]'::jsonb),
    'fieldsUninstrumented', coalesce((select jsonb_agg(jsonb_build_object('app', u.app, 'screen', u.screen, 'file', u.file, 'line', u.line,
        'tag', u.tag, 'type', u.type, 'anchorId', u.anchor_id, 'label', u.label, 'release', u.release) order by u.app, u.file, u.line, u.id)
      from core.field_uninstrumented u where p_app is null or p_app = 'all' or u.app = p_app), '[]'::jsonb));
end $$;

-- Envoltorio para la Edge (service_role).
create or replace function public.core_field_inventory_read(p_actor uuid, p_app text) returns jsonb
language sql security definer set search_path = '' as $$ select core.field_inventory_read(p_actor, p_app) $$;

do $$
declare f text;
begin
  for f in select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where (n.nspname = 'core' and p.proname in ('ingest_field_inventory','field_inventory_read'))
             or (n.nspname = 'public' and p.proname = 'core_field_inventory_read') loop
    execute 'revoke all on function ' || f || ' from public, anon, authenticated';
    execute 'grant execute on function ' || f || ' to service_role';
  end loop;
end $$;
