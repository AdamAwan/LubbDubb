/**
 * Work the harness did that nothing external accounts for — stage 3's detector,
 * and the wording of the ticket that fixes it.
 *
 * ## The gap
 *
 * Stage 1 records what the harness did; stage 2 reads that record and writes
 * `delivered`, keyed on `issue:<n>`. Both are complete for work descending from a
 * tracker item and blind to work that does not. An operator job roots its own
 * tree: an agent runs, commits land, a PR may open and merge, and the only place
 * any of it is written down is a `jobs` row in the harness's own database.
 *
 * The consequence that matters is not untidiness. **Completion is read from the
 * tracker and never computed** — that is the line stages 1 and 2 both rest on — so
 * an item the tracker has never heard of has no terminal state available to it,
 * ever. It is not that the harness has the wrong answer; the question cannot be
 * asked.
 *
 * ## Detection is not a decision
 *
 * Nothing here files anything. A rule that created tracker items on its own would
 * be a new outbound capability on the world, larger than anything stages 1-2 took,
 * and the condition it fires on is *permanent until acted on* — so a throttle
 * would only set the rate at which somebody's backlog fills, and a filed ticket
 * has no undo. The mechanism stage 3 reuses (`POST /api/findings/:id/file`) is
 * defined by a human starting it; taking its plumbing while inverting its
 * authority model would keep the machinery and discard the argument.
 *
 * So this is a **lens**, the way `findings`, `overlaps`, `prAttention` and the
 * graph itself are: nothing in the dispatcher reads it, nothing gates on it, and
 * its only consumer is the route that draws the cockpit panel.
 */

import type { Job, WorkItemFiling, WorkItemFilingStatus, WorkNode } from '../types.js';

/** One node with no work item behind it, and the evidence beside the verdict. */
export interface UnrecordedWork {
  ref: string;
  title: string;
  /** PR nodes beneath it — what this work actually produced, if anything. */
  prCount: number;
  firstSeenAt: string;
  /** A filing already in flight, if one is. Null means the button is live. */
  filing: WorkItemFilingStatus | null;
  /** The operator said no ticket is wanted. Carried, not filtered — see below. */
  ignored: boolean;
}

/**
 * Which nodes have no work item behind them.
 *
 * A node qualifies when it is a `job` node still parented to nothing, whose job
 * is a **code** job that has been **dispatched**. Each narrowing earns its place:
 *
 * - **Code only.** A desk job touches no repository, so there is nothing about it
 *   a tracker item would record. This is the narrowing `detectFileOverlaps` makes
 *   for the same reason, and it is what stops the recursion *by construction*: a
 *   filing job is itself a desk job, so filing can never generate work that wants
 *   filing.
 * - **Dispatched only.** `queued` has done nothing yet and `cancelled` never will.
 * - **Parentless.** After the fold's two adoption arms, a job with a parent has a
 *   work item already — either the issue its own PR named, or one filed earlier.
 *
 * Deliberately *not* a condition: "produced a PR". Requiring one would mean the
 * harness only offers to record work it can already see, which is circular — the
 * invisible work is precisely the work that left no PR behind. `prCount` carries
 * that evidence *beside* the verdict instead, so the operator's click is informed
 * while the predicate stays binary and the judgement stays theirs.
 *
 * A node whose filing is **in flight** stays in the set carrying that status;
 * dropping it would make the click look like it did nothing. One whose filing has
 * *linked* leaves on its own and needs no special case — the link set its parent,
 * and a parented node is not unrecorded.
 *
 * An **ignored** node stays in the set too, carrying `ignored`, for the same
 * reason: the predicate is what the panel draws *and* what the file route refuses
 * on, so filtering here would leave the two disagreeing about whether the node
 * exists — the drift class this codebase pays for by asking one predicate twice.
 * Hiding an ignored row is a display decision and is made in the panel, which is
 * also what keeps the un-ignore reachable: a row filtered out at the source has no
 * title left to offer back.
 *
 * `jobs` is a parameter rather than something read off the node because the fold
 * records a job's `status` and not its `kind`, and smuggling code-vs-desk through
 * a display field to save a join would make the node lie about what `status`
 * means. Consequence, stated: `Store.listJobs()` is capped, so a job older than
 * that window drops out — the same window the fold itself already lives in.
 */
export function unrecordedWork(
  nodes: WorkNode[],
  jobs: Job[],
  filings: WorkItemFiling[],
  ignoredRefs: string[] = [],
): UnrecordedWork[] {
  const jobById = new Map(jobs.map((j) => [j.id, j]));
  const filingFor = new Map(filings.map((f) => [f.targetRef, f]));
  const ignored = new Set(ignoredRefs);

  const prsUnder = new Map<string, number>();
  for (const n of nodes) {
    if (n.kind !== 'pr' || n.parentRef === null) continue;
    prsUnder.set(n.parentRef, (prsUnder.get(n.parentRef) ?? 0) + 1);
  }

  const out: UnrecordedWork[] = [];
  for (const n of nodes) {
    if (n.kind !== 'job' || n.parentRef !== null) continue;
    const job = jobById.get(n.ref.slice('job:'.length));
    if (!job || job.kind !== 'code' || job.status !== 'dispatched') continue;
    out.push({
      ref: n.ref,
      title: n.title,
      prCount: prsUnder.get(n.ref) ?? 0,
      firstSeenAt: n.firstSeenAt,
      filing: filingFor.get(n.ref)?.status ?? null,
      ignored: ignored.has(n.ref),
    });
  }
  return out;
}

/** How long a filing job's title may be before it stops being a title. */
const MAX_TITLE = 80;

/**
 * The values the `work-item-ticket` prompt is rendered with — pure, so the wording
 * an agent acts on is testable without a server and the route is left with
 * `render` + `createJob`. The mirror of `findingTicketFields`, and deliberately
 * the same shape: `title` is the *job's*, not the ticket's, because the ticket's
 * title is the judgement being delegated and this one only has to be recognisable
 * in the Up next queue.
 */
export function workItemTicketFields(
  node: WorkNode,
  subtree: WorkNode[],
  tracker: string,
): { title: string; vars: Record<string, string> } {
  const produced = subtree
    .filter((n) => n.ref !== node.ref)
    .map((n) => `- ${n.ref} (${n.kind}) — ${n.title} [${n.status}${n.provenance ? `, ${n.provenance}` : ''}]`);
  return {
    title: `File work item: ${node.title}`.slice(0, MAX_TITLE),
    vars: {
      ref: node.ref,
      workTitle: node.title,
      // A merge the harness only *inferred* is weaker evidence than one it
      // watched, which stage 1 recorded the distinction specifically to preserve.
      produced: produced.length ? produced.join('\n') : 'Nothing the harness could observe — no pull request opened.',
      tracker,
    },
  };
}
