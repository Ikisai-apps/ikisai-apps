/**
 * Documentos de factura (API.md §8): PDF tal cual; fotos recomprimidas en el cliente a «resolución WhatsApp»
 * (lado mayor 1600 px, WebP de calidad media) sin conservar el original. El blob se deja en la cola del sync-client
 * y la operación lo referencia con el marcador `{ "$blob": sha256 }`.
 */
import type { SyncClient } from '@ikisai/sync-client';

export const PHOTO_MAX_SIDE = 1600;
export const PHOTO_QUALITY = 0.72;
export const ACCEPTED_MIME = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];
export const ACCEPT_ATTR = 'application/pdf,image/*';

export interface StagedDocument {
  sha256: string;
  filename: string;
  mime: string;
  size: number;
  /** Marcador para `file_id` en la operación. */
  marker: { $blob: string };
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function loadImage(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen.')); };
    img.src = url;
  });
}

/** Recomprime una foto: lado mayor 1600 px, WebP calidad media. Si el navegador no sabe producir WebP, JPEG. */
export async function compressPhoto(file: Blob): Promise<{ blob: Blob; mime: string }> {
  const img = await loadImage(file);
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('El navegador no permite procesar imágenes.');
  ctx.drawImage(img, 0, 0, width, height);
  const toBlob = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, PHOTO_QUALITY));
  let blob = await toBlob('image/webp');
  let mime = 'image/webp';
  if (!blob || blob.type !== 'image/webp') {
    blob = await toBlob('image/jpeg');
    mime = 'image/jpeg';
  }
  if (!blob) throw new Error('No se pudo comprimir la foto.');
  return { blob, mime };
}

function baseName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, '');
}

/** Prepara un archivo elegido por el usuario y lo deja en la cola de subida. */
export async function stageDocument(client: SyncClient, file: File): Promise<StagedDocument> {
  let blob: Blob = file;
  let mime = file.type || 'application/octet-stream';
  let filename = file.name || 'documento';
  if (mime.startsWith('image/')) {
    const out = await compressPhoto(file);
    blob = out.blob;
    mime = out.mime;
    filename = `${baseName(filename)}.${mime === 'image/webp' ? 'webp' : 'jpg'}`;
  } else if (mime !== 'application/pdf') {
    throw new Error('Solo se admiten PDF e imágenes.');
  }
  const sha256 = await client.stageBlob(blob, { filename, mime });
  return { sha256, filename, mime, size: blob.size, marker: { $blob: sha256 } };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Abre un documento con una URL firmada de corta duración. */
export async function openFile(client: SyncClient, fileId: string): Promise<void> {
  const url = await client.fileUrl(fileId);
  window.open(url, '_blank', 'noopener');
}

/** Descarga con sesión (rutas que devuelven binarios, como el ZIP de la gestoría). */
export async function downloadWithSession(client: SyncClient, path: string, filename: string): Promise<void> {
  const session = client.session();
  if (!session) throw new Error('Sesión no iniciada.');
  const response = await fetch(`/api/v1${path}`, { headers: { Authorization: `Bearer ${session.token}` } });
  if (!response.ok) {
    let error: unknown = { code: 'HTTP_' + response.status, message: 'No se pudo descargar.' };
    try { error = (await response.json()).error ?? error; } catch { /* sin cuerpo */ }
    throw error;
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
