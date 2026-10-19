-- Central · R6: lectura del kit del oficio para Tasks (`central.trade_kit_options`).
-- Tasks sugiere los materiales del kit al poner un oficio en una tarea. Solo filas vivas de oficios vivos; sin outsider
-- (no propone materiales). El kit es el del propio oficio: si Tasks quiere el de los padres, lo junta con `trade_options.path`.
-- Toca solo el schema central.

create view central.trade_kit_options as
select k.trade_id, k.item_id, k.quantity, k.note
  from central.trade_kit k
  join central.trades t on t.id = k.trade_id and t.deleted_at is null and t.active
 where k.deleted_at is null;

select core.allow_read('central', 'central.trade_kit_options', 'view');
select core.allow_read('tasks', 'central.trade_kit_options', 'view', '{reader,editor,owner}');
