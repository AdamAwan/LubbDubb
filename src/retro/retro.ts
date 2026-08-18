/**
 * The retrospective's pure layer — the policy, the origin, and what a submission is
 * allowed to be.
 *
 * ## The gap this closes
 *
 * The Goal Floor draws a station called Manifest, *Report what was done*,
 * immediately before Launch — and it reports nothing. Its content was
 * `issue.conclusion?.note` falling back to an em dash, its `link` was null, and
 * nothing downstream read it: the edge to the Signal post is drawing order, and a
 * missing note held nothing back. The floor named a step the harness never took.
 * What it should name is the run's own post-mortem.
 *
 * ## Why it is not a plan part
 *
 * `expectedKind: 'report'` already exists, so a plan could have carried this, and
 * that was refused. A part is *work the plan schedules*: retired by a replan,
 * counted by `liveParts`, rolled up into the plan's status, and available only to a
 * decomposed issue. A retrospective is about the whole goal — including the ones
 * nobody decomposed — and it must survive a replan rewriting `plan_parts`. It is
 * also not something a planner should be able to forget, since the sloppiest plan
 * is the run most worth reading about.
 *
 * ## Why nothing gates on it
 *
 * A goal is delivered whether or not anybody wrote it up. So a missing retrospective
 * is silence rather than a hold — the `undeclared`-vs-`more_work` asymmetry again —
 * and that is what makes rule `issue-retro`'s fail-open cheap: an agent that crashes, is killed
 * or spends its attempt cap costs the report and nothing else. No escalation is
 * raised, because there is nothing a human can do about a write-up that did not
 * happen that they cannot do by reading the issue.
 */

import { validateLessonText } from '../lessons.js';

/** A document long enough to be a real write-up, short enough not to be a pasted transcript. */
export const MAX_RETRO_DOCUMENT = 20_000;

/**
 * How many lessons one retrospective may propose (issue #355 phase 2).
 *
 * The scarce resource on this path is not storage: every lesson lands `proposed`
 * and is worth nothing until a person has read it and vouched for it. A run
 * teaches one or two things about *working* this repository; a write-up that
 * files fifteen has stopped discriminating — and fifteen plausible claims are
 * read less carefully than two, which is the failure the gate itself cannot
 * catch. The cap is therefore on the reader's attention, not on the table.
 */
const MAX_RETRO_LESSONS = 5;

/** The summary is the station's one line and the fleet's scannable reading of the run. */
const MAX_RETRO_SUMMARY = 400;

/**
 * The origin a retrospective agent is dispatched on — its own, for `assessOrigin`'s
 * reason: the cooldown and attempt cap that throttle retrospectives must be
 * independent of the pickup attempts on `issue:<n>`, or a looping retro agent would
 * eat the budget that gets the work done.
 */
export function retroOrigin(issueNumber: number): string {
  return `issue:${issueNumber}:retro`;
}

/**
 * Which issue this caller may write up, refusing every other origin **by name and
 * with the tool it actually wants**.
 *
 * Structural identity, as for every other write in the channel — and here it also
 * decides whether the account is worth anything: an agent that did the work is
 * refused rather than scoped down, because a retrospective written by the agent
 * whose run it judges is not a retrospective.
 */
export function retroSubmitOrigin(
  originRef: string | null,
): { ok: true; issueOrigin: string } | { ok: false; error: string } {
  const match = originRef ? /^issue:(\d+):retro$/.exec(originRef) : null;
  if (match) return { ok: true, issueOrigin: `issue:${match[1]}` };
  return {
    ok: false,
    error:
      `retro_submit is only for the agent dispatched to write an issue's retrospective, and this task's ` +
      `origin is ${originRef ?? '(none)'}. If you are finishing work on an issue, use conclude_work; if ` +
      `you finished a plan part that produced no pull request, use conclude_part.`,
  };
}

/**
 * What a submission is allowed to be.
 *
 * The summary is **required and refused when missing** (`validateConclusion`'s
 * rule): it is the whole of what an operator sees before deciding whether to open
 * the document, and a retrospective nobody opens has not been written. The document
 * is **trimmed rather than refused** (`MAX_PLAN_DOCUMENT_CHARS`' rule): an over-long
 * write-up must not sink the whole submission after the work of assembling it.
 *
 * The lessons are **optional, and never sink the submission** — a run that taught
 * nothing general is the common case, and a retrospective that files no lesson is
 * a complete retrospective. See {@link parseLessons} for what happens to the ones
 * that do not fit.
 */
export function validateRetrospective(
  args: Record<string, unknown>,
):
  | { ok: true; summary: string; document: string; trimmed: boolean; lessons: string[]; lessonsDropped: number }
  | { ok: false; error: string } {
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
  const { lessons, dropped } = parseLessons(args.lessons);
  return {
    ok: true,
    summary,
    document: trimmed ? raw.slice(0, MAX_RETRO_DOCUMENT) : raw,
    trimmed,
    lessons,
    lessonsDropped: dropped,
  };
}

/**
 * The lessons a submission carries, and what happens to the ones that do not fit.
 *
 * **Dropped whole, never trimmed** — the opposite of the document's rule, and the
 * difference is what truncation leaves behind. Half a write-up is a shorter
 * write-up; half a lesson is a *different claim*, still promotable, and the one
 * safeguard this whole feature rests on is a person reading the claim before
 * vouching for it. So an over-long lesson is dropped and the count is handed back
 * — the agent is told, the operator is never shown a mangled assertion, and
 * neither of those is silent.
 *
 * A missing or malformed `lessons` is no lessons rather than a refusal, for
 * {@link validateRetrospective}'s stated reason: the write-up must not sink over
 * a field the run had nothing to put in.
 */
function parseLessons(raw: unknown): { lessons: string[]; dropped: number } {
  if (!Array.isArray(raw)) return { lessons: [], dropped: 0 };
  const lessons: string[] = [];
  let dropped = 0;
  for (const entry of raw) {
    const parsed = validateLessonText(entry);
    if (!parsed.ok) {
      dropped += 1;
      continue;
    }
    // Over the cap is a drop like any other, and counted like any other: an agent
    // that filed eight is told two did not land, rather than being left to assume
    // all eight are waiting for a reader.
    if (lessons.length >= MAX_RETRO_LESSONS) {
      dropped += 1;
      continue;
    }
    lessons.push(parsed.text);
  }
  return { lessons, dropped };
}
