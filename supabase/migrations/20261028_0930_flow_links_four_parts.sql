-- Ikisai Flow · los enlaces de huésped de tres partes dejan de valer (auditoría de seguridad del 27-10, FL10).
-- Desde la 0915 todos los enlaces a la carta son de cuatro partes (con la revisión del cliente: un solo uso). Los de tres
-- partes, de antes, servían varias veces durante sus 10 minutos; ya no se emiten y los últimos caducaron hace tiempo.

create or replace function flow.public_guest_link(p jsonb) returns jsonb language plpgsql stable as $$
declare v_parts text[] := string_to_array(coalesce(p->>'invitation', ''), '.'); v_n int; v_id uuid; v_key text; v_c flow.customers; v_msg text; v_sig text;
begin
  v_n := coalesce(array_length(v_parts, 1), 0);
  if v_n <> 4 or v_parts[2] !~ '^[0-9]{1,12}$' or v_parts[4] !~ '^[0-9a-f]{64}$' or v_parts[3] !~ '^[0-9]{1,18}$' then return null; end if;
  begin v_id := v_parts[1]::uuid; exception when others then return null; end;
  v_key := flow.portal_key();
  v_msg := array_to_string(v_parts[1:v_n - 1], '.');
  v_sig := v_parts[v_n];
  if v_key is null or flow.hmac_sha256_hex(v_msg, v_key) <> v_sig then return null; end if;
  if v_parts[2]::bigint < extract(epoch from now()) then return jsonb_build_object('expired', true); end if;
  select * into v_c from flow.customers where id = v_id and deleted_at is null
     and origin in ('guest', 'visitor');
  if v_c.id is null then return null; end if;
  if v_parts[3]::bigint <> v_c.revision then return jsonb_build_object('used', true); end if;
  return jsonb_build_object('customerId', v_c.id, 'revision', v_c.revision, 'number', v_c.number);
end $$;

revoke all on all functions in schema flow from public, anon, authenticated;
grant execute on all functions in schema flow to service_role;
