import { normalizeAreaPath } from '../intake/placement.js';

// → docs/spec/11-mcp-tools.md

export const GOAL_APPRAISAL_VERDICTS = ['workable', 'unclear'] as const;

export type GoalAppraisalVerdictName = (typeof GOAL_APPRAISAL_VERDICTS)[number];

export const GOAL_APPRAISAL_VERDICT_HELP: Record<GoalAppraisalVerdictName, string> = {
  workable:
    'there is a goal here an agent could start from — you may not agree with it, and it may be large, ' +
    'but what is being asked for is identifiable against this repository. The harness proceeds exactly ' +
    'as it would have',
  unclear:
    'the goal cannot be acted on as written — it is ambiguous about what "done" means, it contradicts ' +
    'itself or something already true of the repository, or it names things that do not exist. Nothing ' +
    'is dispatched for it until the ticket itself is rewritten or a human overrides you',
};

export const STORY_RUBRIC = {
  always: [
    'the problem — who has it and why it matters',
    'what success looks like — observable, so someone could tell "done" from "not done"',
    'the words it uses defined where they could mean two things',
  ],
  whenImplied: [
    'a UI change: an attached design or mockup, or an exact description of layout, states and behaviour',
    'data going in or out: an example of the shape — a real-looking sample, not just a type name',
    'links to the specs or documentation it relates to',
  ],
  neverRequired: ['implementation hints, where the author already has an idea', 'what is out of scope'],
} as const;

const MAX_MISSING = 8;
const MAX_MISSING_ITEM = 300;

const MAX_APPRAISAL_SUMMARY = 2000;

export function validateGoalAppraisal(
  args: Record<string, unknown>,
  profiles: readonly string[] = [],
  areaPaths: readonly string[] = [],
):
  | {
      ok: true;
      verdict: GoalAppraisalVerdictName;
      summary: string;
      missing: string[];
      profile: string | null;
      parent: number | null;
      areaPath: string | null;
    }
  | { ok: false; error: string } {
  const verdict = args.status;
  if (typeof verdict !== 'string' || !GOAL_APPRAISAL_VERDICTS.includes(verdict as GoalAppraisalVerdictName)) {
    return {
      ok: false,
      error:
        `status must be one of ${GOAL_APPRAISAL_VERDICTS.join(', ')}. ` +
        GOAL_APPRAISAL_VERDICTS.map((v) => `${v}: ${GOAL_APPRAISAL_VERDICT_HELP[v]}`).join('. '),
    };
  }
  const summary = typeof args.summary === 'string' ? args.summary.trim() : '';
  if (!summary) {
    return {
      ok: false,
      error:
        'summary is required. For unclear, say exactly what you would need in order to start — that text ' +
        'is the whole of what a human has to go on, and nothing happens for this issue until they act on ' +
        'it. For workable, say in a sentence what you understood the goal to be, so a wrong reading is ' +
        'visible before an agent acts on it.',
    };
  }
  if (summary.length > MAX_APPRAISAL_SUMMARY) {
    return {
      ok: false,
      error: `summary is too long (${summary.length} chars, max ${MAX_APPRAISAL_SUMMARY}). Summarise it.`,
    };
  }
  const missing = checkMissing(args.missing, verdict as GoalAppraisalVerdictName);
  if (!missing.ok) return missing;
  const named = verdict === 'workable' ? checkProfile(args.profile, profiles) : { ok: true as const, profile: null };
  if (!named.ok) return named;
  const workable = verdict === 'workable';
  const parent = workable ? checkParent(args.parent) : { ok: true as const, parent: null };
  if (!parent.ok) return parent;
  const area = workable ? checkAreaPath(args.area_path, areaPaths) : { ok: true as const, areaPath: null };
  if (!area.ok) return area;
  return {
    ok: true,
    verdict: verdict as GoalAppraisalVerdictName,
    summary,
    missing: missing.missing,
    profile: named.profile,
    parent: parent.parent,
    areaPath: area.areaPath,
  };
}

function checkParent(value: unknown): { ok: true; parent: number | null } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, parent: null };
  const n =
    typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim().replace(/^#/, '')) : NaN;
  if (!Number.isInteger(n) || n <= 0)
    return {
      ok: false,
      error: `parent must be the number of an existing work item — "${String(value)}" is not one. Omit it if none of the containers you were shown fit.`,
    };
  return { ok: true, parent: n };
}

