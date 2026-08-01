import { padTestimony } from '../retro/dossier.js';
import { liveParts } from '../plans/parts.js';
import type {
  IssueAssay,
  IssueConclusion,
  IssueDelivery,
  IssueShortfall,
  Plan,
  PlanPart,
  ScratchEntry,
} from '../types.js';

/**
 * What the earlier agents on a goal wrote down, rendered for the next one.
 *
 * ## The gap
 *
 * Every stage of a goal is a fresh agent with no memory of the last. The assayer
 * read the ticket against the repository; the planner read the repository and
 * argued for a shape; a part agent hit a constraint and wrote it on the pad — and
 * the agent dispatched after them starts from a template holding a title, a body
 * and a branch name, and pays again for everything the one before it learned. The
 * knowledge is not missing: it is in the store, and nothing hands it over. The
 * scratchpad's own doc says it is written "for whoever works this goal next", and
 * until now its only reader was the retrospective — the one agent on a goal that
 * does none of the work.
 *
 * ## The rule: only what no prompt already renders
 *
 * This is what keeps a briefing from becoming a second account of things the
 * harness already says, which is the drift this repo has paid for more than once.
 * Every field below is prose an agent wrote and no template renders:
 *
 * - **the pad**, read by `retroBriefing` alone until now;
 * - **`document` / `risks` / `outOfScope`** — the planner's write-up, which reaches
 *   the plan modal and no agent. On a `single` verdict that write-up is the *entire*
 *   product of a code agent that read the whole repository, and rule `issue-pickup`'s
 *   prompt is the issue title and body;
 * - **a part's `rationale` / `acceptance`** — declared by the planner, stored, and
 *   rendered nowhere at all;
 * - **the verdicts' prose** — an assay's summary, a conclusion's note, an
 *   assessment's finding either way.
 *
 * So it deliberately omits `plan.reason` (rendered by `currentPlanSummary` to a
 * replanner and as `{plan}` to a part agent), a part's status, branch and PR number
 * (`currentPlanSummary` and `siblingContext`), and **every world fact**: a pull
 * request's state is live through `world_read`, and pasted into a prompt it would
 * be a stale second reading of something the agent can ask about properly.
 *
 * ## Why it is bounded
 *
 * Appended text lands after the cached prefix, so a briefing is fresh input tokens
 * on every dispatch and only pays for itself if it displaces more rediscovery than
 * it costs. An empty goal renders the empty string and is filtered out, so a first
 * agent's prompt is byte-identical to one composed before this existed; the pad is
 * capped, and **what the cap dropped is named** rather than silently truncated, or
 * an agent reads a partial record as the whole one.
 */

/** Entries beyond this are dropped from the briefing — the oldest first, and said so. */
const MAX_PAD_ENTRIES = 15;

/**
 * The planner's write-up is prose a human was meant to read in full; in a prompt it
 * is the one field here with no natural bound. Truncation is marked, never silent.
 */
const MAX_DOCUMENT = 4000;

export interface PriorWorkInput {
  /** The plan for this goal, whatever its verdict — a `single` plan has a write-up too. */
  plan: Plan | null;
  parts: PlanPart[];
  assay: IssueAssay | null;
  /**
   * Null when the outstanding-work note already carries it: `outstandingForOrigin`
   * owns an agent's `more_work` declaration on an exact origin match, and one fact
   * rendered twice in one prompt reads as two.
   */
  conclusion: IssueConclusion | null;
  delivery: IssueDelivery | null;
  shortfall: IssueShortfall | null;
  entries: ScratchEntry[];
  /**
   * True when the dispatch is for a part of this plan. `plan-part` already renders
   * every sibling's intent through `siblingContext`, so repeating the parts section
   * there would be the duplication this module's whole rule exists to refuse.
   */
  forPart: boolean;
}

/**
 * Render the briefing, or the empty string when this goal has nothing to say yet.
 *
 * Pure, and it derives nothing: every line is a stored field quoted back.
 * `retroDossier`'s rule, for its reason — a verdict computed here would be a second
 * opinion about a decision made somewhere else, sitting nowhere near it.
 */
export function priorWorkBriefing(input: PriorWorkInput): string {
  const sections = [
    padSection(input.entries),
    planSection(input.plan),
    partsSection(input.forPart ? [] : input.parts),
    verdictSection(input),
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
 * cap the **oldest** go, because a goal's recent notes are the ones still true of
 * the code, and the drop is stated so a reader knows the record is partial.
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
  if (plan.risks) lines.push(`**What the planner thought could go wrong:** ${plan.risks}`);
  if (plan.outOfScope) lines.push(`**What the planner deliberately left out:** ${plan.outOfScope}`);
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

/**
 * Per-part intent. Only the two fields nothing else renders, and only for parts that
 * declared one — a heading over a list of parts saying nothing is worse than silence.
 */
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

/** The prose behind the verdicts standing on this goal — never the verdicts as a gate reads them. */
function verdictSection(input: PriorWorkInput): string {
  const lines: string[] = [];
  if (input.assay) {
    lines.push(`- **Assayed \`${input.assay.verdict}\`** by ${input.assay.by}: ${input.assay.summary}`);
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
