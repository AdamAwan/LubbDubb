import { partAtoms } from '../plans/parts.js';
import type { PlanAtom, PlanPart } from '../types.js';

// → docs/spec/31-review-packs.md#an-idea-names-the-atom-it-corresponds-to

/**
 * The atoms behind a pull request: the ones carried by the plan part that owns it.
 *
 * A pack is keyed on a pull request and an atom hangs off a part, so this is the
 * whole of the join. Every pull request with no part behind it — human-authored, a
 * job, a pickup with no plan — answers with an empty list, which is what makes its
 * pack the pack it got before atoms existed.
 * → docs/spec/31-review-packs.md#the-atoms-behind-a-pull-request
 */
export function atomsForPr(prNumber: number, parts: readonly PlanPart[], planAtoms: readonly PlanAtom[]): PlanAtom[] {
  const part = parts.find((p) => p.prNumber === prNumber);
  if (part === undefined) return [];
  return partAtoms(
    part,
    planAtoms.filter((a) => a.planId === part.planId),
  );
}

/**
 * What the author is told about the atoms, appended to its rendered prompt.
 *
 * Empty for a pull request with no atoms behind it, so the prompt is byte-for-byte
 * the one it was before atoms existed.
 * → docs/spec/31-review-packs.md#what-the-author-is-told
 */
export function atomList(atoms: readonly PlanAtom[]): string {
  if (atoms.length === 0) return '';
  const declared = atoms.map(atomBlock).join('\n');
  return [
    '## The atoms this pull request was planned as',
    '',
    'Its planner declared these before any of it was written. An atom is the smallest piece of the change that ' +
      'could land, be reviewed and be rolled back on its own, which is the same unit an idea is — so **give each ' +
      "idea the slug of the atom it corresponds to**, as the idea's `atom`.",
    '',
    declared,
    '',
    '**Where no atom fits, write `atom: null`, and that is the right answer rather than a failure.** It says the ' +
      'work went somewhere the plan did not declare, which is the most useful thing this pack can tell a reviewer, ' +
      'and nothing is refused for it. Do not stretch an idea to reach the nearest slug: a label that is nearly ' +
      'true costs the reader more than an honest gap. The slug must be one of the ones above or null — a slug ' +
      'that is not in the list is refused as the typo it is.',
    '',
    '**A route the planner rejected is never a claim.** It is an intention, and the honest verdict on an ' +
      'intention is `cant_tell`; the plan is also the most authoritative-looking thing you have been handed, so a ' +
      'rejection restated as a claim reads as checked when nothing checked it. Use them to understand why an atom ' +
      'is written the way it is, and let the atom slug carry them.',
  ].join('\n');
}

function atomBlock(atom: PlanAtom): string {
  const lines = [`- \`${atom.slug}\` — ${atom.title}\n  why: ${atom.intent}`];
  if (atom.touches.length > 0) lines.push(`  paths: ${atom.touches.join(', ')}`);
  if (atom.acceptance !== null) lines.push(`  done when: ${atom.acceptance}`);
  for (const rejected of atom.rejected) lines.push(`  rejected: ${rejected.route} — ${rejected.because}`);
  return lines.join('\n');
}
