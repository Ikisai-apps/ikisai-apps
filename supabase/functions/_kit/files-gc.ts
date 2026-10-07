/**
 * Recogida de huérfanos (contrato §3.9, ALMACENAMIENTO.md fase 2): marca a diario los archivos sin referencia de las apps con
 * la recogida activada y borra, del proveedor y de core.files, los que llevan 30 días huérfanos y no son legales ni permanentes.
 */
import type { Supabase } from './supabase.ts';
import type { StorageAccess } from './storage.ts';

export function createFilesGc(supabase: Supabase, storage: StorageAccess) {
  async function tick() {
    const marked = await supabase.rpc<{ marked: number; cleared: number }>('core_file_gc_mark', { p_limit: 2000 });
    const claims = await supabase.rpc<Array<{ id: string; bucket: string; path: string; storage_provider: 'supabase' | 'r2'; size: number }>>('core_file_gc_claim', { p_limit: 100 });
    let deleted = 0; let bytes = 0; let failed = 0;
    for (const file of claims) {
      try {
        await storage.remove(file);
        await supabase.rpc('core_file_gc_done', { p_id: file.id });
        deleted++; bytes += Number(file.size) || 0;
      } catch {
        failed++;
      }
    }
    return { ...marked, deleted, bytes, failed };
  }
  return { tick };
}
