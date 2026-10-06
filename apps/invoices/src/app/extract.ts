/** Extracción automática (API.md §6, V2): pide a la Edge el JSON de un documento ya subido y lo entrega a la vista previa de importación. */
import type { SyncClient } from '@ikisai/sync-client';
import type { ImportDocument } from '@ikisai/domain-invoices';

export interface ExtractionResult {
  document: ImportDocument;
  document_sha256: string;
  warnings: string[];
  usage: unknown;
}

export async function extractDocument(client: SyncClient, fileIds: string[]): Promise<ExtractionResult> {
  return client.api<ExtractionResult>('/imports/extract', { json: { file_ids: fileIds } });
}

/** Cola de «Extraer pendientes»: facturas en `pendiente_datos` con documento, una tras otra. */
export const extractionQueue: { ids: string[]; total: number } = { ids: [], total: 0 };
