-- 0711 · Estimado de utilidad del plano de Ikisai en Alojamiento (FB_2026_061, O-C2 a), como en la 0707
-- (UTILIDAD_ESTIMADA.md): `normal`, igual que el resto de Alojamiento. Solo escribe mientras Dirección no haya decidido.
select core.usage_estimate('organizers', $est$[
  {"id": "organizers.alojamiento.plano", "frequency": "normal", "audience": {"kinds": ["organizers"]}}
]$est$::jsonb);
