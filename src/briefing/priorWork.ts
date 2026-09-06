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

// → docs/spec/09-execution.md

const MAX_PAD_ENTRIES = 15;

const MAX_DOCUMENT = 4000;

const MAX_FILE_PATHS = 25;

const MAX_NEIGHBOUR_GOALS = 4;

const MAX_NEIGHBOUR_PATHS = 4;

export interface PriorWorkInput {
  plan: Plan | null;
  parts: PlanPart[];
  appraisal: IssueAppraisal | null;
  conclusion: IssueConclusion | null;
  delivery: IssueDelivery | null;
  shortfall: IssueShortfall | null;
  entries: ScratchEntry[];
  files: GoalFile[];
  neighbours: GoalNeighbour[];
  forPart: boolean;
}

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

function padSection(entries: ScratchEntry[]): string {
  if (entries.length === 0) return '';
  const dropped = Math.max(0, entries.length - MAX_PAD_ENTRIES);
  const shown = dropped > 0 ? entries.slice(dropped) : entries;
  const testimony = padTestimony(shown);
  if (dropped === 0) return testimony;
  return `${testimony}\n\n(${dropped} earlier note${dropped === 1 ? '' : 's'} on this pad are not shown here — read them with scratch_read.)`;
}

function planSection(plan: Plan | null): string {
  if (!plan) return '';
  const lines: string[] = [];
  if (plan.diagnosis) lines.push(`**What the planner found was actually wrong:** ${plan.diagnosis}`);
  if (plan.approach) lines.push(`**What the planner said would be done about it:** ${plan.approach}`);
  if (plan.verification) lines.push(`**How the planner said we would know it worked:** ${plan.verification}`);
  if (plan.alternatives) lines.push(`**What the planner considered and rejected:** ${plan.alternatives}`);
  if (plan.openQuestions) lines.push(`**What the planner was least sure about:** ${plan.openQuestions}`);
  if (plan.risks) lines.push(`**What the planner thought could go wrong:** ${plan.risks}`);
  if (plan.outOfScope) lines.push(`**What the planner deliberately left out:** ${plan.outOfScope}`);
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
    'Written by the agents on this goal, most recently written first, and as the paths stood then.',
    '',
    ...lines,
  ].join('\n');
}

export function neighbourSeedPaths(files: GoalFile[], plan: Plan | null): string[] {
  return [...new Set([...files.map((f) => f.path), ...(plan?.evidence ?? []).map((e) => e.path)])];
}

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
