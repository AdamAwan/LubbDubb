import type { ValidationCheck, ValidationVerdict } from '../types.js';

// → docs/spec/20-validation.md

export function validationVerdict(checks: readonly ValidationCheck[]): ValidationVerdict {
  const live = liveChecks(checks);
  const count = (state: ValidationCheck['state']): number => live.filter((c) => c.state === state).length;
  const passed = count('passed');
  const waived = count('waived');
  return {
    state: passed + waived === live.length ? 'clear' : 'flagged',
    total: live.length,
    passed,
    failed: count('failed'),
    unrun: count('unrun'),
    deferred: count('deferred'),
    waived,
  };
}

export function liveChecks(checks: readonly ValidationCheck[]): ValidationCheck[] {
  return checks.filter((c) => c.supersededReason === null);
}

export function outstandingChecks(checks: readonly ValidationCheck[]): string[] {
  return liveChecks(checks)
    .filter((c) => c.state !== 'passed' && c.state !== 'waived')
    .map((c) => {
      const why = c.resultNote === null ? '' : ` — ${c.resultNote}`;
      return `${c.letter}. **${c.title}** — ${c.state}${why}${amendmentCost(c)}${whoOwesIt(c)}`;
    });
}

function whoOwesIt(check: ValidationCheck): string {
  if (check.actor === 'fleet') return ' (handed to the fleet)';
  if (check.handbackNote !== null) return ` (handed back — ${check.handbackNote})`;
  return '';
}

function amendmentCost(check: ValidationCheck): string {
  const withdrawn = check.revision?.state;
  return withdrawn == null ? '' : ` (amended since you recorded **${withdrawn}** — the wording changed)`;
}
