/**
 * Recompresión de fotos en el cliente (contrato §11.3): lado mayor 1600 px, WebP de calidad media, miniatura de 480 px,
 * sin conservar el original. La orientación EXIF se respeta al decodificar.
 */

export interface CompressImageOptions {
  /** Lado mayor de la imagen principal; por defecto 1600. */
  maxSide?: number;
  /** Lado mayor de la miniatura; por defecto 480. `0` desactiva la miniatura. */
  thumbSide?: number;
  /** Calidad WebP (0–1) de la principal y de la miniatura. */
  quality?: number;
  thumbQuality?: number;
  /** Tipo de salida; si el navegador no lo soporta se usa JPEG. */
  mime?: 'image/webp' | 'image/jpeg';
}

export interface CompressedImage {
  full: Blob;
  thumb: Blob | null;
  width: number;
  height: number;
  thumbWidth: number;
  thumbHeight: number;
  originalWidth: number;
  originalHeight: number;
  /** Tipo realmente producido (`image/webp` o `image/jpeg`). */
  mime: string;
  /** Nombre sugerido para el archivo principal (`foto.webp`). */
  filename: string;
}

const ACCEPTED = /^image\/(jpeg|png|webp|gif|bmp|avif|heic|heif)$/i;

export function isImageFile(file: Blob & { type: string }): boolean {
  return ACCEPTED.test(file.type);
}

function fit(width: number, height: number, maxSide: number): [number, number] {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

async function decode(file: Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* el formato no lo decodifica createImageBitmap (HEIC en algunos navegadores): probamos con <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('No se pudo leer la imagen.'));
      img.src = url;
    });
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function sizeOf(source: ImageBitmap | HTMLImageElement): [number, number] {
  return source instanceof HTMLImageElement ? [source.naturalWidth, source.naturalHeight] : [source.width, source.height];
}

async function draw(source: CanvasImageSource, width: number, height: number, mime: string, quality: number): Promise<Blob> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Sin contexto de dibujo.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, width, height);
    return canvas.convertToBlob({ type: mime, quality });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Sin contexto de dibujo.');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, width, height);
  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('No se pudo codificar la imagen.'))), mime, quality));
}

let webpSupported: boolean | null = null;
/** ¿Codifica el navegador WebP? Se comprueba una vez. */
export async function supportsWebp(): Promise<boolean> {
  if (webpSupported !== null) return webpSupported;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const url = canvas.toDataURL('image/webp');
    webpSupported = url.startsWith('data:image/webp');
  } catch {
    webpSupported = false;
  }
  return webpSupported;
}

/** Recomprime `file` y devuelve la imagen principal y su miniatura. Lanza si el archivo no es una imagen legible. */
export async function compressImage(file: Blob, options: CompressImageOptions = {}): Promise<CompressedImage> {
  const maxSide = options.maxSide ?? 1600;
  const thumbSide = options.thumbSide ?? 480;
  const quality = options.quality ?? 0.8;
  const thumbQuality = options.thumbQuality ?? 0.72;
  const mime = options.mime === 'image/jpeg' || !(await supportsWebp()) ? 'image/jpeg' : 'image/webp';
  const source = await decode(file);
  try {
    const [originalWidth, originalHeight] = sizeOf(source);
    if (!originalWidth || !originalHeight) throw new Error('La imagen está vacía.');
    const [width, height] = fit(originalWidth, originalHeight, maxSide);
    const full = await draw(source, width, height, mime, quality);
    let thumb: Blob | null = null;
    let [thumbWidth, thumbHeight] = [0, 0];
    if (thumbSide > 0) {
      [thumbWidth, thumbHeight] = fit(originalWidth, originalHeight, thumbSide);
      thumb = await draw(source, thumbWidth, thumbHeight, mime, thumbQuality);
    }
    return { full, thumb, width, height, thumbWidth, thumbHeight, originalWidth, originalHeight, mime, filename: mime === 'image/webp' ? 'foto.webp' : 'foto.jpg' };
  } finally {
    if ('close' in source && typeof source.close === 'function') source.close();
  }
}

/** Nombre de archivo para la foto recomprimida a partir del original (`IMG_1234.HEIC` → `IMG_1234.webp`). */
export function compressedFilename(original: string, mime: string): string {
  const base = original.replace(/\.[^.]+$/, '') || 'foto';
  return `${base}.${mime === 'image/webp' ? 'webp' : 'jpg'}`;
}
