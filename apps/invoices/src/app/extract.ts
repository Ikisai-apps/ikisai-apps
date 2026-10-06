/** Extracción automática (API.md §6, V2): pide a la Edge el JSON de un documento ya subido y lo entrega a la vista previa de importación. */
import type { SyncClient } from '@ikisai/sync-client';
import type { ImportDocument } from '@ikisai/domain-invoices';

/** Lo que costó una extracción, tal y como lo devuelve el helper de `_kit` (API.md §6). */
export interface ExtractionUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  latencyMs: number;
}

export interface ExtractionResult {
  document: ImportDocument;
  document_sha256: string;
  warnings: string[];
  usage: ExtractionUsage | null;
}

/** Línea discreta con lo que ha costado una extracción (modelo, tokens y tiempo), para que quien la pide vea lo que gasta. */
export function describeUsage(usage: ExtractionUsage | null | undefined): string | null {
  if (!usage || typeof usage !== 'object' || typeof usage.inputTokens !== 'number') return null;
  const n = (v: number) => new Intl.NumberFormat('es-ES').format(Math.round(v));
  const input = usage.inputTokens + (usage.cacheReadInputTokens ?? 0) + (usage.cacheCreationInputTokens ?? 0);
  const parts = [usage.model, `${n(input)} tokens de entrada`, `${n(usage.outputTokens)} de salida`];
  if (usage.latencyMs) parts.push(`${(usage.latencyMs / 1000).toFixed(1).replace('.', ',')} s`);
  return parts.join(' · ');
}

/** Motivos de `EXTRACTION_INVALID` que devuelve el helper de `_kit`, en palabras. */
export const EXTRACTION_ERROR_LABELS: Record<string, string> = {
  NO_JSON: 'la respuesta del modelo no traía ningún JSON',
  INVALID_JSON: 'el JSON devuelto no era válido',
  TRUNCATED: 'la respuesta se cortó antes de terminar el JSON',
  REFUSAL: 'el modelo no ha querido procesar este documento',
};

export function describeExtractionError(error: unknown): string {
  if (typeof error === 'string') return EXTRACTION_ERROR_LABELS[error] ?? error;
  const e = error as { path?: string; message?: string } | null;
  if (e && typeof e === 'object' && e.message) return e.path ? `${e.path}: ${e.message}` : e.message;
  return JSON.stringify(error);
}

export async function extractDocument(client: SyncClient, fileIds: string[]): Promise<ExtractionResult> {
  return client.api<ExtractionResult>('/imports/extract', { json: { file_ids: fileIds } });
}

/** Cola de «Extraer pendientes»: facturas en `pendiente_datos` con documento, una tras otra. */
export const extractionQueue: { ids: string[]; total: number } = { ids: [], total: 0 };
