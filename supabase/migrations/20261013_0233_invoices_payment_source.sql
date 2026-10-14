-- Invoices · FB_2026_027 y FB_2026_030: de dónde sale el pago (decisión del usuario vía Core, 13-10-2026). Toca solo el schema invoices.
--
-- Casi todas las facturas recibidas están pagadas, y muchas dicen cómo. La fecha de pago nunca es la del clic en la app:
--   · `leido`: el documento dice que está pagada o cómo se paga (método y, si la trae, la fecha; si no, la de la factura).
--   · `sin_confirmar`: el documento no dice nada. Se da por pagada con la fecha de la factura y un toque la confirma.
--   · `confirmado`: lo ha dicho una persona (confirmar, marcar pagada o marcar pendiente).
--   · null: facturas anteriores a esta migración; no se tocan salvo la corrección del final.
--
-- El valor por defecto lo pone un trigger (también para lo que llega sin red y para las importaciones de la IA): una factura
-- sin `payment_source`, pendiente y con fecha pasa a «Pagada (sin confirmar)» al crearse o al recibir su primera fecha. Si
-- cambia la fecha de una sin confirmar, su fecha de pago la sigue.

alter table invoices.invoices add column payment_source text
  check (payment_source is null or payment_source in ('leido', 'sin_confirmar', 'confirmado'));

select core.register_table('invoices', 'invoices', 'invoices', array[
  'supplier_id','invoice_date','object','invoice_number','currency','due_date','expense_category','is_investment','deductibility',
  'status','review_reason','annulled_reason','payment_status','payment_method','paid_at','source_total',
  'calculated_base','calculated_vat','calculated_other','calculated_withholding','calculated_total','totals_delta',
  'source','import_sha256','import_meta','notes',
  'drive_file_id','drive_url',
  'invoice_kind','rectifies_invoice_id','rectifies_number','rectification_without_original',
  'declared_period','delivered_elsewhere','payment_source'], '{reader,editor,owner}', '{editor,owner}', true);

create or replace function invoices.payment_default()
returns trigger language plpgsql as $$
begin
  if new.status = 'anulada' then return new; end if;
  if new.payment_source is null and new.payment_status = 'pendiente' and new.invoice_date is not null
     and (tg_op = 'INSERT' or old.invoice_date is null) then
    new.payment_status := 'pagada'; new.paid_at := new.invoice_date; new.payment_source := 'sin_confirmar';
  elsif tg_op = 'UPDATE' and new.payment_source = 'sin_confirmar' and old.payment_source = 'sin_confirmar' and new.payment_status = 'pagada'
     and new.invoice_date is not null and new.invoice_date is distinct from old.invoice_date and new.paid_at is not distinct from old.paid_at then
    new.paid_at := new.invoice_date;
  end if;
  return new;
end $$;
-- Después de invoices_guard_invoice (los triggers del mismo momento van por orden alfabético).
create trigger invoices_payment_default before insert or update on invoices.invoices for each row execute function invoices.payment_default();

-- guard_invoice (de 0200) con `payment_source` libre en una archivada, como el resto del pago; lo demás, igual.
create or replace function invoices.guard_invoice()
returns trigger language plpgsql as $$
declare v_proc text := coalesce(current_setting('invoices.procedure', true), ''); v_role text; v_changed text[];
begin
  if new.deleted_at is not null and old.deleted_at is null then
    perform core.fail('INVOICE_NOT_DELETABLE', 422, jsonb_build_object('id', new.id));
  end if;
  -- Las columnas generadas (fiscal_*) son null en NEW dentro de un trigger before: se excluyen de la comparación.
  if old.status = 'anulada' then
    select array_agg(n.key) into v_changed from jsonb_each(invoices.comparable(to_jsonb(new)) - 'notes') n join jsonb_each(to_jsonb(old)) o on o.key = n.key where n.value is distinct from o.value;
    if v_changed is not null then perform core.fail('INVOICE_ANNULLED', 409, jsonb_build_object('id', new.id, 'fields', to_jsonb(v_changed))); end if;
  end if;
  if old.status = 'archivada' and new.status = 'archivada' then
    select array_agg(n.key) into v_changed
      from jsonb_each(invoices.comparable(to_jsonb(new)) - 'payment_status' - 'payment_method' - 'paid_at' - 'payment_source' - 'notes') n
      join jsonb_each(to_jsonb(old)) o on o.key = n.key where n.value is distinct from o.value;
    if v_changed is not null then perform core.fail('INVOICE_ARCHIVED', 409, jsonb_build_object('id', new.id, 'fields', to_jsonb(v_changed))); end if;
  end if;
  if new.status <> old.status then
    if new.status in ('validada', 'anulada') and v_proc not in ('validate', 'annul') and not (old.status = 'archivada' and new.status = 'validada') then
      perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status, 'reason', 'use the procedure'));
    end if;
    if (new.status = 'archivada' or old.status = 'archivada') and v_proc <> 'archive_period' then
      v_role := invoices.actor_role();
      if v_role is distinct from 'owner' then perform core.fail('FORBIDDEN', 403, jsonb_build_object('reason', 'only owners archive invoices')); end if;
      if (old.status, new.status) not in (('validada', 'archivada'), ('archivada', 'validada')) then
        perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status));
      end if;
    end if;
    if old.status = 'anulada' then perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status)); end if;
    if old.status = 'validada' and new.status = 'pendiente_datos' then perform core.fail('INVALID_TRANSITION', 422, jsonb_build_object('from', old.status, 'to', new.status)); end if;
  end if;
  return new;
end $$;

-- Corrección de las ya marcadas con la fecha del clic: se distinguen en core.changes porque el cambio que las pasó a pagadas
-- puso como fecha de pago el mismo día en que se hizo (hora de Madrid) y sigue siendo esa. Pasan a la fecha de la factura y
-- quedan confirmadas (fue una persona quien dijo que estaban pagadas). Las que no se distinguen se dejan como están.
create or replace function invoices.fix_click_paid_dates()
returns int language plpgsql as $$
declare v_ops jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('op', 'update', 'table', 'invoices.invoices', 'id', i.id, 'expectedRevision', i.revision,
           'fields', jsonb_build_object('paid_at', i.invoice_date, 'payment_source', 'confirmado'))), '[]'::jsonb)
    into v_ops
    from invoices.invoices i
   where i.deleted_at is null and i.status <> 'anulada' and i.payment_status = 'pagada' and i.payment_source is null
     and i.invoice_date is not null and i.paid_at is distinct from i.invoice_date
     and exists (
       select 1 from (
         select ch.after, ch.committed_at from core.changes ch
          where ch.app = 'invoices' and ch.schema_name = 'invoices' and ch.table_name = 'invoices' and ch.row_id = i.id and ch.op = 'update'
            and ch.before->>'payment_status' is distinct from 'pagada' and ch.after->>'payment_status' = 'pagada'
          order by ch.cursor desc, ch.seq desc limit 1) last
        where last.after->>'paid_at' = ((last.committed_at at time zone 'Europe/Madrid')::date)::text
          and i.paid_at = (last.after->>'paid_at')::date);
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('invoices', 'migration:invoices-0233-paid-at', v_ops);
  end if;
  return jsonb_array_length(v_ops);
end $$;
revoke all on function invoices.fix_click_paid_dates() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from core.memberships where app = 'invoices') then perform invoices.fix_click_paid_dates(); end if;
end $$;
