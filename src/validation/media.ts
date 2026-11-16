import type { ValidationMediaKind } from '../types.js';

// → docs/spec/32-local-validation.md#the-cockpit, 36-remote-validation.md#the-runs-recording

const IMAGE = /\.(png|jpe?g|gif|webp|avif)$/i;
const VIDEO = /\.(webm|mp4)$/i;

export function mediaKind(name: string): ValidationMediaKind | null {
  if (IMAGE.test(name)) return 'image';
  if (VIDEO.test(name)) return 'video';
  return null;
}
