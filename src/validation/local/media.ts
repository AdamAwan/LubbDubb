import type { LocalValidationMediaKind } from '../../types.js';

// → docs/spec/32-local-validation.md#the-cockpit

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const VIDEO = /\.(webm|mp4)$/i;

export function mediaKind(name: string): LocalValidationMediaKind | null {
  if (IMAGE.test(name)) return 'image';
  if (VIDEO.test(name)) return 'video';
  return null;
}
