import { createHash } from 'node:crypto';
import type { PoolClockDocument, PoolClockKind, PoolDigestDocument, PoolDocument } from '../types.js';

/**
 * The schema version, **on the envelope and never inside the body**.
 *
 * A document written by a newer harness is skipped *per document*, recorded, and
 * drawn on the page as a fleet that is ahead of you. A version inside the body
 * fails the whole fetch and takes every other fleet's contribution down with it —
 * one early adopter silently emptying the pool for everybody.
 *
 * It lives here rather than beside {@link PoolEnvelope} in `src/types.ts` because
 * that module must survive type erasure whole: the cockpit type-imports it, and
 * anything left standing there becomes server code in the SPA bundle
 * (`test/wireContract.test.ts`).
 */
export const POOL_SCHEMA_VERSION = 1;

/**
 * The clock kinds a fetch names, and the only kinds it will parse.
 *
 * A list rather than the literal at the call site because a **retired** kind must
 * leave both at once. `claims` did not: the arm went, `PoolClockKind` narrowed to
 * `digest`, and the git transport went on naming `claims.json` in every fleet's
 * directory — so every pool that had ever run the old build fetched its own stale
 * file and recorded `unknown document kind "claims"` on every pulse, forever.
 * → `docs/spec/28-cross-fleet-pool.md#one-writer-per-namespace`
 */
export const POOL_CLOCK_KINDS: readonly PoolClockKind[] = ['digest'];

/**
 * The clock kinds that once existed here, and the files a fleet must clear out of
 * its **own** namespace.
 *
 * A retired kind's document is not merely unread: it stays in the pool repository,
 * and its companion stays in the wiki as a page about an arm that is gone. Nobody
 * else can remove it — one writer per namespace cuts both ways — so each fleet
 * clears its own, on the next publish, and a pool heals as its fleets upgrade.
 *
 * A kind is added here when it leaves {@link POOL_CLOCK_KINDS} and never removed
 * from it afterwards: the deployment that has not published since the retirement is
 * exactly the one still holding the file.
 * → `docs/spec/28-cross-fleet-pool.md#what-a-retired-kind-leaves-behind`
 */
const POOL_RETIRED_CLOCK_KINDS: readonly string[] = ['claims'];

/** Both files a retired kind left in one fleet's namespace: the document and its companion. */
export function poolRetiredPaths(fleetId: string): string[] {
  return POOL_RETIRED_CLOCK_KINDS.flatMap((kind) => [`fleets/${fleetId}/${kind}.json`, `fleets/${fleetId}/${kind}.md`]);
}

/**
 * The pool's payload layer: what a document is, how one is read back, and what
 * makes two of them the same document.
 *
 * **The payload is opaque to the transport.** Versioned JSON — the transport moves
 * bytes, this understands claims and digests. A text-only substrate that stores a
 * document in a fenced code block is first-class, and nothing here knows or cares
 * where the bytes came to rest.
 *
 * → `docs/spec/28-cross-fleet-pool.md#two-documents-one-envelope`
 */

/** How a document is serialised for the wire. Stable key order, so the hash below means something. */
export function serialisePoolDocument(document: PoolDocument): string {
  return `${JSON.stringify(document, stableKeys(document), 2)}\n`;
}

/**
 * What makes two derivations of a document the same document — **the truth the
 * dirty flag is only a hint about.**
 *
 * `publishedAt` is deliberately excluded: it moves every time the document is
 * re-derived, so a hash over it would say "changed" on every backstop pass and an
 * idle fleet would commit an identical file twenty-four times a day. What is left
 * is exactly the content, which is what the comparison is for.
 */
export function poolContentHash(document: PoolDocument): string {
  const { publishedAt: _publishedAt, ...content } = document;
  return createHash('sha256')
    .update(JSON.stringify(content, stableKeys(content)))
    .digest('hex');
}

/**
 * A parsed document, or why it was skipped.
 *
 * Three refusals, and each is **per document** rather than per fetch. A version
 * inside the body would fail the whole read and take every other fleet's
 * contribution down with it — one early adopter silently emptying the pool for
 * everybody — so the version is on the envelope and a document that is ahead is
 * skipped, recorded, and drawn on the page as a fleet that is ahead of you.
 */
type PoolParse =
  | { ok: true; document: PoolClockDocument }
  | { ok: false; reason: 'ahead'; version: number; fleetId: string | null }
  | { ok: false; reason: 'malformed' | 'mismatched-fleet'; detail: string };

/**
 * Read one document back.
 *
 * `expectFleetId` is the address the transport found it at, when the substrate has
 * one. **`fleetId` is in the body as well as in the address, and a mismatch
 * discards the document**: the address is the transport's and a text substrate may
 * have none that survives a round trip, and a fleet publishing under another
 * fleet's name is the single thing that can break one writer per namespace. So it
 * is checked rather than assumed.
 */
