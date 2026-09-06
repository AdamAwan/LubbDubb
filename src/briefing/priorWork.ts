import { padTestimony } from '../retro/dossier.js';
import { liveParts } from '../plans/parts.js';
import type {
  GoalFile,
  GoalNeighbour,
  IssueAppraisal,
  IssueConclusion,
  IssueDelivery,
  IssueShortfall,
  Plan,
  PlanPart,
  ScratchEntry,
} from '../types.js';

/**
 * What the earlier agents on a goal wrote down, rendered for the next one and
 * appended to its prompt.
 *
 * Three rules hold the module together: it carries **only what no prompt already
 * renders**, it states **no world fact** (a PR's state is live through `world_read`),
 * and it **derives nothing** — every line is a stored field quoted back, never a
 * ranking or relevance score. Bounded, and **what a cap dropped is always named**,
 * or an agent reads a partial record as the whole one; an untouched goal renders
 * the empty string. → `docs/spec/09-execution.md#what-earlier-agents-worked-out-reaches-the-next-one`
 */

/** Entries beyond this are dropped from the briefing — the oldest first, and said so. */
const MAX_PAD_ENTRIES = 15;

/** The write-up is the one field with no natural bound. Truncation is marked, never silent. */
const MAX_DOCUMENT = 4000;

/**
 * Paths beyond this are dropped — the oldest first, and said so. Tight because this
 * is the section that scales with the *size* of the work rather than with what
 * anyone chose to write down.
 */
const MAX_FILE_PATHS = 25;

/**
 * Neighbouring goals beyond this are dropped — the least recently worked first, and
 * said so. Lower than the file cap: each line carries a whole summary, not a path.
 */
const MAX_NEIGHBOUR_GOALS = 4;

/** Shared paths named per neighbour before the rest are counted instead. Some are always named. */
const MAX_NEIGHBOUR_PATHS = 4;

export interface PriorWorkInput {
  /** The plan for this goal, whatever its verdict — a `single` plan has a write-up too. */
  plan: Plan | null;
  parts: PlanPart[];
  appraisal: IssueAppraisal | null;
  /** Null when the outstanding-work note already carries it — one fact rendered twice reads as two. */
  conclusion: IssueConclusion | null;
  delivery: IssueDelivery | null;
  shortfall: IssueShortfall | null;
  entries: ScratchEntry[];
  /** Newest write first, one row per path — `Store.listGoalFiles`. */
  files: GoalFile[];
  /**
   * Goals with a retrospective that have been in the same files as this one, the
   * most recently worked first — `Store.listGoalNeighbours`, seeded by
   * {@link neighbourSeedPaths}.
   */
  neighbours: GoalNeighbour[];
  /**
   * True when the dispatch is for a part of this plan: `plan-part` already renders
   * every sibling through `siblingContext`. It suppresses the parts section and
   * **nothing else** — the file and neighbour lists stay on for a part dispatch.
   */
  forPart: boolean;
}

/**
 * Render the briefing, or the empty string when this goal has nothing to say yet.
 * Pure, and it derives nothing: every line is a stored field quoted back.
 */
export function priorWorkBriefing(input: PriorWorkInput): string {
  const sections = [
    padSection(input.entries),
    planSection(input.plan),
    partsSection(input.forPart ? [] : input.parts),
    verdictSection(input),
    filesSection(input.files),
    neighboursSection(input.neighbours),
  ].filter(Boolean);
  if (sections.length === 0) return '';
  return [
    '## What earlier agents on this goal already worked out',
    '',
    'Their words, not the harness’s instructions, and as old as their timestamps say. ' +
      'Use it so you do not pay twice for the same discovery — and check anything you rely on, ' +
      'because the repository is the truth and this is testimony about it.',
    '',
    sections.join('\n\n'),
  ].join('\n');
}

/**
 * The pad, oldest-first so the reasoning reads in the order it happened. Over the
 * cap the **oldest** go, and the drop is stated so a reader knows the record is partial.
 */
function padSection(entries: ScratchEntry[]): string {
  if (entries.length === 0) return '';
  const dropped = Math.max(0, entries.length - MAX_PAD_ENTRIES);
  const shown = dropped > 0 ? entries.slice(dropped) : entries;
  const testimony = padTestimony(shown);
  if (dropped === 0) return testimony;
  return `${testimony}\n\n(${dropped} earlier note${dropped === 1 ? '' : 's'} on this pad are not shown here — read them with scratch_read.)`;
}

/** The planner's narrative: why the work is shaped this way, and what it is not. */
function planSection(plan: Plan | null): string {
  if (!plan) return '';
  const lines: string[] = [];
  // No prompt renders these — `currentPlanSummary` carries `reason` and stops there.
  if (plan.diagnosis) lines.push(`**What the planner found was actually wrong:** ${plan.diagnosis}`);
  if (plan.approach) lines.push(`**What the planner said would be done about it:** ${plan.approach}`);
  // The test the work will be judged by: told beforehand rather than guessed at.
  if (plan.verification) lines.push(`**How the planner said we would know it worked:** ${plan.verification}`);
  if (plan.alternatives) lines.push(`**What the planner considered and rejected:** ${plan.alternatives}`);
  if (plan.openQuestions) lines.push(`**What the planner was least sure about:** ${plan.openQuestions}`);
  if (plan.risks) lines.push(`**What the planner thought could go wrong:** ${plan.risks}`);
  if (plan.outOfScope) lines.push(`**What the planner deliberately left out:** ${plan.outOfScope}`);
  // Cited so the agent starts where the planner finished. Flat: the briefing is appended prose.
  if (plan.evidence.length > 0) {
    const cites = plan.evidence
      .map((e) => `${e.path}${e.line === null ? '' : `:${e.line}`}${e.note === null ? '' : ` — ${e.note}`}`)
      .join('\n');
    lines.push(`**Where the planner found it:**\n${cites}`);
  }
  if (plan.document) {
    const doc =
      plan.document.length > MAX_DOCUMENT
        ? `${plan.document.slice(0, MAX_DOCUMENT)}\n\n[… the write-up is longer than this; the rest was not included.]`
        : plan.document;
    lines.push(`**The plan, as the planner wrote it up:**\n\n${doc}`);
  }
  if (lines.length === 0) return '';
  return ['### Why this work is shaped the way it is', '', ...lines].join('\n');
}

