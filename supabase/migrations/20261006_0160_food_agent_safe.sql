-- Food · procedimientos que un agente de IA puede usar sin aprobación humana (contrato §3.1).
-- Solo food.regenerate_preparation: recalcula la propuesta sin tocar pasos hechos ni reescritos a mano y solo retira
-- propuestas sin tocar de platos que ya no están. Validar el menú, cambiar su estado, dar por revisado un cambio del
-- evento y regenerar la compra siguen exigiendo aprobación (valor por defecto). Toca solo el schema food.
select core.allow_procedure('food', 'food.regenerate_preparation', false);
