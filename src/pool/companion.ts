import type { PoolDocument } from '../types.js';
import { poolMarkdownPath, renderPoolMarkdown } from './markdown.js';

// → docs/spec/28-cross-fleet-pool.md

export function poolCompanion(document: PoolDocument): { path: string; text: string } {
  return { path: poolMarkdownPath(document.fleetId, document.kind), text: renderPoolMarkdown(document) };
}
