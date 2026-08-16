import { padTestimony } from '../retro/dossier.js';
import { liveParts } from '../plans/parts.js';
import type {
  GoalFile,
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
 * - **the planner's whole narrative** — `diagnosis`, `approach`, `verification`,
 *   `alternatives`, `openQuestions`, `evidence`, `risks`, `outOfScope` and the
 *   write-up, all of which reach the plan sheet and no agent. On a `single` verdict
 *   that narrative is the *entire* product of a code agent that read the whole
 *   repository, and rule `issue-pickup`'s prompt is the issue title and body;
 * - **a part's `rationale` / `acceptance`** — declared by the planner, stored, and
 *   rendered nowhere at all;
 * - **the verdicts' prose** — an assay's summary, a conclusion's note, an
 *   assessment's finding either way;
 * - **the paths the goal has been edited in**, the one entry here that is not prose
 *   an agent wrote. It is the cheapest orientation there is — it turns a grep phase
 *   into a Read — and no template renders it either.
 *
 * So it deliberately omits `plan.reason` (rendered by `currentPlanSummary` to a
 * replanner and as `{plan}` to a part agent), a part's status, branch and PR number
 * (`currentPlanSummary` and `siblingContext`), and **every world fact**: a pull
 * request's state is live through `world_read`, and pasted into a prompt it would
 * be a stale second reading of something the agent can ask about properly.
 *
 * ## Where the file list sits against those two rules
 *
 * It is the one section that is stored *fields* rather than stored prose, so both
 * rules are answered here rather than left to be re-argued (issue #354).
 *
 * **"It derives nothing"** still holds: a path is `agent_files.path` quoted back and
 * the grouping is a join — which agents worked this goal, and which of them wrote a
 * path last. What must never appear is ranking, relevance scoring or "the files you
 * probably want", which would be exactly the second opinion about somebody else's
 * decision that this module and `retroDossier` both refuse. The order is recency,
 * which is a stored timestamp, not a judgement about importance.
 *
 * **"Every world fact is omitted"** also holds, because a touched-path list is not
 * one. A pull request's state is a fact about the world *now*, which `world_read`
 * answers better than a paste can; this is a fact about **the goal's own history** —
 * where its agents have already been — exactly like the pad, and no live tool
 * answers it. What it is not is a claim about the branch this dispatch is on: a path
 * written on a sibling's branch may not exist here, and a later rename leaves the
 * record pointing at nothing. That is testimony going stale, which the heading's own
 * framing already covers, so the section inherits that sentence rather than writing
 * a softer one of its own.
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

/**
 * Paths beyond this are dropped — the oldest first, and said so, `MAX_PAD_ENTRIES`'s
 * rule for its reason. Higher than the pad's because a line here is a path rather
 * than a paragraph, and lower than it deserves to look: this is the section that
 * scales with the *size* of the work rather than with what anyone chose to write
 * down, and a goal that has been through twelve parts would otherwise spend more of
 * the briefing on a file index than on the reasoning behind it.
 */
const MAX_FILE_PATHS = 25;

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
  /** Newest write first, one row per path — `Store.listGoalFiles`. */
  files: GoalFile[];
  /**
   * True when the dispatch is for a part of this plan. `plan-part` already renders
   * every sibling's intent through `siblingContext`, so repeating the parts section
   * there would be the duplication this module's whole rule exists to refuse.
   *
   * It suppresses the parts section and **nothing else**. In particular the file
   * list stays on for a part dispatch: `siblingContext` renders what a sibling was
   * *for*, and nowhere renders where it has been — so a part agent is the reader
   * with the most to gain from it, not the one to withhold it from.
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
    filesSection(input.files),
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
  // The two the planner read the whole repository to write, and the two no prompt
  // renders — `currentPlanSummary` carries `reason` and stops there. On a `single`
  // verdict the agent picking the issue up is otherwise told only its title and body.
  if (plan.diagnosis) lines.push(`**What the planner found was actually wrong:** ${plan.diagnosis}`);
  if (plan.approach) lines.push(`**What the planner said would be done about it:** ${plan.approach}`);
  // The one an agent picking the work up can *act* on: it is the test the work
  // will be judged by, and an agent told it beforehand is being told what finished
  // means rather than being asked to guess it.
  if (plan.verification) lines.push(`**How the planner said we would know it worked:** ${plan.verification}`);
  if (plan.alternatives) lines.push(`**What the planner considered and rejected:** ${plan.alternatives}`);
  if (plan.openQuestions) lines.push(`**What the planner was least sure about:** ${plan.openQuestions}`);
  if (plan.risks) lines.push(`**What the planner thought could go wrong:** ${plan.risks}`);
  if (plan.outOfScope) lines.push(`**What the planner deliberately left out:** ${plan.outOfScope}`);
  // Cited so the agent can start where the planner finished rather than re-reading
  // the repository to find the same lines. Rendered flat: the briefing is appended
  // prose, and a nested list of links would be the only structure in it.
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

/**
 * Where this goal's work has actually been: one line per path, most recent write
 * first, attributed to the origin that made it.
 *
 * **Last**, because it is the index and everything above it is the argument — an
 * agent that reads only the top of a long briefing should get the reasoning, and
 * one that has read the reasoning is exactly who a list of paths is useful to.
 *
 * **Promoted paths are in it, unmarked.** `agent_files.promoted` distinguishes a
 * report from a code change, and both are places this goal has been written; a
 * written-up report is often the first thing worth reading, and `docs/…/x.md`
 * against `src/x.ts` already says which is which. Marking it would be a second
 * account of what the path already states.
 *
 * **No note about staleness here.** The heading above says these are as old as their
 * timestamps and that the repository is the truth — which is the same warning a
 * renamed or sibling-branch path needs, and repeating it softer would let the two
 * readings drift.
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
    // Not "the agents above": this section renders on a goal whose only record is
    // its file rows, and there is nothing above it there.
    'Written by the agents on this goal, most recently written first, and as the paths stood then.',
    '',
    ...lines,
  ].join('\n');
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
