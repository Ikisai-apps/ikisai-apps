/** Ikisai Booking · checklist base del evento (C04 §8). Sin tabla de plantillas: la app genera las altas en un lote normal. */
import { CHECKLIST_TYPES, TABLES, type ChecklistType } from './catalog.ts';

export const CHECKLIST_TYPE_LABELS: Record<ChecklistType, string> = {
  preparacion_general: 'Preparación general',
  alojamiento: 'Alojamiento',
  cocina_comedor: 'Cocina y comedor',
  salas: 'Salas',
  salida_rotacion: 'Salida y rotación',
};

export const CHECKLIST_TEMPLATE: Record<ChecklistType, readonly string[]> = {
  preparacion_general: ['Espacios abiertos y accesibles', 'Climatización revisada', 'Wifi operativo', 'Baños operativos'],
  alojamiento: ['Habitaciones revisadas', 'Camas preparadas', 'Ropa y textiles disponibles', 'Mosquiteras y ventilación revisadas'],
  cocina_comedor: ['Menaje completo', 'Vajilla lista', 'Limpieza de cocina correcta', 'Comedor preparado'],
  salas: ['Montaje correcto', 'Sonido revisado', 'Mobiliario correcto', 'Consumibles básicos disponibles'],
  salida_rotacion: ['Habitaciones revisadas tras la salida', 'Daños detectados', 'Objetos perdidos revisados', 'Espacio listo para el siguiente uso'],
};

export interface ChecklistInsert {
  op: 'insert';
  table: typeof TABLES.checklist;
  id: string;
  fields: { event_id: string; checklist_type: ChecklistType; label: string; position: number };
}

/**
 * Altas del checklist base para un evento. `existing` evita duplicar ítems que ya están (mismo tipo y texto).
 * `newId` lo aporta quien llama (`crypto.randomUUID` en navegador y Edge).
 */
export function checklistSeedOperations(
  eventId: string,
  newId: () => string,
  options: { types?: readonly ChecklistType[]; existing?: ReadonlyArray<{ checklist_type: string; label: string }> } = {},
): ChecklistInsert[] {
  const seen = new Set((options.existing ?? []).map((item) => `${item.checklist_type}\u0000${item.label.trim().toLowerCase()}`));
  const operations: ChecklistInsert[] = [];
  for (const type of options.types ?? CHECKLIST_TYPES) {
    CHECKLIST_TEMPLATE[type].forEach((label, index) => {
      if (seen.has(`${type}\u0000${label.toLowerCase()}`)) return;
      operations.push({ op: 'insert', table: TABLES.checklist, id: newId(), fields: { event_id: eventId, checklist_type: type, label, position: index + 1 } });
    });
  }
  return operations;
}
