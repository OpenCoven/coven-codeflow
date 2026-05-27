export function detectImageMediaType(raw) {
  if (raw.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (raw[0] === 0xff && raw[1] === 0xd8 && raw[2] === 0xff) return 'image/jpeg';
  const header = raw.subarray(0, 12).toString('ascii');
  if (header.startsWith('GIF87a') || header.startsWith('GIF89a')) return 'image/gif';
  if (header.startsWith('RIFF') && header.slice(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

export function imageMediaTypeExtension(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg';
  return mediaType.split('/').at(-1) || 'img';
}
