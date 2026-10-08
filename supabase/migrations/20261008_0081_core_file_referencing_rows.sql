-- K3 (portales): filas de la app que referencian un archivo, por los campos declarados con `core.register_file_field`.
-- La Edge de un portal deja leer un archivo ajeno solo si alguna de esas filas es visible para el miembro (hook
-- `visible` de la app, el mismo de snapshot y changes): un organizador abre los materiales de su retiro, no los de otro.
create or replace function core.file_referencing_rows(p_app text, p_file uuid)
returns jsonb language plpgsql stable as $$
declare f core.file_fields; v_rows jsonb; v_out jsonb := '[]'::jsonb;
begin
  for f in select * from core.file_fields where app = p_app loop
    execute format('select coalesce(jsonb_agg(to_jsonb(t)), ''[]''::jsonb) from %I.%I t where %I = $1 and (to_jsonb(t)->>''deleted_at'') is null',
                   f.schema_name, f.table_name, f.column_name) into v_rows using p_file;
    select v_out || coalesce(jsonb_agg(jsonb_build_object('table', f.schema_name || '.' || f.table_name, 'row', r)), '[]'::jsonb)
      into v_out from jsonb_array_elements(v_rows) r;
  end loop;
  return v_out;
end $$;

create or replace function public.core_file_referencing_rows(p_app text, p_file uuid) returns jsonb
language sql stable security definer set search_path = '' as $$ select core.file_referencing_rows(p_app, p_file) $$;

revoke all on function core.file_referencing_rows(text, uuid) from public, anon, authenticated;
revoke all on function public.core_file_referencing_rows(text, uuid) from public, anon, authenticated;
grant execute on function public.core_file_referencing_rows(text, uuid) to service_role;
