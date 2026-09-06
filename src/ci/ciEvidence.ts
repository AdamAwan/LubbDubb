/**
 * The failing output of a red CI check, fetched at dispatch and appended to the
 * agent's prompt, so the agent reads the assertion instead of reproducing the
 * failure. Structured errors (GitHub check-run annotations, Azure timeline
 * `issues[]`) are preferred over a raw log tail; the budget is per prompt, not
 * per check, and whatever the cap drops is always named rather than silently cut.
 * → `docs/spec/05-dispatcher.md#what-a-ci-fix-dispatch-carries`,
 *   `docs/spec/15-integrations.md`
 */

/** One failing check's evidence, as the provider was able to supply it. */
export interface CiFailureEvidence {
  /** The check name, matching {@link CiCheck.name} — what the agent sees it called. */
  check: string;
  /** Which source this came from; changes how the excerpt is trimmed and labelled. */
  kind: 'errors' | 'log';
  /**
   * The excerpt, free of provider framing. Ordered as the agent should read it:
   * `errors` most-significant first, `log` in the order it was printed.
   */
  lines: string[];
  /**
   * Lines the **provider read** did not return. Reported separately from what
   * {@link ciEvidenceNote}'s cap drops: the harness never saw these.
   */
  droppedBefore?: number;
}

/** One check the harness wants evidence for, as {@link CiEvidenceReader} is asked. */
export interface CiEvidenceTarget {
  name: string;
  /** {@link CiCheck.evidenceRef} — opaque here, meaningful only to the provider that wrote it. */
  evidenceRef: string;
}

/**
 * The seam the executor depends on: "what broke on these checks of this PR". Asked
 * once per dispatch rather than every pulse. Never throws: a provider that cannot
 * answer returns what it could and records the failure through `errors.record`,
 * leaving the prompt unchanged. → `docs/spec/15-integrations.md`
 */
export interface CiEvidenceReader {
  readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]>;
}

/** The whole-prompt budget for evidence, in characters, split across the checks that have any. */
const MAX_EVIDENCE_CHARS = 6000;

/** The smallest excerpt worth including for one check: below this a share cannot carry a stack frame. */
const MIN_SHARE_CHARS = 400;

/** Lines of a raw log worth asking a provider for. Ignored for structured errors. */
export const EVIDENCE_LOG_TAIL_LINES = 120;

/**
 * The evidence block appended to a CI-fix prompt, or `''` when there is none.
 * **Appended by the caller, never interpolated**, and an empty string must leave
 * the prompt byte-identical. → `docs/spec/05-dispatcher.md#prompt-templates`
 */
export function ciEvidenceNote(evidence: CiFailureEvidence[]): string {
  const usable = evidence.filter((e) => e.lines.length > 0);
  if (usable.length === 0) return '';

  // An even split rather than first-come, so a chatty first log cannot hide the
  // second check's assertion behind its own setup noise.
  const share = Math.floor(MAX_EVIDENCE_CHARS / usable.length);
  const included =
    share >= MIN_SHARE_CHARS ? usable : usable.slice(0, Math.floor(MAX_EVIDENCE_CHARS / MIN_SHARE_CHARS));
  const perCheck = Math.floor(MAX_EVIDENCE_CHARS / Math.max(included.length, 1));

  const lines = [
    'What the failing checks actually reported. The harness fetched this from the provider, so you do not need ' +
      'to reproduce the failure to find out what broke — read it first, and reproduce only if it is not enough:',
  ];
  for (const e of included) {
    const { text, dropped, cutMidLine } = trimEvidence(e, perCheck);
    lines.push(
      '',
      `--- ${e.check} (${e.kind === 'errors' ? 'errors reported by the check' : 'end of the job log'}) ---`,
    );
    lines.push(text);
    // Both kinds of loss are named, and named apart: "trimmed here" and "never
    // fetched" answer different questions.
    const notes: string[] = [];
    if (e.droppedBefore) notes.push(`${e.droppedBefore} earlier lines were not fetched`);
    if (dropped) notes.push(`${dropped} more ${e.kind === 'errors' ? 'errors were' : 'lines were'} trimmed to fit`);
    // A third loss with its own wording: the line in hand is itself incomplete.
    if (cutMidLine) notes.push('one line was longer than the budget and was cut mid-line to fit');
    if (notes.length > 0) lines.push(`[${notes.join('; ')} — open the check in the provider for the full output.]`);
  }

  const omitted = usable.length - included.length;
  if (omitted > 0) {
    lines.push(
      '',
      `[${omitted} other failing check${omitted === 1 ? '' : 's'} had output too, but it would not fit in this ` +
        'prompt. Open them in the provider if the above does not explain the failure.]',
    );
  }

  return `\n\n${lines.join('\n')}`;
}

/**
 * Cut one check's excerpt to its share, from the end that matters: a `log` keeps
 * its tail (the failure), `errors` keeps its head (already ranked). The cap must
 * hold even against a single line longer than the whole budget — provider output
 * routinely carries a whole stack trace on one line — so an oversized first line
 * is truncated rather than admitted whole, and the cut is reported.
 */
function trimEvidence(
  evidence: CiFailureEvidence,
  budget: number,
): { text: string; dropped: number; cutMidLine: boolean } {
  const kept: string[] = [];
  let used = 0;
  let cutMidLine = false;
  // Walk from the end the failure is at, so the cut lands on the noise.
  const ordered = evidence.kind === 'log' ? [...evidence.lines].reverse() : evidence.lines;
  for (const line of ordered) {
    if (used + line.length + 1 > budget) {
      if (kept.length > 0) break;
      // Nothing kept yet and this line already overruns: take the budget's worth
      // from the end that carries the failure rather than the whole line.
      const room = Math.max(budget - 1, 0);
      kept.push(evidence.kind === 'log' ? line.slice(line.length - room) : line.slice(0, room));
      cutMidLine = true;
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  const text = (evidence.kind === 'log' ? kept.reverse() : kept).join('\n');
  return { text, dropped: evidence.lines.length - kept.length, cutMidLine };
}
