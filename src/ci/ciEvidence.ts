// → docs/spec/07-pull-requests.md#ci

export interface CiFailureEvidence {
  check: string;
  kind: 'errors' | 'log';
  lines: string[];
  droppedBefore?: number;
}

export interface CiEvidenceTarget {
  name: string;
  evidenceRef: string;
}

export interface CiEvidenceReader {
  readCiFailureEvidence(prNumber: number, checks: CiEvidenceTarget[]): Promise<CiFailureEvidence[]>;
}

const MAX_EVIDENCE_CHARS = 6000;

const MIN_SHARE_CHARS = 400;

export const EVIDENCE_LOG_TAIL_LINES = 120;

export function ciEvidenceNote(evidence: CiFailureEvidence[]): string {
  const usable = evidence.filter((e) => e.lines.length > 0);
  if (usable.length === 0) return '';

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
    const notes: string[] = [];
    if (e.droppedBefore) notes.push(`${e.droppedBefore} earlier lines were not fetched`);
    if (dropped) notes.push(`${dropped} more ${e.kind === 'errors' ? 'errors were' : 'lines were'} trimmed to fit`);
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

function trimEvidence(
  evidence: CiFailureEvidence,
  budget: number,
): { text: string; dropped: number; cutMidLine: boolean } {
  const kept: string[] = [];
  let used = 0;
  let cutMidLine = false;
  const ordered = evidence.kind === 'log' ? [...evidence.lines].reverse() : evidence.lines;
  for (const line of ordered) {
    if (used + line.length + 1 > budget) {
      if (kept.length > 0) break;
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
