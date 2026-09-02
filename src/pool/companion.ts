import { renderReviewPackCompanion, reviewPackCompanionPath } from '../reviewPacks/companion.js';
import type { PoolDocument } from '../types.js';
import { poolMarkdownPath, renderPoolMarkdown } from './markdown.js';

/**
 * The companion a document is published with: markdown for the two clock
 * documents, HTML for a shared review pack.
 *
 * One function rather than a branch in each transport, because the property that
 * matters is a property of the pair — **every document goes out with a companion,
 * written and committed together, and no companion is ever read back.** A
 * transport that decided for itself would be a transport that could publish one
 * without the other, which is a pool whose wiki is right for some documents and
 * stale for others.
 *
 * → `docs/spec/28-cross-fleet-pool.md#the-human-readable-companion`,
 *   `docs/spec/31-review-packs.md#reading-it`
 */
export function poolCompanion(document: PoolDocument): { path: string; text: string } {
  if (document.kind === 'pack') {
    return {
      path: reviewPackCompanionPath(document.fleetId, document.prNumber),
      text: renderReviewPackCompanion({ pack: document.pack, writtenAt: document.writtenAt }),
    };
  }
  return { path: poolMarkdownPath(document.fleetId, document.kind), text: renderPoolMarkdown(document) };
}
