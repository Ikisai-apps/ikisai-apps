-- Ikisai Central · Revisor › cobertura de campos, por pantalla (decisión de VG del 27-10: declarar campo a campo es inviable).
-- La utilidad se hereda del estimado de cada app y del uso real (`core.field_coverage`); Dirección solo actúa sobre los grupos
-- de campos candidatos de una pantalla: «dejar», «revisar más tarde» o «retirar», y, si quiere, declara una excepción a la
-- utilidad heredada para esa pantalla. Una fila viva por pantalla.
-- Escriben el owner y los editores con el ámbito `direccion` (rol y ámbitos del inicio del lote, núcleo 0105); leen editor
-- y owner. «Retirar» no borra nada: queda anotado para el equipo de la app. Toca solo el schema central.

create table central.field_group_reviews (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  app text not null check (app ~ '^[a-z][a-z0-9_]*$'),
  screen text not null check (length(screen) between 1 and 160),
  decision text check (decision is null or decision in ('dejar','revisar_mas_tarde','retirar')),
  audience text check (audience is null or length(btrim(audience)) between 1 and 60),
  frequency text check (frequency is null or frequency in ('diaria','semanal','mensual','ocasional')),
  fields_count int check (fields_count is null or fields_count between 0 and 5000),
  note text check (note is null or length(note) <= 300)
);
create unique index field_group_reviews_screen_idx on central.field_group_reviews (app, screen) where deleted_at is null;
create trigger field_group_reviews_reparent before update on central.field_group_reviews for each row execute function central.forbid_reparent('screen');

select core.register_table('central', 'central', 'field_group_reviews', array['app','screen','decision','audience','frequency','fields_count','note'], '{editor,owner}');

create or replace function central.check_field_group_reviews(p jsonb)
returns void language plpgsql as $$
declare v_role text; v_scopes jsonb;
begin
  if not exists (select 1 from core.changes c where c.app = 'central' and c.cursor = (p->>'cursor')::bigint
                  and c.schema_name = 'central' and c.table_name = 'field_group_reviews') then
    return;
  end if;
  if nullif(p->>'role', '') is not null then
    v_role := p->>'role'; v_scopes := p->'scopes';
  else
    select m.role, m.scopes into v_role, v_scopes from core.memberships m where m.app = 'central' and m.user_id = (p->>'actor')::uuid;
  end if;
  if v_role is distinct from 'owner' and not (v_role = 'editor' and coalesce(v_scopes->>'direccion', '') = 'true') then
    perform core.fail('FORBIDDEN', 403, jsonb_build_object('table', 'central.field_group_reviews', 'reason', 'owner or editor with direccion scope'));
  end if;
end $$;

select core.add_validate_hook('central', 'central.check_field_group_reviews');

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
