-- Central · «Aplicar accesos» desde la ficha de persona (encargo de VG del 26-10-2026, plazo 29-10). El nivel de casa abre
-- todas las puertas de golpe; quien administra lo comprueba en la ficha y, si falta algo, lo aplica con esta acción.
-- Lee el nivel vigente de la ficha en la base (nunca el que mande el cliente) y llama a `core.apply_house_level`, que es
-- idempotente: lo ya dado se deja y concede lo que falte de lo que hoy diga `core.house_level_roles`. Cuando el núcleo amplíe
-- esa función (portales y Flow), esta acción lo aplica sin cambios. Solo el owner de Central. Toca solo central.
-- Referencia: docs/central/API.md §2.15.
create or replace function central.apply_house_level(p_ctx jsonb)
returns jsonb language plpgsql as $$
declare v_id text := p_ctx->'args'->>'personId'; p central.people; v_level text;
begin
  if coalesce(p_ctx->>'role', '') <> 'owner' then perform core.fail('FORBIDDEN', 403); end if;
  if coalesce(v_id, '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then perform core.fail('NOT_FOUND', 404); end if;
  select * into p from central.people where id = v_id::uuid;
  if p.id is null then perform core.fail('NOT_FOUND', 404); end if;
  if p.user_id is null then perform core.fail('NO_ACCOUNT', 422, jsonb_build_object('reason', 'the person has no account')); end if;
  v_level := central.effective_house_level(p);
  return jsonb_build_object('personId', p.id, 'userId', p.user_id, 'level', v_level,
    'changes', core.apply_house_level(p.user_id, v_level, nullif(p_ctx->>'actor', '')::uuid));
end $$;

revoke all on function central.apply_house_level(jsonb) from public, anon, authenticated;
grant execute on function central.apply_house_level(jsonb) to service_role;
select core.allow_read('central', 'central.apply_house_level', 'action', '{owner}');
