-- Ikisai Core · retirada del esquema heredado `ikisai.*` de la app antigua de Tareas.
-- Aceptación del usuario el 6 de octubre de 2026 («Tareas ok»): tasks.ikisai.com sirve la app nueva sobre `tasks.*`.
-- Comprobado antes: `ikisai.tasks` vacía (0 filas) y `ikisai.changes` vacía; solo el área y el proyecto iniciales.
do $$
declare f text;
begin
  for f in select 'public.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'ikisai\_%' loop
    execute 'drop function if exists ' || f || ' cascade';
  end loop;
end $$;
drop schema if exists ikisai cascade;
