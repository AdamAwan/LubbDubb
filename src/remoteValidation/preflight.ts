import type { RemoteSheetRow, ValidationCheck } from '../types.js';
import type { SelectorListing } from './runner.js';

// → docs/spec/36-remote-validation.md#when-a-sheet-is-assembled-and-what-runs-without-asking

/** What the pre-flight learned about one `check` row, before any press has been spent on it. */
interface PreflightVerdict {
  rowId: string;
  /** How many tests the listing attributes to this row's area. Null where it did not count them. */
  matched: number | null;
  /** Why nothing can be learned here, in words. Null where the runner offers what the row names. */
  blockedReason: string | null;
}

interface PreflightInput {
  environment: string;
  rows: readonly Pick<RemoteSheetRow, 'rowId' | 'kind' | 'sourceId' | 'blockedReason'>[];
  checks: readonly ValidationCheck[];
  listing: SelectorListing;
}

/**
 * The deployed runner has been asked which selectors it actually offers; this is that listing read
 * against what the sheet's `check` rows name.
 *
 * A selector is a compatibility surface between a harness-held check and a runner config in a
 * repository that moves, and a mismatch is one of this design's own `blocked` causes — so it is
 * settled **before** the consent rather than afterwards as a blocked row that wasted a press. The
 * **matched** count is written from the listing and from nowhere else: derived from a post-run
 * report instead, a selector that matched nothing reads as a clean pass.
 *
 * Two rows are left exactly as they are. One already blocked keeps the reason it has — a kind this
 * environment does not permit is not a mismatch. And a check that **names no area** is a person's,
 * exactly as it is today: the pre-flight asks a runner about areas, and a check that declares none
 * was never a question for it.
 */
export function preflightRows(input: PreflightInput): PreflightVerdict[] {
  const areas = new Map(input.checks.map((check) => [check.id, check.area]));
  const out: PreflightVerdict[] = [];
  for (const row of input.rows) {
    if (row.kind !== 'check' || row.blockedReason !== null) continue;
    const area = areas.get(row.sourceId) ?? null;
    if (area === null) continue;
    if (input.listing.offers === null) {
      out.push({ rowId: row.rowId, matched: null, blockedReason: unlistable(input.environment, input.listing.detail) });
      continue;
    }
    const offer = input.listing.offers.find((o) => o.selector === area) ?? null;
    if (offer === null) {
      out.push({ rowId: row.rowId, matched: 0, blockedReason: unoffered(input.environment, area, input.listing) });
      continue;
    }
    if (offer.tests === 0) {
      out.push({ rowId: row.rowId, matched: 0, blockedReason: empty(input.environment, area) });
      continue;
    }
    out.push({ rowId: row.rowId, matched: offer.tests, blockedReason: null });
  }
  return out;
}

/**
 * A listing that could not answer blocks the rows it was asked about and **nothing else**: `blocked`
 * resolves per row and never per run, so a sheet's already-landed `state`, `signal` and `measure`
 * readings stand untouched beside it.
 */
function unlistable(environment: string, detail: string | null): string {
  return (
    `the runner on ${environment} could not say which selectors it offers — ${detail ?? 'it answered nothing'}. ` +
    'Nothing was learned about whether this check can be run here, and an unanswered listing is never ' +
    'read as a runner that offers nothing.'
  );
}

function unoffered(environment: string, area: string, listing: SelectorListing): string {
  const offered = (listing.offers ?? []).map((o) => o.selector);
  return (
    `the runner on ${environment} offers no selector \`${area}\` — a renamed area, a deleted spec or a wrong ` +
    `profile. It offers ${offered.length === 0 ? 'nothing at all' : offered.map((s) => `\`${s}\``).join(', ')}. ` +
    'Nothing here was run, because a selector that matches nothing is never a pass.'
  );
}

function empty(environment: string, area: string): string {
  return (
    `the runner on ${environment} offers \`${area}\` and it holds no tests. A selector that matched zero ` +
    'tests is never a pass — amend the check, or add the coverage it names.'
  );
}
