-- 0714 · Estimado de utilidad de contestar a un asistente (X6; núcleo 0121), como en la 0707 (UTILIDAD_ESTIMADA.md):
-- `normal`, como leer los comentarios. Solo escribe mientras Dirección no haya decidido.
select core.usage_estimate('organizers', $est$[
  {"id": "organizers.retiro.resumen.comentarios.responder", "frequency": "normal", "audience": {"kinds": ["organizers"]}},
  {"id": "organizers.retiro.resumen.comentarios.respuesta", "frequency": "normal", "audience": {"kinds": ["organizers"]}},
  {"id": "organizers.retiro.resumen.comentarios.enviar", "frequency": "normal", "audience": {"kinds": ["organizers"]}}
]$est$::jsonb);
