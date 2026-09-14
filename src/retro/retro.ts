import { issueOriginNumber, issueOriginRef } from '../issueOrigins.js';

// → docs/spec/05-dispatcher.md

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
