-- Invoices · R4, PR 1: las líneas se enlazan con artículos de Recursos (RECURSOS.md §6 «Finance»; diseño aprobado por el
-- usuario el 14-10-2026 en coordinacion/invoices/R4_PREPARACION.md). Toca solo el schema invoices; de resources solo lee.
--
-- - `invoice_lines.item_id`: el artículo (`resources.items`); null = sin enlazar.
-- - `invoice_lines.item_factor`: factor hacia la unidad base del artículo que se usó en esa línea (copiado de
--   `resources.item_units` al enlazar, para que cambiar la conversión no reescriba el pasado). null = la unidad de la
--   línea ya es la base.
-- - `invoice_lines.space_id`: dónde entra; null = el sitio habitual del artículo.
-- - `invoice_lines.item_source`: «manual» o «recordado», como `label_source`; lo pone el disparador.
-- - La memoria por proveedor (`item_labels`) recuerda también el artículo y el factor; `label` pasa a ser opcional (una
--   entrada puede recordar solo el artículo). Nada se borra: `label` sigue siendo el respaldo.
-- - Cambiar solo el enlace no devuelve una factura validada a revisión (como «Mi nombre»).
-- - `invoices.settings`: interruptor `resources_links` (apagado sin fila). Hasta que el usuario lo verifique, nada cambia
--   a la vista y no se crean entradas en Recursos.

alter table invoices.invoice_lines
  add column item_id uuid,
  add column item_factor numeric check (item_factor is null or item_factor > 0),
  add column space_id uuid,
  add column item_source text check (item_source is null or item_source in ('manual', 'recordado'));
create index invoice_lines_item_idx on invoices.invoice_lines (item_id) where item_id is not null;

select core.register_table('invoices', 'invoices', 'invoice_lines', array[
  'invoice_id','position','description','quantity','unit','unit_price','discount_amount','net_amount','vat_rate','vat_amount','gross_amount',
  'item_type','match_name','expense_category','is_investment','confidence','notes','rectifies_line_id','label',
  'item_id','item_factor','space_id'], '{reader,editor,owner}', '{editor,owner}', true);

alter table invoices.item_labels
  alter column label drop not null,
  add column item_id uuid,
  add column item_factor numeric check (item_factor is null or item_factor > 0),
  add constraint item_labels_remembers_something check (label is not null or item_id is not null);

select core.register_table('invoices', 'invoices', 'item_labels', array['supplier_id','match_key','label','uses','last_invoice_id','item_id','item_factor'], '{reader,editor,owner}', '{editor,owner}', true);

create table invoices.settings (
  id uuid primary key default gen_random_uuid(),
  revision bigint not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  deleted_at timestamptz,
  key text not null check (key in ('resources_links')),
  value jsonb not null
);
create unique index settings_key_live on invoices.settings (key) where deleted_at is null;
select core.register_table('invoices', 'invoices', 'settings', array['key','value'], '{reader,editor,owner}', '{owner}');

create or replace function invoices.resources_links()
returns boolean language sql stable as $$
  select coalesce((select s.value = 'true'::jsonb from invoices.settings s where s.key = 'resources_links' and s.deleted_at is null), false)
$$;

-- Al insertar una línea: «Mi nombre» y el artículo recordados para ese proveedor y artículo, si no los trae. Al cambiar
-- el enlace a mano, «manual».
create or replace function invoices.apply_item_label()
returns trigger language plpgsql as $$
declare m invoices.item_labels;
begin
  if tg_op = 'INSERT' then
    if new.label is not null then new.label_source := 'manual'; end if;
    if new.item_id is not null then new.item_source := 'manual'; end if;
    if new.label is null or new.item_id is null then
      select il.* into m from invoices.item_labels il
        join invoices.invoices i on i.id = new.invoice_id and i.supplier_id = il.supplier_id
       where il.deleted_at is null and il.match_key = invoices.item_key(new.description);
      if m.id is not null then
        if new.label is null and m.label is not null then new.label := m.label; new.label_source := 'recordado'; end if;
        if new.item_id is null and m.item_id is not null then
          new.item_id := m.item_id; new.item_factor := coalesce(new.item_factor, m.item_factor); new.item_source := 'recordado';
        end if;
      end if;
    end if;
    return new;
  end if;
  if new.label is distinct from old.label then new.label_source := case when new.label is null then null else 'manual' end; end if;
  if new.item_id is distinct from old.item_id or new.item_factor is distinct from old.item_factor then
    new.item_source := case when new.item_id is null then null else 'manual' end;
  end if;
  return new;
end $$;