export function parsePoolDocument(text: string, expectFleetId?: string): PoolParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, reason: 'malformed', detail: (error as Error).message };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: 'malformed', detail: 'a pool document must be a JSON object' };
  }
  const raw = parsed as Record<string, unknown>;
  const version = typeof raw.pool === 'number' ? raw.pool : null;
  if (version === null) return { ok: false, reason: 'malformed', detail: 'no "pool" schema version on the envelope' };
  const fleetId = typeof raw.fleetId === 'string' ? raw.fleetId : null;
  // Ahead is judged **before** the body is read, which is the whole point of the
  // version living on the envelope: a newer harness may have written a body this
  // build has no grammar for, and reading it would be guessing.
  if (version > POOL_SCHEMA_VERSION) return { ok: false, reason: 'ahead', version, fleetId };
  const kind = raw.kind;
  // The one clock document and nothing else. A shared review pack is a second kind
  // and lives under `packs/`, which `fetch` never names — it is published for a
  // person to read and is never polled, corroborated or landed
  // (`docs/spec/31-review-packs.md#sharing-a-pack`), so arriving here it is as
  // unreadable as any other stranger's file, and said so per document.
  if (kind !== 'digest') {
    return { ok: false, reason: 'malformed', detail: `unknown document kind ${JSON.stringify(kind)}` };
  }
  if (fleetId === null) return { ok: false, reason: 'malformed', detail: 'no "fleetId" in the body' };
  if (expectFleetId !== undefined && expectFleetId !== fleetId) {
    return {
      ok: false,
      reason: 'mismatched-fleet',
      detail: `a document addressed to ${expectFleetId} names ${fleetId} in its body`,
    };
  }
  if (typeof raw.project !== 'string' || raw.project === '') {
    return { ok: false, reason: 'malformed', detail: 'no "project" in the body' };
  }
  if (typeof raw.publishedAt !== 'string') {
    return { ok: false, reason: 'malformed', detail: 'no "publishedAt" in the body' };
  }
  return readDigest(raw);
}

function readDigest(raw: Record<string, unknown>): PoolParse {
  const document: PoolDigestDocument = {
    ...(raw as unknown as PoolDigestDocument),
    kind: 'digest',
    byPhase: readRows(raw.byPhase),
    byCause: readRows(raw.byCause),
    byCheck: readRows(raw.byCheck),
    unaccounted: readRows(raw.unaccounted),
    unmeasured: readRows(raw.unmeasured),
    // Read like every other section even though nothing consumes it: a document
    // from a build that predates the section answers `[]` here, which is what keeps
    // adding one a backward-compatible change rather than a version bump.
    byFault: readRows(raw.byFault),
  };
  return { ok: true, document };
}

function readRows(raw: unknown): PoolDigestDocument['byPhase'] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isRecord).flatMap((row) => {
    if (typeof row.day !== 'string' || typeof row.key !== 'string') return [];
    return [
      {
        day: row.day,
        key: row.key,
        count: countOf(row.count),
        // Null is a real answer here and never folded to zero: a window in which
        // nothing was measured answers null, and `$0.00` would be a claim that the
        // fleet worked for free.
        costUsd: typeof row.costUsd === 'number' && Number.isFinite(row.costUsd) ? row.costUsd : null,
        partial: row.partial === true,
      },
    ];
  });
}

function countOf(raw: unknown): number {
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The keys, sorted, so `JSON.stringify` writes them in a stable order.
 *
 * Load-bearing for {@link poolContentHash} rather than cosmetic: object key order
 * in JavaScript follows insertion, so a document built by two code paths that
 * assigned the same fields in different orders would hash differently and publish
 * an identical file every hour forever.
 */
function stableKeys(value: object): string[] {
  const keys = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return void node.forEach(walk);
    if (isRecord(node)) {
      for (const key of Object.keys(node)) {
        keys.add(key);
        walk(node[key]);
      }
    }
  };
  walk(value);
  return [...keys].sort();
}

/** Where one fleet's document of a clock kind lives, relative to the pool's own prefix. */
export function poolDocumentPath(fleetId: string, kind: PoolClockKind): string {
  return `fleets/${fleetId}/${kind}.json`;
}

/**
 * Where one shared review pack lives: **in the fleet's own namespace**, beside
 * `digest.json`, under a directory of its own because there is
 * one per pull request rather than one per fleet. `fetch` names the two clock
 * document by name and never walks, so nothing polls these.
 * → `docs/spec/31-review-packs.md#sharing-a-pack`
 */
export function poolPackPath(fleetId: string, prNumber: number): string {
  return `fleets/${fleetId}/packs/pr-${prNumber}.json`;
}

/** One document's address, whichever kind it is — the only place that decides. */
export function poolDocumentAddress(document: PoolDocument): string {
  return document.kind === 'pack'
    ? poolPackPath(document.fleetId, document.prNumber)
    : poolDocumentPath(document.fleetId, document.kind);
}
