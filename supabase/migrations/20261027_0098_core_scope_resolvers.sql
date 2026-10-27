-- Ikisai Core · resolutores de ámbito de la app lectora (decisión de Core del 27-10-2026 a raíz de #751/#777 de Flow).
-- Una proyección de la app dueña que Flow lee con el rol de la persona no puede abrirse entera a todos los miembros de Flow
-- (huéspedes de cualquier evento). La dueña la sirve como lectura de función con el id del objeto obligatorio y, antes de
-- devolver nada, pregunta al núcleo si esa persona tiene ese objeto en su ámbito **en la app lectora**: el núcleo delega en
-- el resolutor que la lectora registró (`core.allow_scope_resolver('flow', 'flow.in_scope')`), con la forma
-- `fn(p_actor uuid, p_kind text, p_id text) returns boolean`. Sin resolutor, nadie está en ámbito.

create table core.scope_resolvers (
  app text primary key references core.apps(id),
  procedure text not null check (procedure ~ '^[a-z_]+\.[a-z0-9_]+$')
);
alter table core.scope_resolvers enable row level security;
revoke all on core.scope_resolvers from public, anon, authenticated;
grant all on core.scope_resolvers to service_role;

create or replace function core.allow_scope_resolver(p_app text, p_procedure text) returns void language sql as $$
  insert into core.scope_resolvers (app, procedure) values (p_app, p_procedure) on conflict (app) do update set procedure = excluded.procedure;
$$;

-- Para las funciones de lectura de la app dueña: ¿tiene esta persona este objeto en su ámbito dentro de la app que lee?
create or replace function core.reader_in_scope(p_app text, p_actor uuid, p_kind text, p_id text) returns boolean language plpgsql stable as $$
declare v_proc text; v_ok boolean;
begin
  if p_actor is null or p_id is null then return false; end if;
  select procedure into v_proc from core.scope_resolvers where app = p_app;
  if v_proc is null then return false; end if;
  execute format('select %s($1, $2, $3)', v_proc) into v_ok using p_actor, p_kind, p_id;
  return coalesce(v_ok, false);
end $$;

revoke all on function core.allow_scope_resolver(text, text) from public, anon, authenticated;
revoke all on function core.reader_in_scope(text, uuid, text, text) from public, anon, authenticated;
grant execute on function core.reader_in_scope(text, uuid, text, text) to service_role;
