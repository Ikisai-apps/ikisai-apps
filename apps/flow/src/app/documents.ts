import type { SyncClient } from '@ikisai/sync-client';
import { TABLES } from '@ikisai/domain-flow';
import type { Project } from './data.ts';

/**
 * Documentos y portada de un flujo (orden de VG del 27-10, migración 0907): archivos del proyecto en `core.files`
 * (bucket `flow-media`), que el owner sube, ordena y quita. Las URL son firmadas y caducan: se piden al enseñarlas y se
 * guardan unos minutos. La v1 congelada sigue con las guías del código mientras no tenga documentos propios.
 */
export interface ProjectDocument {
  id: string;
  title: string;
  /** Miniatura (para una imagen subida, la propia imagen). */
  thumb: string;
  /** Tamaño completo. */
  full: string;
  /** Fila de flow.project_documents (null en las guías del código). */
  rowId: string | null;
  isPdf: boolean;
}

interface DocRow { id: string; revision: number; project_id: string; file_id: string; title: string; mime: string | null; position: number; deleted_at: string | null }

const BAR_V1 = '0f10a000-0000-4000-8000-000000000001';

/** Las cuatro guías que venían en el código (semilla: «Cargar las guías de la barra»). */
export const CODE_GUIDES: Array<{ slug: string; title: string }> = [
  { slug: 'montaditos', title: 'Montaditos · montaje y estaciones' },
  { slug: 'barra', title: 'Barra · bebidas y extras' },
  { slug: 'frigorifico', title: 'Frigorífico · almacenamiento y frío' },
  { slug: 'mesa', title: 'Mesa de trabajo · disposición y orden' },
];
const codeGuides = (): ProjectDocument[] => CODE_GUIDES.map((g) => ({ id: g.slug, title: g.title, thumb: `/guias/${g.slug}-mini.webp`, full: `/guias/${g.slug}.webp`, rowId: null, isPdf: false }));

const urlCache = new Map<string, { url: string; at: number }>();
/** URL firmada de un archivo, con caché de 8 minutos (caducan a los 10). */
export async function fileUrl(client: SyncClient, fileId: string): Promise<string | null> {
  const hit = urlCache.get(fileId);
  if (hit && Date.now() - hit.at < 8 * 60_000) return hit.url;
  try {
    const url = await client.fileUrl(fileId);
    urlCache.set(fileId, { url, at: Date.now() });
    return url;
  } catch { return null; }
}

export async function documentRows(client: SyncClient, projectId: string): Promise<DocRow[]> {
  return ((await client.list(TABLES.projectDocuments)) as unknown as DocRow[])
    .filter((d) => d.project_id === projectId && !d.deleted_at).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
}

export async function projectDocuments(client: SyncClient, projectId: string | null): Promise<ProjectDocument[]> {
  if (!projectId) return [];
  const rows = await documentRows(client, projectId);
  if (!rows.length) return projectId === BAR_V1 ? codeGuides() : [];
  return Promise.all(rows.map(async (r) => {
    const url = (await fileUrl(client, r.file_id)) ?? '';
    const isPdf = r.mime === 'application/pdf';
    return { id: r.id, title: r.title, thumb: isPdf ? '' : url, full: url, rowId: r.id, isPdf };
  }));
}

/** Portada: la subida, o la del código. */
export async function coverUrl(client: SyncClient, project: Project): Promise<string | null> {
  if (project.cover_file_id) return (await fileUrl(client, project.cover_file_id)) ?? project.cover_image;
  return project.cover_image;
}

/** Sube un archivo y crea su documento al final (owner). */
export async function addDocument(client: SyncClient, projectId: string, file: Blob, title: string, filename: string): Promise<void> {
  const rows = await documentRows(client, projectId);
  const sha = await client.stageBlob(file, { filename, mime: file.type || 'application/octet-stream' });
  await client.commit([{ op: 'insert', table: TABLES.projectDocuments, id: crypto.randomUUID(),
    fields: { project_id: projectId, title, mime: file.type || null, position: (rows.at(-1)?.position ?? 0) + 1, file_id: { $blob: sha } } as never }]);
}

/** «Cargar las guías de la barra»: sube las del código como documentos del flujo (una vez). */
export async function loadCodeGuides(client: SyncClient, projectId: string): Promise<number> {
  if ((await documentRows(client, projectId)).length) return 0;
  let n = 0;
  for (const g of CODE_GUIDES) {
    const res = await fetch(`/guias/${g.slug}.webp`);
    if (!res.ok) continue;
    await addDocument(client, projectId, await res.blob(), g.title, `${g.slug}.webp`);
    n++;
  }
  return n;
}

/** Cambia el orden (sube o baja una posición) o quita un documento (owner). */
export async function moveDocument(client: SyncClient, projectId: string, rowId: string, delta: -1 | 1): Promise<void> {
  const rows = await documentRows(client, projectId);
  const i = rows.findIndex((r) => r.id === rowId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= rows.length) return;
  const a = rows[i]!, b = rows[j]!;
  await client.commit([
    { op: 'update', table: TABLES.projectDocuments, id: a.id, expectedRevision: a.revision, fields: { position: b.position === a.position ? a.position + delta : b.position } },
    { op: 'update', table: TABLES.projectDocuments, id: b.id, expectedRevision: b.revision, fields: { position: a.position } },
  ]);
}

export async function removeDocument(client: SyncClient, projectId: string, rowId: string): Promise<void> {
  const row = (await documentRows(client, projectId)).find((r) => r.id === rowId);
  if (row) await client.commit([{ op: 'delete', table: TABLES.projectDocuments, id: row.id, expectedRevision: row.revision }]);
}

export async function setCover(client: SyncClient, project: Project, file: Blob, filename: string): Promise<void> {
  const sha = await client.stageBlob(file, { filename, mime: file.type || 'image/webp' });
  await client.commit([{ op: 'update', table: TABLES.projects, id: project.id, expectedRevision: project.revision, fields: { cover_file_id: { $blob: sha } } as never }]);
}
