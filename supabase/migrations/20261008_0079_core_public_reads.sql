-- Lecturas públicas sin sesión (contrato §3.6, C1 de los portales): la Edge las sirve en `GET /api/v1/public/<nombre>`.
-- La app dueña del dato registra su función (`core.allow_public_read('contact', 'central.public_contact')`), que recibe
-- los argumentos como jsonb y devuelve jsonb. Solo datos públicos: nunca personales ni de un miembro.
create table core.public_reads (
  name text primary key check (name ~ '^[a-z][a-z_]{1,40}$'),
  procedure text not null check (procedure ~ '^[a-z]+\.[a-z_]+$')
);
alter table core.public_reads enable row level security;
revoke all on core.public_reads from public, anon, authenticated;
grant all on core.public_reads to service_role;

create or replace function core.allow_public_read(p_name text, p_procedure text)
returns void language sql as $$
  insert into core.public_reads (name, procedure) values (p_name, p_procedure)
  on conflict (name) do update set procedure = excluded.procedure;
$$;

create or replace function core.public_read(p_name text, p_args jsonb)
returns jsonb language plpgsql stable as $$
declare v_proc text; v_out jsonb;
begin
  select procedure into v_proc from core.public_reads where name = p_name;
  if v_proc is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('name', p_name)); end if;
  execute format('select %s($1)', v_proc) into v_out using coalesce(p_args, '{}'::jsonb);
  return v_out;
end $$;

create or replace function public.core_public_read(p_name text, p_args jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.public_read(p_name, p_args) $$;

revoke all on function core.allow_public_read(text, text) from public, anon, authenticated;
revoke all on function core.public_read(text, jsonb) from public, anon, authenticated;
revoke all on function public.core_public_read(text, jsonb) from public, anon, authenticated;
grant execute on function public.core_public_read(text, jsonb) to service_role;
