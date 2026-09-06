import { renderReviewPackCompanion, reviewPackCompanionPath } from '../reviewPacks/companion.js';
import type { PoolDocument } from '../types.js';
import { poolMarkdownPath, renderPoolMarkdown } from './markdown.js';

// → docs/spec/28-cross-fleet-pool.md

export function poolCompanion(document: PoolDocument): { path: string; text: string } {
  if (document.kind === 'pack') {
    return {
      path: reviewPackCompanionPath(document.fleetId, document.prNumber),
      text: renderReviewPackCompanion({ pack: document.pack, writtenAt: document.writtenAt }),
    };
  }
  return { path: poolMarkdownPath(document.fleetId, document.kind), text: renderPoolMarkdown(document) };
}
