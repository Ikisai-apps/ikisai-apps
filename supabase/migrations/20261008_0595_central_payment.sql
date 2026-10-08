-- Ikisai Central · instrucciones de pago (F3 de Organizers, fase 3 «Formalización»): IBAN y Bizum de la Entidad, marcadores
-- {{entidad.iban}} y {{entidad.bizum}}, y el texto `payment.instructions` en español e inglés. Los datos reales los escribe
-- el owner en la pantalla Entidad (nunca en Git). Toca solo el schema central.

-- ---------------------------------------------------------------------------
-- Entidad: cuenta para transferencias y Bizum. El IBAN se guarda sin espacios y en mayúsculas (el dígito de control lo
-- comprueba `_domain/central`); se muestra en grupos de cuatro.
-- ---------------------------------------------------------------------------
alter table central.entity add column iban text check (iban is null or iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$');
alter table central.entity add column bizum text check (bizum is null or bizum ~ '^[0-9 +]{3,20}$');

select core.register_table('central', 'central', 'entity', array['legal_name','trade_name','tax_id','address_line','postal_code','city',
  'province','country','email','phone','website','logo_file_id','iban','bizum'], '{reader,editor,owner}', '{owner}');

-- IBAN legible: «ES12 3456 7890 …».
create or replace function central.format_iban(p_iban text)
returns text language sql immutable as $$
  select nullif(btrim(regexp_replace(coalesce(p_iban, ''), '(.{4})', '\1 ', 'g')), '');
$$;

-- La proyección de la entidad añade al final la cuenta y el Bizum (Finance los imprime en las facturas emitidas).
create or replace view central.common_entity_projection as
select e.id as entity_id, e.legal_name, e.trade_name, e.tax_id, e.address_line, e.postal_code, e.city, e.province, e.country,
       e.email, e.phone, e.website, e.revision as entity_revision, e.updated_at,
       f.id as logo_file_id, f.bucket as logo_bucket, f.path as logo_path, f.mime as logo_mime, f.sha256 as logo_sha256,
       f.storage_provider as logo_provider, e.iban, e.bizum
  from central.entity e
  left join core.files f on f.id = e.logo_file_id and f.app = 'central' and f.status = 'verified'
 where e.deleted_at is null;

revoke all on central.common_entity_projection from public, anon, authenticated;
grant select on central.common_entity_projection to service_role;

-- ---------------------------------------------------------------------------
-- Marcadores nuevos: {{entidad.iban}} y {{entidad.bizum}} (lo que falta, «—», como el resto).
-- ---------------------------------------------------------------------------
create or replace function central.render_text(p_body text)
returns text language plpgsql stable as $$
declare e central.entity; v_mail text; v_phone text; v_address text;
begin
  select * into e from central.entity where deleted_at is null limit 1;
  -- El contacto es el mismo en los dos idiomas: sale del texto en español.
  select body into v_mail from central.texts where key = 'contact.email' and lang = 'es' and deleted_at is null;
  select body into v_phone from central.texts where key = 'contact.phone' and lang = 'es' and deleted_at is null;
  v_address := nullif(concat_ws(', ', e.address_line, nullif(btrim(concat_ws(' ', e.postal_code, e.city)), ''), e.province,
    case when e.country is not null and e.country <> 'ES' then e.country end), '');
  return replace(replace(replace(replace(replace(replace(replace(p_body,
    '{{entidad.razon_social}}', coalesce(e.legal_name, '—')),
    '{{entidad.nif}}', coalesce(e.tax_id, '—')),
    '{{entidad.domicilio}}', coalesce(v_address, '—')),
    '{{entidad.iban}}', coalesce(central.format_iban(e.iban), '—')),
    '{{entidad.bizum}}', coalesce(nullif(btrim(e.bizum), ''), '—')),
    '{{contacto.correo}}', coalesce(btrim(v_mail), '—')),
    '{{contacto.telefono}}', coalesce(btrim(v_phone), '—'));
end $$;

-- ---------------------------------------------------------------------------
-- Texto `payment.instructions` (mensaje), en español e inglés: borradores de Central que revisa el usuario.
-- Mismo criterio que las otras semillas: no duplica y solo se ejecuta si Central ya tiene miembros.
-- ---------------------------------------------------------------------------
create or replace function central.seed_texts_payment()
returns int language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; s record;
begin
  for s in select * from (values
    ('payment.instructions', 'es', 'Cómo pagar', $es$**Por transferencia** a la cuenta {{entidad.iban}}, a nombre de {{entidad.razon_social}}. En el concepto, escribe el código de tu reserva y tu nombre, por ejemplo: «RSV_2026_012 Ana López».

**Por Bizum** al {{entidad.bizum}}, con el mismo concepto.

Si tienes cualquier duda sobre un pago, escríbenos a {{contacto.correo}}.$es$, 35),
    ('payment.instructions', 'en', 'How to pay', $en$**By bank transfer** to account {{entidad.iban}}, in the name of {{entidad.razon_social}}. In the payment reference, write your booking code and your name, for example: «RSV_2026_012 Ana López».

**By Bizum** (Spanish mobile payments) to {{entidad.bizum}}, with the same reference.

If you have any questions about a payment, write to us at {{contacto.correo}}.$en$, 35)
  ) as t(key, lang, title, body, pos) loop
    if not exists (select 1 from central.texts where key = s.key and lang = s.lang and deleted_at is null) then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'central.texts', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('key', s.key, 'lang', s.lang, 'kind', 'mensaje', 'title', s.title, 'body', s.body, 'position', s.pos));
    end if;
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('central', 'migration:central-0595-payment-texts', v_ops);
  end if;
  return jsonb_array_length(v_ops);
end $$;

do $$
begin
  if exists (select 1 from core.memberships where app = 'central') then perform central.seed_texts_payment(); end if;
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
