-- Ikisai Booking · O2, aviso al comercial de un «Apuntarme» nuevo (respuesta de Core del 14-10-2026: `on_submit` de las
-- sugerencias, #525, 0095). Al sugerir, el núcleo llama a `booking.join_on_submit` en la misma transacción; deja un aviso en
-- `portal_notices` y el tick del portal lo lleva a Tasks como `booking.proposal_comment` con su etiqueta, igual que las
-- supletorias. Nunca falla: si algo no encaja, no avisa, pero la sugerencia se crea igual. Toca solo el schema booking.

alter table booking.portal_notices drop constraint portal_notices_kind_check;
alter table booking.portal_notices add constraint portal_notices_kind_check check (kind in ('fechas','quiere_confirmar','comentario','supletorias','apuntarme'));

-- `{app, kind, suggestion}` del núcleo. Llamado desde un lote (sin `suggestion`), no hace nada.
create or replace function booking.join_on_submit(p jsonb)
returns jsonb language plpgsql as $$
declare v_res uuid; v_author uuid;
begin
  if p->'suggestion' is null or p->>'kind' is distinct from 'apuntarme' then return jsonb_build_object('notified', false); end if;
  begin
    select (o->'args'->>'reservation_id')::uuid into v_res from jsonb_array_elements(p->'suggestion'->'operations') o
     where o->>'op' = 'call' and o->>'procedure' = 'booking.join_from_suggestion' limit 1;
    v_author := nullif(p->'suggestion'->'author'->>'id', '')::uuid;
    if v_res is null or not exists (select 1 from booking.reservations where id = v_res and deleted_at is null) then
      return jsonb_build_object('notified', false);
    end if;
    insert into booking.portal_notices (reservation_id, kind, actor) values (v_res, 'apuntarme', v_author);
  exception when others then
    return jsonb_build_object('notified', false);
  end;
  return jsonb_build_object('notified', true);
end $$;

select core.allow_procedure('booking', 'booking.join_on_submit');
select core.set_suggestion_on_submit('booking', 'apuntarme', 'booking.join_on_submit');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
