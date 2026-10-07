-- Ikisai Tasks · campos de archivo para la recogida de huérfanos (contrato §3.9, coordinacion/ampliacion/ALMACENAMIENTO.md).
-- Toca solo el registro de core para la app tasks. La única columna de Tasks que guarda un `file_id` de core.files es la
-- de los adjuntos de proyecto y de tarea; es operativa (un adjunto borrado y purgado deja su archivo huérfano). Los ZIP
-- temporales de importación no son archivos de core.files y no entran aquí.
select core.register_file_field('tasks', 'tasks', 'attachments', 'file_id', 'operational');
select core.enable_file_gc('tasks');
