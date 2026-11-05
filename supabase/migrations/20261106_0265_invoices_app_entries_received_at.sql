-- Finance · fl-27 (contrato con Flow, MUELA/equipo/feedback/finance/CONTRATO_fl-27_flow.md): `received_at` del apunte llega
-- al dispositivo. Una cuenta de Flow que pasa a Finance pendiente de cobro (`flow:account:…`, `methods {a_cobrar}`) se
-- reenvía al cobrarla; ese dinero cuenta en el arqueo del día en que llegó el cobro (`received_at`, que pone
-- `record_app_entry`), no del día de la venta. Solo lectura: la guarda del apunte no deja que el cliente lo cambie.

select core.register_table('invoices', 'invoices', 'app_entries', array[
  'source_app', 'source_ref', 'kind', 'nature', 'entry_date', 'description', 'amount_cents', 'tax_rate', 'tax_cents', 'net_cents',
  'pending_refunds_cents', 'methods', 'detail', 'event_id', 'notes', 'receipt_file_id', 'receipt_number', 'receipt_kind', 'received_at'],
  '{reader,editor,owner}', '{editor,owner}', true);
