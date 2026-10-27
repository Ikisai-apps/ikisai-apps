-- Central · pasada única del nivel de casa (encargo de VG del 26-10; núcleo 0095): a quien ya tenía nivel le llegan las
-- puertas nuevas (Flow, los portales y el ámbito «todos» de dirección) sin tener que pulsar «Aplicar accesos» persona a
-- persona. `core.apply_house_level` es idempotente: lo ya dado se deja y solo concede lo que falte. Recorre los niveles
-- vigentes del núcleo (`core.house_levels`), que el trigger de la 1506 mantiene al día. Toca solo central.
-- Referencia: docs/central/API.md §2.15.
do $$
declare r record;
begin
  for r in select user_id, level from core.house_levels order by user_id loop
    perform core.apply_house_level(r.user_id, r.level);
  end loop;
end $$;
