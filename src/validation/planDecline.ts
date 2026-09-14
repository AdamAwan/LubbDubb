import type { Store } from '../store/store.js';
import type { CheckDecline, ValidationCheck } from '../types.js';
import { liveChecks } from './verdict.js';

// → docs/spec/20-validation.md#declining-a-single-row

interface ResolvedDecline {
  check: ValidationCheck;
  reason: string;
}

interface DeclineResolution {
  /** The rows the letters named, each with the operator's words. */
  resolved: ResolvedDecline[];
  /** Letters naming no live row. Never a refusal: the rest of the set still releases. */
  unknown: string[];
  /** Every live row was declined, so there is no set left to release. */
  whole: boolean;
}

/**
 * The operator's declines against the goal's own live rows, resolved by **letter** — the handle the
 * ask drew and the one thing about a check that is assigned once and never reused or reassigned
 * ([20](docs/spec/20-validation.md#the-letter-is-assigned-never-positional)). Resolving by letter is
 * what makes an amendment landing between the ask and the answer harmless: `C` is still the check
 * the operator read.
 *
 * A letter naming nothing is dropped rather than refused. The alternative is an accept that fails
 * whole because one row was superseded while the card was open — which costs the operator the four
 * rows they were happy with, the exact thing per-row decline exists to stop.
 */
export function resolveDeclines(
  checks: readonly ValidationCheck[],
  declines: readonly CheckDecline[],
): DeclineResolution {
  const live = liveChecks(checks);
  const byLetter = new Map(live.map((check) => [check.letter, check]));
  const resolved: ResolvedDecline[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const decline of declines) {
    const check = byLetter.get(decline.letter);
    if (check === undefined || seen.has(check.id)) {
      if (check === undefined) unknown.push(decline.letter);
      continue;
    }
    seen.add(check.id);
    resolved.push({ check, reason: decline.reason });
  }
  return { resolved, unknown, whole: live.length > 0 && resolved.length === live.length };
}

/**
 * Writes each decline as the row's one current reading, through the writer every other reading goes
 * through: it is the operator's verdict on that check, attributed to them and carrying their words,
 * and it clears the hand-back and the amendment band beside it exactly as a pass or a failure does.
 *
 * It touches neither `authored_at` nor `released_at`. A decline is not a refusal of the set — the
 * other rows release in the same press, and no planner is asked for the set again.
 */
export function applyDeclines(store: Store, originRef: string, resolved: readonly ResolvedDecline[]): string[] {
  const struck: string[] = [];
  for (const { check, reason } of resolved) {
    const written = store.validation.recordValidationResult(originRef, check.id, {
      state: 'declined',
      note: reason,
      by: 'operator',
    });
    if (written !== null) struck.push(written.letter);
  }
  return struck;
}

/**
 * What the audit line says about the rows struck out of an accepted set. Empty where nothing was
 * declined, so the ordinary accept reads exactly as it did.
 */
export function declineDetail(struck: readonly string[], unknown: readonly string[]): string {
  if (struck.length === 0 && unknown.length === 0) return '';
  const parts: string[] = [];
  if (struck.length > 0) parts.push(`you declined ${struck.join(', ')}`);
  if (unknown.length > 0) parts.push(`${unknown.join(', ')} named no live check and ${wasWere(unknown)} ignored`);
  return ` — ${parts.join('; ')}`;
}

function wasWere(letters: readonly string[]): string {
  return letters.length === 1 ? 'was' : 'were';
}

/**
 * The operator's own words, gathered into the note a whole-set decline is rejected with. Declining
 * every row is a rejection with the existing machinery, and the rejection's note is what reaches the
 * next planner through `rejectionGuidance` — so the reasons they wrote row by row have to travel
 * with it, or the planner re-deciding the set is told only that somebody said no.
 */
export function wholeSetNote(resolved: readonly ResolvedDecline[], note: string | undefined): string {
  const rows = resolved.map(({ check, reason }) => `${check.letter}. ${check.title} — ${reason}`);
  const said = note?.trim();
  return [...(said ? [said] : []), 'Every check in the set was declined:', ...rows].join('\n');
}