-- Al validar: las líneas con «Mi nombre» o con artículo se guardan en la memoria del proveedor.
create or replace function invoices.learn_item_labels(p jsonb)
returns void language plpgsql as $$
declare v_app text := p->>'app'; v_cursor bigint := (p->>'cursor')::bigint; v_ctx jsonb := invoices.hook_ctx(p); l record; m invoices.item_labels;
begin
  for l in
    select distinct on (invoices.item_key(li.description)) i.id as invoice_id, i.supplier_id, invoices.item_key(li.description) as match_key,
           btrim(li.label) as label, li.item_id, li.item_factor
      from invoices.invoices i
      join invoices.invoice_lines li on li.invoice_id = i.id and li.deleted_at is null and (li.label is not null or li.item_id is not null)
     where i.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.table_name = 'invoices'
                      and ch.op = 'update' and ch.after->>'status' = 'validada' and ch.before->>'status' is distinct from 'validada')
       and invoices.item_key(li.description) is not null
     order by invoices.item_key(li.description), li.position
  loop
    select * into m from invoices.item_labels where supplier_id = l.supplier_id and match_key = l.match_key and deleted_at is null;
    if m.id is null then
      perform invoices.row_op(v_ctx, jsonb_build_object('op', 'insert', 'table', 'invoices.item_labels', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('supplier_id', l.supplier_id, 'match_key', l.match_key, 'label', l.label, 'uses', 1, 'last_invoice_id', l.invoice_id,
                                     'item_id', l.item_id, 'item_factor', l.item_factor)));
    else
      -- Lo que la línea no trae (p. ej. sin «Mi nombre» pero con artículo) no borra lo que ya se recordaba.
      perform invoices.row_op(v_ctx, jsonb_build_object('op', 'update', 'table', 'invoices.item_labels', 'id', m.id, 'expectedRevision', m.revision,
        'fields', jsonb_build_object('label', coalesce(l.label, m.label), 'uses', m.uses + 1, 'last_invoice_id', l.invoice_id,
                                     'item_id', coalesce(l.item_id, m.item_id), 'item_factor', case when l.item_id is not null then l.item_factor else m.item_factor end)));
    end if;
  end loop;
end $$;

-- Cambiar solo «Mi nombre» o el enlace con Recursos de una línea no es editar la factura: no la devuelve a revisión.
create or replace function invoices.label_only_change(p_op text, p_before jsonb, p_after jsonb)
returns boolean language sql immutable as $$
  select p_op = 'update' and p_before is not null and p_after is not null
     and (p_before - array['label', 'label_source', 'item_id', 'item_factor', 'space_id', 'item_source', 'revision', 'updated_at', 'updated_by'])
       = (p_after - array['label', 'label_source', 'item_id', 'item_factor', 'space_id', 'item_source', 'revision', 'updated_at', 'updated_by']);
$$;

-- Hook: el artículo existe y no está borrado; el sitio, vivo y activo. Y el interruptor solo vale true o false.
create or replace function invoices.check_resource_links(p jsonb)
returns void language plpgsql as $$
declare v_app text := p->>'app'; v_cursor bigint := (p->>'cursor')::bigint; r record;
begin
  for r in
    select li.id, li.item_id, li.space_id from invoices.invoice_lines li
     where li.id in (select ch.row_id from core.changes ch where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices'
                       and ch.table_name = 'invoice_lines' and ch.op in ('insert', 'update'))
       and li.deleted_at is null and (li.item_id is not null or li.space_id is not null)
  loop
    if r.item_id is not null and not exists (select 1 from resources.items it where it.id = r.item_id and it.deleted_at is null) then
      perform core.fail('INVALID_RESOURCE_LINK', 422, jsonb_build_object('lineId', r.id, 'itemId', r.item_id, 'reason', 'item not found'));
    end if;
    if r.space_id is not null and not exists (select 1 from resources.spaces s where s.id = r.space_id and s.deleted_at is null and s.active) then
      perform core.fail('INVALID_RESOURCE_LINK', 422, jsonb_build_object('lineId', r.id, 'spaceId', r.space_id, 'reason', 'space not found'));
    end if;
  end loop;
  if exists (select 1 from core.changes ch join invoices.settings s on s.id = ch.row_id
              where ch.app = v_app and ch.cursor = v_cursor and ch.schema_name = 'invoices' and ch.table_name = 'settings'
                and s.deleted_at is null and jsonb_typeof(s.value) <> 'boolean') then
    perform core.fail('INVALID_SETTING', 422, jsonb_build_object('reason', 'resources_links is true or false'));
  end if;
end $$;
select core.add_validate_hook('invoices', 'invoices.check_resource_links');
