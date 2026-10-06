-- Invoices · compras de Tasks (API.md §7.4, ronda 34). Toca solo el schema invoices.
-- 1. Destino `tasks` / `purchase_request`: una solicitud de compra de Tasks como destino de una línea.
-- 2. Lecturas para Tasks: `invoices.allocations_by_target` (qué facturas cubren cada solicitud) e
--    `invoices.supplier_options` (proveedores para el preferente). Las dos devuelven solo lo que el usuario puede ver en
--    Invoices: Tasks las llama con su sesión y el núcleo comprueba su pertenencia a Tasks; aquí se comprueba la de Invoices.

alter table invoices.allocations drop constraint allocations_target_check;
alter table invoices.allocations add constraint allocations_target_check check (
  (target_app = 'general' and target_kind in ('unassigned','operating_expense','investment') and target_id is null)
  or (target_app = 'tasks' and target_kind in ('area','project','task','purchase_request') and target_id is not null)
  or (target_app = 'booking' and target_kind in ('reservation','event') and target_id is not null)
  or (target_app = 'food' and target_kind in ('ingredient','equipment') and target_id is not null));

create or replace function invoices.can_read(p jsonb)
returns boolean language sql stable as $$
  select exists (select 1 from core.memberships m where m.app = 'invoices' and m.user_id = (p->>'actor')::uuid);
$$;

-- Por id de destino: factura (código y estado) e importe asignado. Sin las anuladas ni las borradas.
create or replace function invoices.allocations_by_target(p jsonb)
returns jsonb language sql stable as $$
  with a as (select p->'args' args)
  select jsonb_build_object('rows', case when not invoices.can_read(p) then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('target_id', al.target_id, 'invoice_id', i.id, 'invoice_code', i.code, 'status', i.status,
      'invoice_date', i.invoice_date, 'allocated_amount', al.allocated_amount, 'allocated_quantity', al.allocated_quantity) order by al.target_id, i.invoice_date, i.code)
    from a, invoices.allocations al join invoices.invoices i on i.id = al.invoice_id
    where al.deleted_at is null and i.deleted_at is null and i.status <> 'anulada'
      and al.target_app = coalesce(a.args->>'targetApp', 'tasks') and al.target_kind = a.args->>'targetKind'
      and al.target_id in (select jsonb_array_elements_text(coalesce(a.args->'ids', '[]'::jsonb)) limit 500)), '[]'::jsonb) end);
$$;

-- Proveedores vivos por nombre, alias o NIF (para elegir el preferente desde Tasks).
create or replace function invoices.supplier_options(p jsonb)
returns jsonb language sql stable as $$
  with a as (select lower(btrim(coalesce(p->'args'->>'q', ''))) q, least(greatest(coalesce((p->'args'->>'limit')::int, 20), 1), 50) lim)
  select jsonb_build_object('items', case when not invoices.can_read(p) then '[]'::jsonb else coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'name', s.name, 'slug', s.slug) order by s.name)
    from (select s.* from invoices.suppliers s, a
          where s.deleted_at is null and (a.q = '' or lower(s.name) like '%' || a.q || '%' or lower(coalesce(s.tax_id, '')) like '%' || a.q || '%'
                 or exists (select 1 from unnest(s.aliases) al where lower(al) like '%' || a.q || '%'))
          order by s.name limit (select lim from a)) s), '[]'::jsonb) end);
$$;

select core.allow_read('tasks', 'invoices.allocations_by_target', 'function');
select core.allow_read('tasks', 'invoices.supplier_options', 'function');
-- También desde Invoices (pruebas y la propia app).
select core.allow_read('invoices', 'invoices.allocations_by_target', 'function');
select core.allow_read('invoices', 'invoices.supplier_options', 'function');

revoke all on function invoices.can_read(jsonb), invoices.allocations_by_target(jsonb), invoices.supplier_options(jsonb) from public, anon, authenticated;
