-- Food · previsión de partida de la carta «Barra · Evento de octubre» (hueco S3 de la QA de extremo a extremo de Flow, #821,
-- encargo de Core del 27-10-2026). Toca solo el schema food.
--
-- La semilla (1109) dejó las unidades a cubrir vacías: la previsión salía a 0 y Flow no generaba existencias. Aquí, una de
-- partida para el sábado 31 (400 montaditos a partes iguales y la barra), editable en Previsión. Solo se rellenan las líneas
-- que siguen sin previsión: lo que alguien ya haya puesto no se toca.
create or replace function food.seed_carta_octubre_prevision()
returns int language plpgsql as $$
declare v_ops jsonb;
begin
  select coalesce(jsonb_agg(jsonb_build_object('op', 'update', 'table', 'food.carta_lines', 'id', l.id, 'expectedRevision', l.revision,
           'fields', jsonb_build_object('expected_units', v.units)) order by l.position), '[]'::jsonb)
    into v_ops
    from food.carta_lines l
    join (values
      -- Montaditos: 50 de cada uno (400 en total).
      ('f00dca7a-0000-4000-8000-000000000201'::uuid, 50), ('f00dca7a-0000-4000-8000-000000000202', 50),
      ('f00dca7a-0000-4000-8000-000000000203', 50), ('f00dca7a-0000-4000-8000-000000000204', 50),
      ('f00dca7a-0000-4000-8000-000000000205', 50), ('f00dca7a-0000-4000-8000-000000000206', 50),
      ('f00dca7a-0000-4000-8000-000000000207', 50), ('f00dca7a-0000-4000-8000-000000000208', 50),
      -- Barra: agua, refresco, cerveza, café o infusión y palomitas.
      ('f00dca7a-0000-4000-8000-000000000209', 120), ('f00dca7a-0000-4000-8000-000000000210', 100),
      ('f00dca7a-0000-4000-8000-000000000211', 120), ('f00dca7a-0000-4000-8000-000000000212', 60),
      ('f00dca7a-0000-4000-8000-000000000213', 80)
    ) as v(line_id, units) on v.line_id = l.id
   where l.deleted_at is null and coalesce(l.expected_units, 0) = 0;
  if jsonb_array_length(v_ops) > 0 then
    perform core.apply_migration_operations('food', 'migration:food-1114-carta-octubre-prevision', v_ops);
  end if;
  return jsonb_array_length(v_ops);
end $$;
revoke all on function food.seed_carta_octubre_prevision() from public, anon, authenticated;

do $$
begin
  if exists (select 1 from core.memberships where app = 'food') then perform food.seed_carta_octubre_prevision(); end if;
end $$;
