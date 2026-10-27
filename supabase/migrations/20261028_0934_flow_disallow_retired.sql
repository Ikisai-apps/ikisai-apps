-- Ikisai Flow · fuera los permisos de procedimientos que ya no existen (auditoría de seguridad del 27-10, FL8).
-- `flow.mark_receipt_sent` se retiró en la 0917, `flow.mark_closure_sent` en la 0927 y `flow.unit_link_external` en la 0931
-- (lo anota flow-api), pero sus `allow_procedure` seguían: si alguien volviera a crear una de ellas sin comprobaciones, el
-- navegador podría marcar envíos o enlaces. `core.disallow_procedure` (núcleo 0106) los retira.
select core.disallow_procedure('flow', 'flow.mark_receipt_sent');
select core.disallow_procedure('flow', 'flow.mark_closure_sent');
select core.disallow_procedure('flow', 'flow.unit_link_external');