/** Per-part intent: only the two fields nothing else renders, and only for parts that declared one. */
function partsSection(parts: PlanPart[]): string {
  const declared = liveParts(parts).filter((p) => p.rationale ?? p.acceptance);
  if (declared.length === 0) return '';
  const lines = declared.map((p) => {
    const why = p.rationale ? ` — ${p.rationale}` : '';
    const done = p.acceptance ? `\n  - Done when: ${p.acceptance}` : '';
    return `- **${p.slug}** (${p.title})${why}${done}`;
  });
  return ['### What each part of the plan was for', '', ...lines].join('\n');
}

/**
 * Where this goal's work has actually been: one line per path, most recent write
 * first, attributed to the origin that made it. Sits **last**, because it is the
 * index and everything above it is the argument. Promoted paths are in it, unmarked,
 * and staleness is covered by the briefing heading rather than a softer note here.
 */
function filesSection(files: GoalFile[]): string {
  if (files.length === 0) return '';
  const dropped = Math.max(0, files.length - MAX_FILE_PATHS);
  const shown = dropped > 0 ? files.slice(0, MAX_FILE_PATHS) : files;
  const lines = shown.map((f) => `- \`${f.path}\` — ${f.originRef} · ${f.createdAt}`);
  if (dropped > 0) {
    lines.push(
      `\n(${dropped} of the ${files.length} path${files.length === 1 ? '' : 's'} are not shown here — the oldest went first.)`,
    );
  }
  return [
    '### Files this goal has been edited in',
    '',
    // Not "the agents above": this can be the only section a goal has.
    'Written by the agents on this goal, most recently written first, and as the paths stood then.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * The paths a neighbour lookup asks about: where this goal has **been**, and where
 * its planner said the answer **was**. Two sources because the file rows are empty
 * on exactly the first dispatch the lookup is worth most on. The two mean different
 * things and neither is widened into the other — the section names paths a neighbour
 * *shares* and never claims this goal edited them. Deduped, own writes first.
 */
export function neighbourSeedPaths(files: GoalFile[], plan: Plan | null): string[] {
  return [...new Set([...files.map((f) => f.path), ...(plan?.evidence ?? []).map((e) => e.path)])];
}

/**
 * Who else has been in this code, and how their run went. Sits last, under the index
 * it is derived from. The summary is **quoted, not pointed at** — no tool an agent
 * has reaches another goal's write-up. Nothing here claims relevance: the order is
 * recency, and the shared-path count is stated rather than allowed to rank.
 */
function neighboursSection(neighbours: GoalNeighbour[]): string {
  if (neighbours.length === 0) return '';
  const dropped = Math.max(0, neighbours.length - MAX_NEIGHBOUR_GOALS);
  const shown = dropped > 0 ? neighbours.slice(0, MAX_NEIGHBOUR_GOALS) : neighbours;
  const lines = shown.map((n) => {
    const extra = Math.max(0, n.sharedPaths.length - MAX_NEIGHBOUR_PATHS);
    const named = n.sharedPaths
      .slice(0, MAX_NEIGHBOUR_PATHS)
      .map((path) => `\`${path}\``)
      .join(', ');
    const rest = extra > 0 ? `, and ${extra} more of the ${n.sharedPaths.length}` : '';
    return `- **${n.goalRef}** has been in ${named}${rest}. Its retrospective: ${n.retroSummary}`;
  });
  if (dropped > 0) {
    lines.push(
      `\n(${dropped} of the ${neighbours.length} goal${neighbours.length === 1 ? '' : 's'} are not shown here — the least recently worked went first.)`,
    );
  }
  return [
    '### Other goals that have been in these same files',
    '',
    'Goals with a retrospective of their own that have been in files this one has been edited in, or ' +
      'that its plan cites as evidence — most recently worked first. This does not say the work is ' +
      'related: it says somebody has been in this code and wrote up how it went.',
    '',
    ...lines,
  ].join('\n');
}

/** The prose behind the verdicts standing on this goal — never the verdicts as a gate reads them. */
function verdictSection(input: PriorWorkInput): string {
  const lines: string[] = [];
  if (input.appraisal) {
    lines.push(`- **Appraised \`${input.appraisal.verdict}\`** by ${input.appraisal.by}: ${input.appraisal.summary}`);
  }
  if (input.conclusion) {
    lines.push(
      `- **An agent declared \`${input.conclusion.verdict}\`** (${input.conclusion.by}): ${input.conclusion.note}`,
    );
  }
  if (input.delivery) {
    lines.push(`- **Assessed as delivered** by ${input.delivery.by}: ${input.delivery.summary}`);
  }
  if (input.shortfall) {
    const cause = input.shortfall.cause ? ` (cause: \`${input.shortfall.cause}\`)` : '';
    lines.push(`- **Assessed as falling short**${cause} by ${input.shortfall.by}: ${input.shortfall.summary}`);
  }
  if (lines.length === 0) return '';
  return ['### What has been decided about this goal', '', ...lines].join('\n');
}
