const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
const GIF87A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x37, 0x61];
const GIF89A_SIGNATURE = [0x47, 0x49, 0x46, 0x38, 0x39, 0x61];
const RIFF_SIGNATURE = [0x52, 0x49, 0x46, 0x46];
const WEBP_SIGNATURE = [0x57, 0x45, 0x42, 0x50];

export type ImageType = {
  mimeType: string;
  extension: string;
};

const IMAGE_TYPES: Array<{ signature: number[]; type: ImageType }> = [
  {
    signature: PNG_SIGNATURE,
    type: { mimeType: 'image/png', extension: 'png' },
  },
  {
    signature: JPEG_SIGNATURE,
    type: { mimeType: 'image/jpeg', extension: 'jpg' },
  },
  {
    signature: GIF87A_SIGNATURE,
    type: { mimeType: 'image/gif', extension: 'gif' },
  },
  {
    signature: GIF89A_SIGNATURE,
    type: { mimeType: 'image/gif', extension: 'gif' },
  },
];

function matches(data: Uint8Array, signature: number[], offset = 0): boolean {
  if (data.length < offset + signature.length) return false;
  return signature.every((byte, index) => data[offset + index] === byte);
}

export function detectImageType(data: Uint8Array): ImageType | undefined {
  for (const candidate of IMAGE_TYPES) {
    if (matches(data, candidate.signature)) return candidate.type;
  }

  if (matches(data, RIFF_SIGNATURE) && matches(data, WEBP_SIGNATURE, 8)) {
    return { mimeType: 'image/webp', extension: 'webp' };
  }

  return undefined;
}

export function sanitizeFilename(
  value: string | undefined,
  extension: string,
): string {
  const base =
    typeof value === 'string'
      ? (value.replaceAll('\\', '/').split('/').pop() ?? '')
      : '';
  const cleaned = [...base]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code > 0x1f && code !== 0x7f;
    })
    .join('')
    .trim()
    .slice(0, 120);
  return cleaned.length > 0 ? cleaned : `image.${extension}`;
}
