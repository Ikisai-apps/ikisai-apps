-- 0713 · Estimado de utilidad de la planta con camas en Alojamiento (FB_2026_061, O-C2 b), como en la 0707
-- (UTILIDAD_ESTIMADA.md): el desplegable, el mapa y tocar una cama, `normal` como el reparto; cambiar de vista o de dibujo,
-- `occasional`. Solo escribe mientras Dirección no haya decidido.
select core.usage_estimate('organizers', $est$[
  {"id": "organizers.alojamiento.planta", "frequency": "normal", "audience": {"kinds": ["organizers"]}},
  {"id": "organizers.alojamiento.planta.mapa", "frequency": "normal", "audience": {"kinds": ["organizers"]}},
  {"id": "organizers.alojamiento.planta.mapa.espacio", "frequency": "normal", "audience": {"kinds": ["organizers"]}},
  {"id": "organizers.alojamiento.planta.mapa.fila", "frequency": "normal", "audience": {"kinds": ["organizers"]}},
  {"id": "organizers.alojamiento.planta.mapa.vista", "frequency": "occasional", "audience": {"kinds": ["organizers"]}},
  {"id": "organizers.alojamiento.planta.mapa.dibujo", "frequency": "occasional", "audience": {"kinds": ["organizers"]}}
]$est$::jsonb);
