import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';
import { CAUSES_BY_KIND, validateRemedy } from '../remedies/remedies.js';
import type { RemedyCause, RemedyKind, RetroMissInput } from '../types.js';

// → docs/spec/05-dispatcher.md, docs/spec/41-repo-lessons.md#retrospective-misses

export const MAX_RETRO_DOCUMENT = 20_000;

const MAX_RETRO_SUMMARY = 400;

export function retroOrigin(issueNumber: number): string {
  return issueOriginRef('retro', issueNumber);
}

export function retroSubmitOrigin(
  originRef: string | null,
): { ok: true; issueOrigin: string } | { ok: false; error: string } {
  const number = issueOriginNumber('retro', originRef);
  if (number !== null) return { ok: true, issueOrigin: issueOriginRef('root', number) };
  return {
    ok: false,
    error:
      `retro_submit is only for the agent dispatched to write an issue's retrospective, and this task's ` +
      `origin is ${originRef ?? '(none)'}. If you are finishing work on an issue, use conclude_work; if ` +
      `you finished a plan part that produced no pull request, use conclude_part.`,
  };
}

export function validateRetrospective(
  args: Record<string, unknown>,
): { ok: true; summary: string; document: string; trimmed: boolean } | { ok: false; error: string } {
  const summary = typeof args.summary === 'string' ? args.summary.replace(/\s+/g, ' ').trim() : '';
  if (!summary) {
    return {
      ok: false,
      error:
        'summary is required: one or two sentences an operator reads before opening the document — what ' +
        'was delivered, and the one thing about this run worth knowing.',
    };
  }
  if (summary.length > MAX_RETRO_SUMMARY) {
    return {
      ok: false,
      error: `summary is too long (${summary.length} chars, max ${MAX_RETRO_SUMMARY}). It is the headline; the document carries the rest.`,
    };
  }
  const raw = typeof args.document === 'string' ? args.document.trim() : '';
  if (!raw) {
    return {
      ok: false,
      error:
        'document is required: the write-up itself, in markdown — what shipped, and how the run went. ' +
        'The summary is the headline, not the report.',
    };
  }
  const trimmed = raw.length > MAX_RETRO_DOCUMENT;
  return { ok: true, summary, document: trimmed ? raw.slice(0, MAX_RETRO_DOCUMENT) : raw, trimmed };
}

/** A retrospective miss is placed by a file, so it joins the area-placed kind and takes its causes. */
export const RETRO_MISS_KIND = 'review' satisfies RemedyKind;

export const RETRO_MISS_CAUSES: readonly RemedyCause[] = CAUSES_BY_KIND[RETRO_MISS_KIND];

export const MAX_RETRO_MISSES = 5;

const MAX_RETRO_MISS_PATH = 300;

/** Left out, `misses` is undefined and the goal's recorded misses stand; a list, empty included, replaces them. */
export function validateRetroMisses(
  raw: unknown,
): { ok: true; misses: RetroMissInput[] | undefined } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, misses: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: 'misses must be a list (empty when the run had none)' };
  if (raw.length > MAX_RETRO_MISSES) {
    return {
      ok: false,
      error: `misses has ${raw.length} entries (max ${MAX_RETRO_MISSES}). Keep the ones a later goal would pay for again.`,
    };
  }
  const misses: RetroMissInput[] = [];
  for (const [i, entry] of raw.entries()) {
    const parsed = validateRetroMiss((entry ?? {}) as Record<string, unknown>);
    if (!parsed.ok) return { ok: false, error: `misses[${i}]: ${parsed.error}` };
    misses.push(parsed.miss);
  }
  return { ok: true, misses };
}

/** A remedy's validation over review's vocabulary, plus the file the miss was about. */
function validateRetroMiss(
  args: Record<string, unknown>,
): { ok: true; miss: RetroMissInput } | { ok: false; error: string } {
  const remedy = validateRemedy(RETRO_MISS_KIND, args);
  if (!remedy.ok) return remedy;
  const path = retroMissPath(args.path);
  if (path === null) {
    return {
      ok: false,
      error:
        'path must be the repository-relative path of a file the miss was about, e.g. src/api/routes.ts — ' +
        'no leading slash, no "..", no directory',
    };
  }
  return { ok: true, miss: { ...remedy.submission, path } };
}

function retroMissPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const path = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (path === '' || path.length > MAX_RETRO_MISS_PATH || path.startsWith('/') || path.endsWith('/')) return null;
  if (/^[a-z]+:/i.test(path) || [...path].some((c) => c === '`' || c.charCodeAt(0) < 0x20)) return null;
  if (path.split('/').some((s) => s === '..' || s === '.' || s === '')) return null;
  return path;
}

/** Appended below the rendered `issue-retro` template, so an override that never learned of `misses` still asks for them. */
export function retroMissAskNote(lessonsOn: boolean): string {
  const lessons = lessonsOn
    ? 'The same miss on several goals is what a later agent drafts a fix to the repository from, for a person ' +
      'to review — so record'
    : 'Record';
  return (
    '\n\n---\n\nWhen you call `retro_submit`, also pass `misses`: each place this goal paid for something the ' +
    'repository could have told the agents — a confusing area, a convention or a fact nobody wrote down, a plan ' +
    'that had to be redone. Each is a `cause` and a `guard` from the lists the tool gives, the repository-relative ' +
    '`path` of a file it was about, and a one-line `summary`. Leave out what a CI fix or a review round on this goal ' +
    `already accounted for, and pass an empty list when there was nothing: that is the ordinary case. ${lessons} ` +
    'the guard honestly — "written down nowhere" and "written down and missed anyway" point at different fixes.\n'
  );
}
