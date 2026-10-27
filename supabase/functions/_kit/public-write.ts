/**
 * Escrituras públicas sin sesión (migración 0094, contrato §3.6): la Edge, tras validar la credencial anónima del
 * cliente, aplica un lote de filas en las tablas que la app abrió con `core.allow_public_write`, con el actor de servicio
 * de la app («Flow (sistema)»). Solo insert y update, como mucho 50; la app limita el resto con sus hooks (core.is_public_batch()).
 */
import { ensureServiceActor } from './service.ts';
import type { Supabase } from './supabase.ts';

export interface PublicOperation {
  op: 'insert' | 'update';
  table: string;
  id: string;
  fields: Record<string, unknown>;
  expectedRevision?: number;
}

export interface PublicBatchResult { cursor: number; results: unknown[] }

/** `visitorId` (C11): el visitante que firma el lote; los hooks lo leen con core.current_visitor(). */
export async function applyPublicOperations(supabase: Supabase, app: string, operations: PublicOperation[], visitorId: string | null = null): Promise<PublicBatchResult> {
  await ensureServiceActor(supabase, app);
  return supabase.rpc<PublicBatchResult>('core_apply_public_operations', { p_app: app, p_operations: operations, p_visitor: visitorId });
}
