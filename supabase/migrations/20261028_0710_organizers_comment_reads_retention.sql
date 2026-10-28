-- Ikisai Organizers · conservación de las lecturas de comentarios (`comment_reads`, 0706; línea de Core del 28-10).
-- Una lectura se borra a los 180 días o cuando el retiro terminó hace más de 90 (un retiro borrado, cancelado o perdido, a
-- los 90 días de leerla). Va en la misma vuelta que las respuestas de los huéspedes (B18, 0701): `organizers.retention_run`,
-- en un lote del sistema, para que los dispositivos borren también su copia. Toca solo el schema organizers.

create or replace function organizers.comment_reads_due(p_limit int)
returns setof organizers.comment_reads language sql stable as $$
  select r.* from organizers.comment_reads r
    left join booking.reservation_end_dates d on d.reservation_id = r.reservation_id
   where r.deleted_at is null
     and (r.read_at < now() - interval '180 days'
          or (d.end_date is not null and d.end_date < (now() at time zone 'Europe/Madrid')::date - 90)
          or ((d.status in ('borrada', 'cancelada', 'perdida') or d.reservation_id is null) and r.read_at < now() - interval '90 days'))
   order by r.read_at
   limit greatest(1, least(coalesce(p_limit, 200), 240));
$$;

create or replace function organizers.retention_has_work()
returns boolean language sql stable as $$
  select exists (select 1 from organizers.answers_due(1)) or exists (select 1 from organizers.comment_reads_due(1))
$$;

-- Una vuelta: las respuestas vencidas (se vacían y se borran, como en 0701) y, con lo que quede del límite, las lecturas.
create or replace function organizers.retention_run(p jsonb)
returns jsonb language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; a organizers.answers; r organizers.comment_reads; v_count int := 0; v_reads int := 0; v_out jsonb;
        v_limit int := greatest(1, least(coalesce((p->'args'->>'limit')::int, 200), 240));
begin
  for a in select * from organizers.answers_due(v_limit) loop
    v_ops := v_ops
      || jsonb_build_object('op', 'update', 'table', 'organizers.answers', 'id', a.id, 'expectedRevision', a.revision, 'fields', jsonb_build_object('value', 'null'::jsonb))
      || jsonb_build_object('op', 'delete', 'table', 'organizers.answers', 'id', a.id, 'expectedRevision', a.revision + 1);
    v_count := v_count + 1;
  end loop;
  if v_count < v_limit then
    for r in select * from organizers.comment_reads_due(v_limit - v_count) loop
      v_ops := v_ops || jsonb_build_object('op', 'delete', 'table', 'organizers.comment_reads', 'id', r.id, 'expectedRevision', r.revision);
      v_reads := v_reads + 1;
    end loop;
  end if;
  if v_count = 0 and v_reads = 0 then return jsonb_build_object('purged', 0, 'reads', 0); end if;
  v_out := core.apply_system_operations('organizers', v_ops);
  return jsonb_build_object('purged', v_count, 'reads', v_reads, 'cursor', v_out->'cursor');
end $$;

create or replace function organizers.validate_batch(p jsonb)
returns void language plpgsql as $$
declare
  v_actor uuid := nullif(p->>'actor', '')::uuid;
  v_res uuid;
  c record;
begin
  for c in select table_name, op, before, after from core.changes
            where app = p->>'app' and cursor = (p->>'cursor')::bigint and schema_name = 'organizers' and op <> 'call' loop
    if c.before is not null and (c.before->>'reservation_id' is distinct from c.after->>'reservation_id'
        or (c.table_name = 'answers' and (c.before->>'guest_id' is distinct from c.after->>'guest_id' or c.before->>'question_id' is distinct from c.after->>'question_id'))) then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.' || c.table_name));
    end if;
    -- Una lectura no se cambia; solo la borra la conservación (0710), en un lote de «Organizers (sistema)».
    if c.table_name = 'comment_reads' and c.before is not null
       and not (c.op = 'delete' and v_actor is not null and v_actor = core.service_actor('organizers')) then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.comment_reads'));
    end if;
    if c.table_name in ('materials','questions') and c.before is not null and c.before->>'owner_id' is distinct from c.after->>'owner_id' then
      perform core.fail('IMMUTABLE_FIELD', 422, jsonb_build_object('table', 'organizers.' || c.table_name, 'field', 'owner_id'));
    end if;
    if v_actor is null or v_actor = core.service_actor('organizers') then continue; end if;
    v_res := (c.after->>'reservation_id')::uuid;
    if c.table_name = 'comment_reads' then
      -- Cada persona apunta solo lo suyo, de un comentario de asistente de ese retiro, con cualquier acceso al retiro
      -- (también «todos» de dirección: leer no es cambiar el retiro).
      if c.after->>'user_id' is distinct from v_actor::text then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'organizers.comment_reads', 'field', 'user_id'));
      end if;
      if not core.portal_in_scope('organizers', v_actor, v_res, null) then
        perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
      end if;
      if not exists (select 1 from core.feedback_reports f
                      where f.id = (c.after->>'report_id')::uuid and f.origin_app = 'guests' and f.subject = 'event'
                        and f.scope->>'reservation_id' = v_res::text) then
        perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'organizers.comment_reads', 'field', 'report_id'));
      end if;
      continue;
    end if;
    if c.table_name = 'answers' then
      if not core.portal_in_scope('guests', v_actor, v_res, (c.after->>'guest_id')::uuid)
         or not exists (select 1 from organizers.questions q where q.id = (c.after->>'question_id')::uuid and q.reservation_id = v_res) then
        perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
      end if;
    elsif not organizers.own_grant(v_actor, v_res) then
      -- Con «todos» (dirección) se ve, pero se propone: la sugerencia la aplica el organizador al aceptarla.
      if core.portal_in_scope('organizers', v_actor, v_res, null) then
        perform core.fail('SUGGESTION_REQUIRED', 403, jsonb_build_object('reservation_id', v_res, 'kind', 'propuesta_equipo'));
      end if;
      perform core.fail('OUT_OF_SCOPE', 403, jsonb_build_object('reservation_id', v_res));
    elsif c.table_name in ('materials','questions') and c.before is null and c.after->>'owner_id' is distinct from v_actor::text then
      perform core.fail('INVALID_FIELDS', 422, jsonb_build_object('table', 'organizers.' || c.table_name, 'field', 'owner_id'));
    end if;
  end loop;
end $$;

revoke all on all functions in schema organizers from public, anon, authenticated;
grant execute on all functions in schema organizers to service_role;
