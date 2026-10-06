import type { SyncClient, SyncClientOptions } from './types.ts';
import { SyncClientImpl } from './client.ts';

export * from './types.ts';
export { SyncApiError, isApiError, isNetworkError, toApiError, NETWORK_ERROR_CODE } from './errors.ts';
export { analyseConflict, changedByMe, changedByThem, deepEqual, rowKey, SYSTEM_COLUMNS } from './conflicts.ts';
export type { MirrorRow, OutboxEntry, ConflictRecord, BlobRecord } from './client.ts';
export { collectBlobMarkers, substituteBlobMarkers } from './client.ts';

/** Crea el cliente offline de una app (ver README y docs/core/CONTRATO_SINCRONIZACION.md §6). */
export function createSyncClient(options: SyncClientOptions): SyncClient {
  return new SyncClientImpl(options);
}
