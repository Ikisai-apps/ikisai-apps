-- 0708 · Estimado de utilidad de los dos campos de «Entrar con un código por correo» (#906), que entran ahora en el inventario
-- (P15). Sigue a la 0707 (UTILIDAD_ESTIMADA.md). `occasional`, no `frequent` como el resto de la entrada: solo se usa cuando
-- quien organiza no tiene el enlace a mano. Solo escribe mientras Dirección no haya decidido (core.usage_estimate, 0113).
select core.usage_estimate('organizers', $est$[
  {"id": "organizers.entrada.codigo.codigo", "frequency": "occasional", "audience": {"kinds": ["organizers"]}},
  {"id": "organizers.entrada.codigo.correo", "frequency": "occasional", "audience": {"kinds": ["organizers"]}}
]$est$::jsonb);
