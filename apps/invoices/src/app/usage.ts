/**
 * Uso de funcionalidades (kit 0.17, USO.md): la cáscara crea el recolector y lo deja aquí; las pantallas envuelven sus
 * operaciones importantes con `usage.run` y el id escrito en literal (así entra en el catálogo).
 * Sin recolector (antes de entrar o en pruebas sin cáscara) la operación se ejecuta igual.
 */
import type { Usage } from '@ikisai/ui-kit';

let current: Usage | null = null;

export function setUsage(next: Usage | null): void { current = next; }

export const usage = {
  run<T>(featureId: string, fn: () => T | Promise<T>): Promise<T> {
    return current ? current.run(featureId, fn) : Promise.resolve().then(fn);
  },
  track(featureId: string, outcome?: 'success' | 'error'): void { current?.track(featureId, outcome); },
};
