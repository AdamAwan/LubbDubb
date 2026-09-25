import type { RemoteSheetRow, ValidationCheck } from '../../types.js';
import { stepArea, stepExpects } from '../steps.js';
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
 * A check may also have written down the **concrete spec names** it expects its area to run, and one
 * the listing does not offer blocks the row rather than letting it report on what remains. That is
 * the one failure the counts cannot reach: a deleted spec lowers the executed side and the listing's
 * own denominator together, so `executed < matched` never fires and only a name somebody wrote down
 * can be missed. A check that named none is unaffected — null is *no expectation*, never *expected
 * nothing*. → docs/spec/36-remote-validation.md#an-expected-spec-the-runner-does-not-offer
 *
 * Two rows are left exactly as they are. One already blocked keeps the reason it has — a kind this
 * environment does not permit is not a mismatch. And a check that **names no area** is a person's,
 * exactly as it is today: the pre-flight asks a runner about areas, and a check that declares none
 * was never a question for it.
 */
export function preflightRows(input: PreflightInput): PreflightVerdict[] {
  // Both come off the check's own `suite` step, here as everywhere: there is no column to consult
  // and nothing that could hold a second answer.
  const areas = new Map(input.checks.map((check) => [check.id, stepArea(check.steps)]));
  const expected = new Map(input.checks.map((check) => [check.id, stepExpects(check.steps)]));
  const out: PreflightVerdict[] = [];
  for (const row of input.rows) {
    if (row.kind !== 'check' || row.blockedReason !== null) continue;
    const area = areas.get(row.sourceId) ?? null;
    if (area === null) continue;
    if (input.listing.offers === null) {
      out.push({ rowId: row.rowId, matched: null, blockedReason: unlistable(input.environment, input.listing.detail) });
      continue;
    }
    const offers = new Set(input.listing.offers.map((o) => o.selector));
    const offer = input.listing.offers.find((o) => o.selector === area) ?? null;
    if (offer === null) {
      out.push({ rowId: row.rowId, matched: 0, blockedReason: unoffered(input.environment, area, input.listing) });
      continue;
    }
    if (offer.tests === 0) {
      out.push({ rowId: row.rowId, matched: 0, blockedReason: empty(input.environment, area) });
      continue;
    }
    // Only where the check named one: null is *no expectation was named*, and folding that into
    // "expected nothing" would block every check written before the column.
    const expects = expected.get(row.sourceId) ?? null;
    const missing = expects === null ? [] : expects.filter((name) => !offers.has(name));
    if (missing.length > 0) {
      out.push({
        rowId: row.rowId,
        matched: offer.tests,
        blockedReason: unexpected(input.environment, missing, input.listing),
      });
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

/**
 * A spec the check's author wrote down and the runner no longer offers. This is the one thing the
 * **matched** count cannot see: an area runs whatever it currently holds, so a deleted or renamed
 * spec lowers the executed side and the listed side together and `executed < matched` never fires.
 * Only a name somebody wrote down can be missed, and a row that reports on what remains reports a
 * pass for coverage that is gone — so it blocks rather than passing on the remainder.
 */
function unexpected(environment: string, missing: readonly string[], listing: SelectorListing): string {
  const offered = (listing.offers ?? []).map((o) => o.selector);
  return (
    `the runner on ${environment} offers no ${missing.length === 1 ? 'spec' : 'specs'} ` +
    `${missing.map((s) => `\`${s}\``).join(', ')} — this check expected ${missing.length === 1 ? 'it' : 'them'} ` +
    `and a deleted or renamed spec lowers what the listing counts with it, so nothing else here would have ` +
    `said so. It offers ${offered.length === 0 ? 'nothing at all' : offered.map((s) => `\`${s}\``).join(', ')}. ` +
    'Nothing here was run, because a pass on what remains is a pass for coverage that is gone.'
  );
}

function empty(environment: string, area: string): string {
  return (
    `the runner on ${environment} offers \`${area}\` and it holds no tests. A selector that matched zero ` +
    'tests is never a pass — amend the check, or add the coverage it names.'
  );
}
