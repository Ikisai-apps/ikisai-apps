-- Invoices · agentes de IA (contrato §3.1). Toca solo el schema invoices.
--
-- Procedimientos seguros para un agente (sin aprobación humana): solo invoices.import_v1, que crea o completa una factura
-- en `pendiente_revision` y nunca la valida. Validar, anular, crear o marcar entregas y archivar un periodo siguen
-- exigiendo aprobación (valor por defecto de core.allow_procedure).
select core.allow_procedure('invoices', 'invoices.import_v1', false);

-- Lectura para el hook `agentRisk` de la Edge: para cada id del lote (factura, artículo, impuesto, asignación o documento)
-- devuelve su factura con estado, código y si ya está en una entrega a la gestoría. No devuelve importes ni notas.
create or replace function invoices.agent_risk(p jsonb)
returns jsonb language sql stable as $$
  with refs as (
    select x::uuid as id
    from jsonb_array_elements_text(coalesce(p->'args'->'ids', '[]'::jsonb)) x
    where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ), m as (
    select r.id as ref, i.id as invoice_id from refs r join invoices.invoices i on i.id = r.id
    union all select r.id, l.invoice_id from refs r join invoices.invoice_lines l on l.id = r.id
    union all select r.id, t.invoice_id from refs r join invoices.tax_lines t on t.id = r.id
    union all select r.id, a.invoice_id from refs r join invoices.allocations a on a.id = r.id
    union all select r.id, f.invoice_id from refs r join invoices.invoice_files f on f.id = r.id
  )
  select jsonb_build_object('rows', coalesce(jsonb_agg(jsonb_build_object(
      'ref', m.ref, 'invoice_id', i.id, 'code', i.code, 'status', i.status,
      'exported', exists (select 1 from invoices.export_items ei where ei.invoice_id = i.id),
      'delivered', exists (select 1 from invoices.export_items ei join invoices.exports e on e.id = ei.export_id
                           where ei.invoice_id = i.id and e.status = 'entregada'))), '[]'::jsonb))
  from m join invoices.invoices i on i.id = m.invoice_id;
$$;
revoke all on function invoices.agent_risk(jsonb) from public, anon, authenticated;
select core.allow_read('invoices', 'invoices.agent_risk', 'function', '{editor,owner}');
