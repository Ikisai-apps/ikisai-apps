-- Ikisai Booking · marcadores en el «Texto de las condiciones» (decisión del usuario, 8-10-2026): el portal recibe el
-- texto ya resuelto. Misma resolución que `_domain/booking/conditionsText.ts` (en español). Sin marcador para el plazo
-- interno del saldo. Toca solo el schema booking.

-- 2500 → «2.500»; 2500.5 → «2.500,50». Sin decimales si son cero.
create or replace function booking.fmt_es(p numeric, p_money boolean)
returns text language sql immutable as $$
  select case when p < 0 then '-' else '' end
      || replace(to_char(trunc(abs(round(p, 2))), 'FM999,999,999,999,990'), ',', '.')
      || case when round(abs(p), 2) = trunc(abs(round(p, 2))) then ''
              when p_money then ',' || lpad(((round(abs(p), 2) - trunc(abs(round(p, 2)))) * 100)::int::text, 2, '0')
              else ',' || rtrim(lpad(((round(abs(p), 2) - trunc(abs(round(p, 2)))) * 100)::int::text, 2, '0'), '0') end;
$$;

create or replace function booking.fmt_days_es(p numeric)
returns text language sql immutable as $$ select p::int || case when p = 1 then ' día' else ' días' end $$;

-- Frases de los tramos de cancelación, de mayor a menor antelación (una por línea).
create or replace function booking.cancellation_lines(p_conditions uuid)
returns text language plpgsql stable as $$
declare t record; v_prev int; v_out text[] := '{}'; v_when text; v_what text;
begin
  for t in select min_days_before m, coalesce(deposit_refund_pct, 0) r, coalesce(extra_costs, false) x
             from booking.cancellation_tiers where conditions_id = p_conditions and deleted_at is null order by min_days_before desc loop
    v_when := case when t.m > 0 then 'Con ' || booking.fmt_days_es(t.m) || ' o más de antelación'
                   when v_prev is not null then 'Con menos de ' || booking.fmt_days_es(v_prev)
                   else 'En cualquier momento' end;
    v_what := case when t.r <= 0 then 'no se devuelve la señal' else 'se devuelve el ' || booking.fmt_es(t.r, false) || ' % de la señal' end;
    v_out := v_out || (v_when || ': ' || v_what || case when t.x then ' y se cobran costes extra' else '' end || '.');
    v_prev := t.m;
  end loop;
  return nullif(array_to_string(v_out, E'\n'), '');
end $$;

create or replace function booking.conditions_text(p_conditions uuid)
returns text language plpgsql stable as $$
declare c booking.conditions; v_text text; v_key text; v_val text; v_vals jsonb; v_re text;
begin
  select * into c from booking.conditions where id = p_conditions;
  if c.id is null or c.text is null then return null; end if;
  v_vals := jsonb_build_object(
    'condiciones.senal_porcentaje', case when coalesce(c.deposit_percent, 0) = 0 then null else booking.fmt_es(c.deposit_percent, false) || ' %' end,
    'condiciones.senal_minima', case when coalesce(c.deposit_minimum, 0) = 0 then null else booking.fmt_es(c.deposit_minimum, true) || ' €' end,
    'condiciones.senal_plazo', case when coalesce(c.deposit_days, 0) = 0 then null else booking.fmt_days_es(c.deposit_days) end,
    'condiciones.senal_plazo_corto', case when coalesce(c.deposit_days_short, 0) = 0 then null else booking.fmt_days_es(c.deposit_days_short) end,
    'condiciones.poca_antelacion', case when coalesce(c.short_notice_days, 0) = 0 then null else booking.fmt_days_es(c.short_notice_days) end,
    'condiciones.iva', case when coalesce(c.vat_rate, 0) = 0 then null else booking.fmt_es(c.vat_rate, false) || ' %' end,
    'condiciones.minimo', case when coalesce(c.minimum_total, 0) = 0 then null else booking.fmt_es(c.minimum_total, true) || ' €' end,
    'condiciones.cancelacion', booking.cancellation_lines(c.id));
  v_text := c.text;
  for v_key, v_val in select key, value #>> '{}' from jsonb_each(v_vals) loop
    v_re := replace(v_key, '.', '\.');
    -- bloque condicional: fuera si el campo está vacío; si no, solo se quitan las marcas. Sin espacios dentro de las llaves:
    -- en las RE de PostgreSQL un cuantificador codicioso delante volvería codicioso el `.*?`.
    if v_val is null then
      v_text := regexp_replace(v_text, '\{\{#' || v_re || '\}\}.*?\{\{/' || v_re || '\}\}', '', 'g');
    else
      v_text := regexp_replace(v_text, '\{\{[#/]' || v_re || '\}\}', '', 'g');
    end if;
    v_text := regexp_replace(v_text, '\{\{' || v_re || '\}\}', replace(coalesce(v_val, ''), '\', '\\'), 'g');
  end loop;
  return v_text;
end $$;

create or replace function booking.portal_proposals(p jsonb)
returns jsonb language plpgsql stable as $$
declare v_r booking.reservations;
begin
  v_r := booking.portal_reservation_row(p);
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('id', x.id, 'version', x.version, 'status', x.status, 'nature', x.nature, 'start_date', x.start_date, 'end_date', x.end_date,
        'persons', x.persons, 'subtotal', x.subtotal, 'adjustments', x.adjustments, 'vat_amount', x.vat_amount, 'total', x.total, 'deposit_amount', x.deposit_amount,
        'valid_until', x.valid_until, 'includes', x.includes, 'excludes', x.excludes, 'sent_at', x.sent_at, 'decided_at', x.decided_at,
        'conditions', (select jsonb_build_object('name', c.name, 'text', booking.conditions_text(c.id), 'prices_include_vat', c.prices_include_vat, 'vat_rate', c.vat_rate,
            'deposit_percent', c.deposit_percent, 'deposit_minimum', c.deposit_minimum, 'deposit_days', c.deposit_days, 'deposit_days_short', c.deposit_days_short,
            'short_notice_days', c.short_notice_days,
            'tiers', coalesce((select jsonb_agg(jsonb_build_object('min_days_before', t.min_days_before, 'deposit_refund_pct', t.deposit_refund_pct, 'extra_costs', t.extra_costs)
              order by t.min_days_before desc) from booking.cancellation_tiers t where t.conditions_id = c.id and t.deleted_at is null), '[]'::jsonb))
          from booking.conditions c where c.id = x.conditions_id),
        'lines', coalesce((select jsonb_agg(jsonb_build_object('description', l.description, 'unit', l.unit, 'quantity', l.quantity, 'unit_amount', l.unit_amount,
            'discount_pct', l.discount_pct, 'amount', l.amount) order by l.position) from booking.proposal_lines l where l.proposal_id = x.id and l.deleted_at is null), '[]'::jsonb))
      order by x.version desc)
      from booking.proposals x where x.reservation_id = v_r.id and x.deleted_at is null and x.status in ('enviada','aceptada')), '[]'::jsonb));
end $$;

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
