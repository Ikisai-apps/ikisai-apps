-- Finance · primer estimado de utilidad de sus funcionalidades (decisión de VG, vg-39; núcleo 0113 `core.usage_estimate`).
-- Dirección decide en Central; esto es solo el punto de partida de Finance: con qué frecuencia se espera que se use cada
-- pantalla o acción. Vale aunque la funcionalidad aún no esté en el catálogo de uso (se aplica al entrar).
-- La audiencia (equipos de Central) no se estima aquí: los equipos son ids de Central y los pone Dirección.
--   frequent: a diario en la oficina · normal: cada semana · occasional: de vez en cuando · rare_critical: poco, pero si falla,
--   duele (cierre de trimestre, conflictos) · do_not_evaluate: ayudas que no se miden.

select core.usage_estimate('invoices', $est$[
  {"id": "invoices.inicio", "frequency": "frequent"},
  {"id": "invoices.facturas", "frequency": "frequent"},
  {"id": "invoices.facturas.nueva", "frequency": "frequent"},
  {"id": "invoices.facturas.asignar", "frequency": "frequent"},
  {"id": "invoices.facturas.validar", "frequency": "frequent"},
  {"id": "invoices.facturas.subir_varias", "frequency": "normal"},
  {"id": "invoices.facturas.importar", "frequency": "occasional"},
  {"id": "invoices.emitidas", "frequency": "normal"},
  {"id": "invoices.emitidas.ficha.pago", "frequency": "occasional"},
  {"id": "invoices.compras", "frequency": "normal"},
  {"id": "invoices.apuntes", "frequency": "normal"},
  {"id": "invoices.arqueo", "frequency": "normal"},
  {"id": "invoices.justificante", "frequency": "normal"},
  {"id": "invoices.evento", "frequency": "occasional"},
  {"id": "invoices.proveedores", "frequency": "occasional"},
  {"id": "invoices.gestoria", "frequency": "rare_critical"},
  {"id": "invoices.conflictos", "frequency": "rare_critical"},
  {"id": "invoices.guia", "frequency": "do_not_evaluate"}
]$est$::jsonb);
