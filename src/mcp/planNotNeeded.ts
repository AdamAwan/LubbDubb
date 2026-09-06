import { planOriginIssue } from '../plans/planning.js';

// → docs/spec/11-mcp-tools.md

const MAX_SUMMARY = 160;

const MAX_DETAIL = 2000;

export function validatePlanNotNeeded(
  args: Record<string, unknown>,
): { ok: true; summary: string; detail: string } | { ok: false; error: string } {
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return {
      ok: false,
      error:
        'summary is required. One line saying what the issue asked for and where it already is; the ' +
        'evidence goes in `detail`. An operator decides whether to believe you from these two alone.',
    };
  }
  if (/[\r\n]/.test(summary)) {
    return {
      ok: false,
      error:
        'summary is one line — what you found, in a sentence. Everything with a line break in it is ' +
        'evidence: put it in `detail`, which takes markdown and is rendered as the body of the card an ' +
        'operator reads.',
    };
  }
  if (summary.length > MAX_SUMMARY) {
    return {
      ok: false,
      error:
        `summary is too long (${summary.length} chars, max ${MAX_SUMMARY}) — it is the headline, not the ` +
        `account. Keep the claim and move the rest to \`detail\`.`,
    };
  }
  const detail = typeof args.detail === 'string' ? args.detail.trim() : '';
  if (!detail) {
    return {
      ok: false,
      error:
        'detail is required. You are saying a ticket is already satisfied by a repository the person who ' +
        'filed it has read differently, so show your working: the files, the commits or the pull requests ' +
        'that already do what it asks, and what you checked to be sure nothing is missing. Without that ' +
        'nobody can tell your verdict from a planner that did not look. If you cannot point at anything, ' +
        'you are not sure — plan the work instead.',
    };
  }
  if (detail.length > MAX_DETAIL) {
    return { ok: false, error: `detail is too long (${detail.length} chars, max ${MAX_DETAIL}). Summarise it.` };
  }
  return { ok: true, summary, detail };
}

export function plannerOrigin(
  originRef: string | null,
): { ok: true; originRef: string; issueOrigin: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const number = planOriginIssue(ref);
  if (number !== null) return { ok: true, originRef: ref, issueOrigin: `issue:${number}` };

  const part = /^issue:(\d+):part:/.exec(ref);
  if (part) {
    return {
      ok: false,
      error:
        `plan_not_needed is the planner's verdict on a whole issue, and you are working one part of issue ` +
        `#${part[1]}'s plan. If there is nothing to build in your part, close it with conclude_part and ` +
        `kind "determination" — the plan already speaks for the issue.`,
    };
  }
  const assessor = /^issue:(\d+):assess$/.exec(ref);
  if (assessor) {
    return {
      ok: false,
      error:
        `plan_not_needed is for a planner deciding there is nothing to build, and you were dispatched to ` +
        `assess whether issue #${assessor[1]} was delivered. Cast your verdict with assess_issue — ` +
        `"delivered" records the same park with your account of the work behind it.`,
    };
  }
  const appraiser = /^issue:(\d+):appraisal$/.exec(ref);
  if (appraiser) {
    return {
      ok: false,
      error:
        `plan_not_needed says a goal is already met, and you were dispatched to judge whether issue ` +
        `#${appraiser[1]}'s goal can be worked from at all. Cast your verdict with appraise_issue: a ticket ` +
        `that contradicts what is already true of the repository is "unclear", which is the reading that ` +
        `puts it in front of the person who filed it.`,
    };
  }
  const issue = /^issue:(\d+)$/.exec(ref);
  if (issue) {
    return {
      ok: false,
      error:
        `plan_not_needed is a planner's verdict, and you were dispatched to deliver issue #${issue[1]}. If ` +
        `you found there is nothing to do because it is already done, say so with conclude_work — status ` +
        `"done" and a note saying what you found.`,
    };
  }
  return {
    ok: false,
    error:
      `plan_not_needed is available to a planning agent, and this task's origin is ${ref || '(none)'}, ` +
      `which is not a planning origin.`,
  };
}
