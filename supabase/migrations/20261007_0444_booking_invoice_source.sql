-- Ikisai Booking · lectura para que Finance prepare el borrador de factura de una reserva (docs/invoices/API.md §14.8,
-- con los ajustes de Booking en docs/booking/API.md §19). Finance lee; Booking no escribe en Finance. Toca solo el schema booking.

-- Categoría de ingreso por tarifa: alojamiento (recinto y por persona), restauración (servicio de comidas), extras, servicios.
create or replace function booking.income_category(p_rate booking.rates)
returns text language sql immutable as $$
  select case when p_rate.id is null then 'servicios'
              when p_rate.layer in ('recinto','por_persona') then 'alojamiento'
              when p_rate.layer = 'servicio' and p_rate.service = 'comidas' then 'restauracion'
              when p_rate.layer = 'extra' then 'extras'
              else 'servicios' end;
$$;

create or replace function booking.reservation_invoice_source(p jsonb)
returns jsonb language plpgsql stable as $$
declare
  v_id uuid; v_r booking.reservations; v_f booking.reservation_finance; v_p booking.proposals; v_c booking.conditions;
  v_lines jsonb := '[]'::jsonb; v_subtotal numeric := 0; l record;
begin
  begin v_id := (p->'args'->>'reservation_id')::uuid; exception when others then v_id := null; end;
  select * into v_r from booking.reservations where id = v_id and deleted_at is null;
  if v_r.id is null then perform core.fail('NOT_FOUND', 404, jsonb_build_object('table', 'booking.reservations', 'id', p->'args'->>'reservation_id')); end if;
  select * into v_f from booking.reservation_finance where id = v_id and deleted_at is null;
  select * into v_p from booking.proposals where reservation_id = v_id and status = 'aceptada' and deleted_at is null;
  select * into v_c from booking.conditions where id = v_p.conditions_id;
  if v_c.id is null then select * into v_c from booking.conditions where is_default and deleted_at is null limit 1; end if;

  if v_p.id is not null then
    select coalesce(sum(round(quantity * unit_amount * (100 - discount_pct) / 100, 2)), 0) into v_subtotal
      from booking.proposal_lines where proposal_id = v_p.id and deleted_at is null and unit <> 'porcentaje';
    for l in select pl.*, r as rate from booking.proposal_lines pl left join booking.rates r on r.id = pl.rate_id
              where pl.proposal_id = v_p.id and pl.deleted_at is null order by pl.position, pl.created_at loop
      if l.unit = 'porcentaje' then
        -- ajuste sobre el subtotal (p. ej. «descuento de grupo −10 %»): línea propia con su importe
        v_lines := v_lines || jsonb_build_object('kind', 'ajuste', 'description', l.description, 'quantity', 1, 'unit', 'unidad',
          'unit_price', round(v_subtotal * l.unit_amount * l.quantity / 100, 2), 'discount_amount', 0,
          'vat_rate', v_c.vat_rate, 'income_category', 'alojamiento');
      else
        v_lines := v_lines || jsonb_build_object('kind', case when (l.rate).layer = 'extra' then 'extra' else 'tarifa' end,
          'description', l.description, 'quantity', l.quantity, 'unit', l.unit, 'unit_price', l.unit_amount,
          'discount_amount', round(l.quantity * l.unit_amount * l.discount_pct / 100, 2),
          'vat_rate', v_c.vat_rate, 'income_category', booking.income_category(l.rate));
      end if;
    end loop;
  elsif coalesce(v_f.final_amount, 0) > 0 then
    -- sin propuesta aceptada: una línea por el importe final acordado
    v_lines := jsonb_build_array(jsonb_build_object('kind', 'tarifa', 'description', 'Estancia · ' || v_r.title, 'quantity', 1, 'unit', 'estancia',
      'unit_price', v_f.final_amount, 'discount_amount', 0, 'vat_rate', v_c.vat_rate, 'income_category', 'alojamiento'));
  end if;

  return jsonb_build_object(
    'reservation', jsonb_build_object('id', v_r.id, 'code', v_r.code, 'label', v_r.title, 'revision', v_r.revision,
      'check_in', v_r.start_date, 'check_out', v_r.end_date),
    -- Booking guarda hoy solo el contacto: NIF y domicilio fiscal los completa Finance en el borrador
    'customer', jsonb_build_object('name', v_r.contact_name, 'kind', v_r.customer_type, 'tax_id', null, 'id_type', null, 'country', null, 'address', null),
    'prices_include_vat', coalesce(v_c.prices_include_vat, true),
    'proposal', case when v_p.id is null then null else jsonb_build_object('id', v_p.id, 'version', v_p.version, 'total', v_p.total) end,
    'final_amount', v_f.final_amount,
    'lines', v_lines,
    -- Booking no sabe qué se ha facturado: lo une Finance con sus propias facturas
    'invoiced', null);
end $$;

select core.allow_read('invoices', 'booking.reservation_invoice_source', 'function');
select core.allow_read('booking', 'booking.reservation_invoice_source', 'function', '{editor,owner}');

revoke all on all functions in schema booking from public, anon, authenticated;
grant execute on all functions in schema booking to service_role;
