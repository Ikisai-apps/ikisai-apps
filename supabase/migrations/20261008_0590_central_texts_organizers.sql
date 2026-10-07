-- Ikisai Central · tres textos más de Organizers (X2), en español e inglés y de tipo `mensaje`: fechas, presupuesto y propuesta.
-- Borradores de Central para que los revise el usuario. La nota del presupuesto no fija ningún importe: el mínimo por retiro
-- lo confirma el equipo en la propuesta. Toca solo el schema central.
-- La semilla de 0570 ya está publicada (inmutable): esta es una semilla aparte, con el mismo criterio. No hace nada con una
-- clave e idioma que ya existan y solo se ejecuta si Central ya tiene miembros (producción); las pruebas la llaman.

create or replace function central.seed_texts_organizers()
returns int language plpgsql as $$
declare v_ops jsonb := '[]'::jsonb; s record;
begin
  -- Las claves «organizers.…» se componen por partes: el lint las tomaría por referencias a otro schema.
  for s in select * from (values
    ('organizers' || '.dates_note', 'es', 'Fechas', 'Ikisai confirmará la fecha definitiva; lo que marques son posibilidades.', 31),
    ('organizers' || '.dates_note', 'en', 'Dates', 'Ikisai will confirm the final date; the dates you mark are only possibilities.', 31),
    ('organizers' || '.quote_note', 'es', 'Presupuesto', 'El precio es orientativo e incluye el IVA. Hay un importe mínimo por retiro: el equipo de Ikisai te lo confirmará en la propuesta.', 32),
    ('organizers' || '.quote_note', 'en', 'Quote', 'The price is an estimate and includes VAT. There is a minimum amount per retreat: the Ikisai team will confirm it in the proposal.', 32),
    ('organizers' || '.proposal_note', 'es', 'Propuesta', 'Para confirmar, pulsa «Quiero confirmar» y el equipo de Ikisai te contactará.', 33),
    ('organizers' || '.proposal_note', 'en', 'Proposal', 'To confirm, press «I want to confirm» and the Ikisai team will contact you.', 33)
  ) as t(key, lang, title, body, pos) loop
    if not exists (select 1 from central.texts where key = s.key and lang = s.lang and deleted_at is null) then
      v_ops := v_ops || jsonb_build_object('op', 'insert', 'table', 'central.texts', 'id', gen_random_uuid(),
        'fields', jsonb_build_object('key', s.key, 'lang', s.lang, 'kind', 'mensaje', 'title', s.title, 'body', s.body, 'position', s.pos));
    end if;
  end loop;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('central', 'migration:central-0590-organizers-texts', v_ops);
  end if;
  return jsonb_array_length(v_ops);
end $$;

do $$
begin
  if exists (select 1 from core.memberships where app = 'central') then perform central.seed_texts_organizers(); end if;
end $$;

revoke all on all functions in schema central from public, anon, authenticated;
grant execute on all functions in schema central to service_role;
