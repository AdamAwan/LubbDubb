import type { PadDecision } from '../types.js';

// → docs/spec/31-review-packs.md

export const MAX_PAD_NOTE = 4000;

const MAX_PAD_TOPIC = 60;

export function padOriginFor(originRef: string | null): string | null {
  if (!originRef) return null;
  const match = /^(issue|pr):(\d+)(?::.+)?$/.exec(originRef);
  return match ? `${match[1]}:${match[2]}` : null;
}

export function goalOriginFor(originRef: string | null): string | null {
  const pad = padOriginFor(originRef);
  return pad?.startsWith('issue:') ? pad : null;
}

export function padWriteTarget(originRef: string | null): { ok: true; padRef: string } | { ok: false; error: string } {
  const padRef = padOriginFor(originRef);
  if (padRef) return { ok: true, padRef };
  return {
    ok: false,
    error:
      `The scratchpad belongs to one issue or one pull request and the agents working it, and this ` +
      `task's origin is ${originRef ?? '(none)'}, which is neither. If you noticed something outside ` +
      `your own task, use report_finding; if you are saying what you are working on right now, use note_progress.`,
  };
}

export function normalisePadNote(
  value: unknown,
  topic: unknown,
): { ok: true; note: string; topic: string | null; trimmed: boolean } | { ok: false; error: string } {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    return {
      ok: false,
      error:
        'note is required: what you learned, tried, or decided, in plain words — written for whoever ' +
        'works this goal next and for the retrospective at the end.',
    };
  }
  const tag = typeof topic === 'string' ? topic.replace(/\s+/g, ' ').trim().slice(0, MAX_PAD_TOPIC) : '';
  const trimmed = raw.length > MAX_PAD_NOTE;
  return { ok: true, note: trimmed ? raw.slice(0, MAX_PAD_NOTE) : raw, topic: tag || null, trimmed };
}

export const MAX_PAD_LINE = 300;

export const MAX_DECISION_ITEMS = 20;

export function normalisePadDecision(
  value: unknown,
): { ok: true; decision: PadDecision | null; trimmed: boolean } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, decision: null, trimmed: false };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'decision must be an object: {chose, because, rejected, paths}.' };
  }
  const raw = value as Record<string, unknown>;
  let trimmed = false;
  const line = (field: string, v: unknown, what: string): string | { error: string } => {
    const text = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
    if (!text) return { error: `${field} is required: ${what}, in one line.` };
    if (text.length > MAX_PAD_LINE) trimmed = true;
    return text.slice(0, MAX_PAD_LINE);
  };
  const chose = line('decision.chose', raw.chose, 'what the change does here');
  if (typeof chose !== 'string') return { ok: false, error: chose.error };
  const because = line('decision.because', raw.because, 'why');
  if (typeof because !== 'string') return { ok: false, error: because.error };

  const rejectedRaw = raw.rejected ?? [];
  if (!Array.isArray(rejectedRaw)) {
    return { ok: false, error: 'decision.rejected must be a list of {alternative, because}, or omitted.' };
  }
  const rejected: PadDecision['rejected'] = [];
  for (const [i, item] of rejectedRaw.entries()) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      return { ok: false, error: `decision.rejected[${i}] must be an object: {alternative, because}.` };
    }
    const r = item as Record<string, unknown>;
    const alternative = line(`decision.rejected[${i}].alternative`, r.alternative, 'the road not taken');
    if (typeof alternative !== 'string') return { ok: false, error: alternative.error };
    const why = line(`decision.rejected[${i}].because`, r.because, 'why it was not taken');
    if (typeof why !== 'string') return { ok: false, error: why.error };
    rejected.push({ alternative, because: why });
  }

  const pathsRaw = raw.paths ?? [];
  if (!Array.isArray(pathsRaw)) return { ok: false, error: 'decision.paths must be a list of file paths, or omitted.' };
  const paths: string[] = [];
  for (const [i, item] of pathsRaw.entries()) {
    const path = line(`decision.paths[${i}]`, item, 'a file path');
    if (typeof path !== 'string') return { ok: false, error: path.error };
    paths.push(path);
  }

  if (rejected.length > MAX_DECISION_ITEMS || paths.length > MAX_DECISION_ITEMS) trimmed = true;
  return {
    ok: true,
    decision: {
      chose,
      because,
      rejected: rejected.slice(0, MAX_DECISION_ITEMS),
      paths: paths.slice(0, MAX_DECISION_ITEMS),
    },
    trimmed,
  };
}

export const WITNESS_INSTRUCTION = [
  '## Record the forks you take',
  '',
  'When the change could reasonably have gone another way — two ways to shape a fix, a file you',
  'chose not to touch, an approach you tried and dropped — leave a `scratch_append` entry with a',
  '`decision` beside the note: `chose` (what you did here), `because` (why), `rejected` (each',
  'alternative with the reason it was not taken) and `paths` (the files the fork touches, where you',
  'can say). One line each, written at the fork rather than as a narrative at the end. `rejected`',
  'is the field that matters: the road not taken leaves no trace in the diff, and it is the thing a',
  'reviewer asks about most. If there were no forks, write nothing — an empty log is an honest one.',
].join('\n');