function checkMissing(
  value: unknown,
  verdict: GoalAppraisalVerdictName,
): { ok: true; missing: string[] } | { ok: false; error: string } {
  if (verdict === 'workable') return { ok: true, missing: [] };
  const items = Array.isArray(value)
    ? value
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    : [];
  if (items.length === 0)
    return {
      ok: false,
      error:
        'missing is required with "unclear": one entry per thing the ticket has to say before an agent could ' +
        'start — the problem, what "done" looks like, a defined term, a mockup, a sample of the data, a link — ' +
        'each phrased as the specific question the author has to answer. It is rendered on the ticket as ' +
        'the list they work through, so an entry that only says "unclear" leaves them exactly where they were.',
    };
  if (items.length > MAX_MISSING)
    return {
      ok: false,
      error: `missing has ${items.length} entries (max ${MAX_MISSING}). Keep the ones the author must answer before anything could start.`,
    };
  const long = items.find((v) => v.length > MAX_MISSING_ITEM);
  if (long !== undefined)
    return {
      ok: false,
      error: `each entry in missing is one question (max ${MAX_MISSING_ITEM} chars) — "${long.slice(0, 40)}…" is too long.`,
    };
  return { ok: true, missing: items };
}

function checkAreaPath(
  value: unknown,
  areaPaths: readonly string[],
): { ok: true; areaPath: string | null } | { ok: false; error: string } {
  if (areaPaths.length === 0) return { ok: true, areaPath: null };
  if (value === undefined || value === null || value === '') return { ok: true, areaPath: null };
  if (typeof value !== 'string')
    return { ok: false, error: `area_path must be one of this project's area paths: ${areaPaths.join(', ')}.` };
  const wanted = normalizeAreaPath(value);
  const match = areaPaths.find((p) => normalizeAreaPath(p) === wanted);
  if (match === undefined)
    return {
      ok: false,
      error: `area_path "${value}" is not one of this project's area paths: ${areaPaths.join(', ')}.`,
    };
  return { ok: true, areaPath: match };
}

function checkProfile(
  value: unknown,
  profiles: readonly string[],
): { ok: true; profile: string | null } | { ok: false; error: string } {
  if (profiles.length === 0) return { ok: true, profile: null };
  const options = profiles.join(', ');
  if (typeof value !== 'string' || value.length === 0)
    return {
      ok: false,
      error:
        `profile is required: say which model profile this issue's work should run on, from ${options} — ` +
        `they are listed cheapest-first with what each is for in this tool's description. Judge the work the ` +
        `ticket implies, not the ticket's length. If a human has already pinned a profile on the ticket and you ` +
        `agree with it, name that one.`,
    };
  if (!profiles.includes(value))
    return { ok: false, error: `profile "${value}" is not one of this deployment's profiles: ${options}.` };
  return { ok: true, profile: value };
}

export function appraiserOrigin(
  originRef: string | null,
): { ok: true; originRef: string; issueOrigin: string } | { ok: false; error: string } {
  const ref = originRef ?? '';
  const match = /^issue:(\d+):appraisal$/.exec(ref);
  if (match) return { ok: true, originRef: ref, issueOrigin: `issue:${match[1]}` };

  const assessor = /^issue:(\d+):assess$/.exec(ref);
  if (assessor) {
    return {
      ok: false,
      error:
        `appraise_issue says whether issue #${assessor[1]}'s goal can be worked from at all, and you were ` +
        `dispatched to judge whether it was delivered. Cast your verdict with assess_issue instead.`,
    };
  }

  const planner = /^issue:(\d+):plan$/.exec(ref);
  if (planner) {
    return {
      ok: false,
      error:
        `appraise_issue is for an agent dispatched to judge whether issue #${planner[1]}'s goal can be acted ` +
        `on at all, before any work starts, and you were dispatched to decompose it — which the harness ` +
        `only asks for once the goal has been read as workable. If it is unclear to you now that you are ` +
        `in it, escalate — that reaches a human who can answer you, where this would only park an issue ` +
        `already under way.`,
    };
  }
  const working = /^issue:(\d+)(?::part:.+)?$/.exec(ref);
  if (working) {
    return {
      ok: false,
      error:
        `appraise_issue is for an agent dispatched to judge whether issue #${working[1]}'s goal can be acted ` +
        `on, before any work starts, and you were dispatched to do the work. If the goal is unclear to ` +
        `you now that you are in it, escalate — that reaches a human who can answer you, where this would ` +
        `only park the issue you are already working.`,
    };
  }
  return {
    ok: false,
    error:
      `appraise_issue says whether an issue's goal can be worked from, and this task's origin is ` +
      `${ref || '(none)'}, which is not an issue appraisal. Only the agent dispatched to appraise an issue casts ` +
      `this verdict.`,
  };
}
