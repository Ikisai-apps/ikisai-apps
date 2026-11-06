-- Invoices · proveedores para Food (decisión de VG, Q3 d, 06-11-2026; API.md §7.10). Toca solo el schema invoices.
--
-- Food elige el proveedor de cada línea de compra (y el habitual de cada ingrediente) entre los de Finance, y da de alta
-- uno nuevo si no existe. Food guarda el id del proveedor como referencia lógica, sin FK.
-- 1. Lectura publicada `invoices.food_supplier_projection`: id, nombre, NIF y `active` (false si está en la papelera:
--    así Food sigue enseñando el nombre de las líneas antiguas). Sin notas ni categorías.
-- 2. Alta `invoices.register_supplier` {name, tax_id?}: acción de sistema. La llama la Edge de Finance desde la ruta de
--    worker `POST suppliers` con `X-Ikisai-Caller: food`, y escribe «Finance (sistema)». Antes de crear busca un
--    proveedor vivo con el mismo NIF o, si no lo hay, con el mismo nombre normalizado (o alias); si lo encuentra, lo
--    devuelve (`existing`) sin tocarlo. Un nombre igual con otro NIF es otro proveedor.

create view invoices.food_supplier_projection as
  select s.id, s.name, s.tax_id, (s.deleted_at is null) as active, s.revision
    from invoices.suppliers s;

revoke all on invoices.food_supplier_projection from public, anon, authenticated;
grant select on invoices.food_supplier_projection to service_role;
select core.allow_read('food', 'invoices.food_supplier_projection', 'view');
select core.allow_read('invoices', 'invoices.food_supplier_projection', 'view');

-- register {name, tax_id?, app} → {id, name, tax_id, active, status: created | existing, matched_by: tax_id | name | null}
create or replace function invoices.register_supplier(p jsonb)
returns jsonb language plpgsql as $$
declare
  a jsonb := coalesce(p->'args', '{}'::jsonb);
  v_app text := btrim(coalesce(a->>'app', ''));
  v_name text := regexp_replace(btrim(coalesce(a->>'name', '')), '\s+', ' ', 'g');
  v_tax text := nullif(upper(regexp_replace(coalesce(a->>'tax_id', ''), '[\s./-]', '', 'g')), '');
  v_key text;
  s invoices.suppliers;
  v_by text;
  v_id uuid := gen_random_uuid();
begin
  if v_app = '' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'app')); end if;
  if length(v_name) not between 1 and 200 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'name')); end if;
  if v_tax is not null and length(v_tax) not between 2 and 32 then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'tax_id')); end if;
  v_key := invoices.slugify(v_name, 200);
  if v_key = '' then perform core.fail('INVALID_ARGS', 422, jsonb_build_object('field', 'name', 'reason', 'no letters or digits')); end if;
  -- Dos altas iguales a la vez: la segunda espera y encuentra la primera.
  perform pg_advisory_xact_lock(hashtext('invoices.register_supplier:' || coalesce(v_tax, v_key)));
  if v_tax is not null then
    select * into s from invoices.suppliers where deleted_at is null and upper(tax_id) = v_tax limit 1;
    if s.id is not null then v_by := 'tax_id'; end if;
  end if;
  if s.id is null then
    select * into s from invoices.suppliers x
     where x.deleted_at is null and (v_tax is null or x.tax_id is null or upper(x.tax_id) = v_tax)
       and (invoices.slugify(x.name, 200) = v_key or exists (select 1 from unnest(x.aliases) al where invoices.slugify(al, 200) = v_key))
     order by (x.tax_id is not null) desc, x.created_at limit 1;
    if s.id is not null then v_by := 'name'; end if;
  end if;
  if s.id is not null then
    return jsonb_build_object('id', s.id, 'name', s.name, 'tax_id', s.tax_id, 'active', true, 'status', 'existing', 'matched_by', v_by);
  end if;
  perform set_config('invoices.procedure', 'register_supplier', true);
  perform core.apply_system_operations('invoices', jsonb_build_array(jsonb_build_object('op', 'insert', 'table', 'invoices.suppliers', 'id', v_id,
    'fields', jsonb_build_object('name', v_name, 'tax_id', v_tax, 'notes', format('Alta desde %s.', initcap(v_app))))));
  perform set_config('invoices.procedure', '', true);
  select * into s from invoices.suppliers where id = v_id;
  return jsonb_build_object('id', s.id, 'name', s.name, 'tax_id', s.tax_id, 'active', true, 'status', 'created', 'matched_by', null);
end $$;

select core.allow_read('invoices', 'invoices.register_supplier', 'action', '{}');
revoke all on function invoices.register_supplier(jsonb) from public, anon, authenticated;
grant execute on function invoices.register_supplier(jsonb) to service_role;
