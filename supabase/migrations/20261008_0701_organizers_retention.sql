-- Ikisai Organizers · conservación de las respuestas de los huéspedes (B18; decisión del usuario del 8-10-2026).
-- Las respuestas a las preguntas del organizador se borran a los 6 meses del fin del retiro, como el resto de datos del
-- huésped («como mucho seis meses después de tu estancia»). Logotipo, materiales, preguntas y experiencia se conservan.
-- Fin del retiro: `booking.reservation_end_dates` (proyección de Booking para Organizers, #335). Una reserva borrada,
-- cancelada o perdida sin fecha de fin caduca ya. Toca solo el schema organizers.

-- Una respuesta purgada se queda sin valor (null) antes de borrarse, para no conservar el dato en la fila.
alter table organizers.answers alter column value drop not null;

create or replace function organizers.answers_due_on(p_end date, p_status text)
returns date language sql immutable as $$
  select case
    when p_end is not null then (p_end + interval '6 months')::date
    when p_status in ('borrada', 'cancelada', 'perdida') or p_status is null then date '1970-01-01'
    else null
  end;
$$;

create or replace function organizers.answers_due(p_limit int)
returns setof organizers.answers language sql stable as $$
  select a.* from organizers.answers a
    left join booking.reservation_end_dates d on d.reservation_id = a.reservation_id
   where a.deleted_at is null
     and organizers.answers_due_on(d.end_date, d.status) <= (now() at time zone 'Europe/Madrid')::date
   order by a.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 240));
$$;

create or replace function organizers.retention_has_work()
returns boolean language sql stable as $$ select exists (select 1 from organizers.answers_due(1)) $$;

-- Una vuelta: vacía el valor de cada respuesta vencida y la borra, en un lote del sistema firmado por «Organizers
-- (sistema)», para que los dispositivos de los organizadores borren también su copia.
create or replace function organizers.retention_run(p jsonb)
returns jsonb language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; a organizers.answers; v_count int := 0; v_out jsonb;
begin
  for a in select * from organizers.answers_due(coalesce((p->'args'->>'limit')::int, 200)) loop
    v_ops := v_ops
      || jsonb_build_object('op', 'update', 'table', 'organizers.answers', 'id', a.id, 'expectedRevision', a.revision, 'fields', jsonb_build_object('value', 'null'::jsonb))
      || jsonb_build_object('op', 'delete', 'table', 'organizers.answers', 'id', a.id, 'expectedRevision', a.revision + 1);
    v_count := v_count + 1;
  end loop;
  if v_count = 0 then return jsonb_build_object('purged', 0); end if;
  v_out := core.apply_system_operations('organizers', v_ops);
  return jsonb_build_object('purged', v_count, 'cursor', v_out->'cursor');
end $$;

select core.allow_read('organizers', 'organizers.retention_run', 'action', '{}');
select core.schedule_tick('organizers', 'retention/tick', '45 3 * * *', 'organizers.retention_has_work');

revoke all on all functions in schema organizers from public, anon, authenticated;
grant execute on all functions in schema organizers to service_role;
