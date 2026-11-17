import type { ImageUpload } from '../../shared/types';

/**
 * Models downscale images to ~1568 px on the long side anyway, so shrinking first costs no detail
 * the agent could use. It also keeps big 4K screenshots under the API's per-image size limit.
 */
const MAX_SIDE = 1568;
const KEEP_AS_IS = 3 * 1024 * 1024;
const OK_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const readAsDataURL = (blob: Blob) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

export async function toUpload(file: File): Promise<ImageUpload & { preview: string }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  let data: string;
  if (scale === 1 && file.size <= KEEP_AS_IS && OK_TYPES.includes(file.type)) {
    data = await readAsDataURL(file);
  } else {
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    data = canvas.toDataURL('image/png');
    // Photos compress badly as PNG: fall back to JPEG when the PNG is still large.
    if (data.length > 4 * 1024 * 1024) data = canvas.toDataURL('image/jpeg', 0.88);
  }
  bmp.close();
  return { name: file.name || 'pasted.png', data, preview: data };
}

/** Image files from a paste or drop event (screenshots arrive as clipboard items, not named files). */
export function imageFiles(list: DataTransfer | null): File[] {
  if (!list) return [];
  const fromItems = [...(list.items ?? [])].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()!).filter(Boolean);
  return fromItems.length ? fromItems : [...(list.files ?? [])].filter((f) => f.type.startsWith('image/'));
}

export const attachmentURL = (officeId: string, name: string, dir: 'attachments' | 'evidence' = 'attachments') =>
  `/api/attachment?office=${encodeURIComponent(officeId)}&dir=${dir}&name=${encodeURIComponent(name)}`;
