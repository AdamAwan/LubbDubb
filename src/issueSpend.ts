import type { Agent, IssueSpend, Task, WorkNode } from './types.js';
import { issueOrigin } from './plans/planning.js';

/**
 * What each goal has cost, rolled up from the `agents` rows.
 *
 * Cost is recorded per **agent** (`Store.recordAgentUsage`), and an agent knows
 * only the origin it was dispatched against. That origin is rarely the issue: the
 * planner runs on `issue:12:plan`, a part on `issue:12:part:auth`, and the agent
 * that fixes the part's failing checks on `pr:41:ci` — which names no issue at all.
 * So a goal's true cost is spread across origins in three shapes, and until this
 * existed nothing added them up.
 *
 * ## Two ways an origin reaches an issue
 *
 * **By name**, for everything under the `issue:<n>` subtree — the pickup root, the
 * planner, the assay, the assessment, the retro, every part. One regex, and it is
 * deliberately the whole subtree rather than the classified roles of
 * `issueOriginRole`: a planner that cost $4 and routed the goal to `single` spent
 * that money *on this goal*, whatever it did or did not build. Deliberation is
 * spend.
 *
 * **By lineage**, for everything else, through the durable work graph
 * (`src/graph/`). `pr:41`'s `parentRef` is the part or issue that produced it, and
 * a job's is the issue that adopted it — the edges the fold already computes. The
 * graph is used rather than the world because it *never forgets*: the world drops
 * a merged PR after `closedPrWindowMs`, and a goal's cost must not fall when its
 * pull requests age out of the open list. Sub-refs (`pr:41:ci`, `pr:41:comments`)
 * are reduced to the node they concern before the walk starts, since only `pr:41`
 * is ever a node.
 *
 * ## Unattributed is shipped, not swallowed
 *
 * An origin that reaches no issue — an operator's job nobody linked, an agent
 * dispatched against nothing — has its cost added to
 * {@link SpendRollup.unattributedCostUsd} rather than dropped. That is what keeps
 * the per-issue figures honest: they are a partition of the fleet's spend, and a
 * silently discarded remainder would let them read as complete while a new origin
 * shape quietly landed nowhere. A total climbing out of proportion to the goals
 * beneath it is the visible symptom that says so.
 */

/** Everything the roll-up reads — all three lists the snapshot already holds. */
interface SpendInput {
  agents: readonly Agent[];
  tasks: readonly Task[];
  /** The durable work graph: how a pull request's or a job's spend finds its goal. */
  nodes: readonly WorkNode[];
}

interface SpendRollup {
  /** Keyed on `issue:<n>`, the key `enrichIssue` and every verdict store already use. */
  byIssue: Map<string, IssueSpend>;
  /** Spend that reached no issue. Never folded into a goal, never dropped. */
  unattributedCostUsd: number;
  /**
   * Which goal each *measured* agent's spend was folded into, `null` for the ones
   * that reached none. Agent id → issue number; an agent that reported no usage
   * at all is absent, because it was never counted here either.
   *
   * Shipped as a by-product rather than recomputed downstream, and that is the
   * whole point of it: `buildSpendInsights` splits the same money a second way
   * (by phase), and a second walk of the lineage would be a second opinion about
   * which goal a pull request belongs to — free to disagree with the figure on the
   * card, silently, on exactly the origins the two readings classify differently.
   */
  attribution: Map<string, number | null>;
}

/** `issue:12`, `issue:12:plan`, `issue:12:part:auth` — the whole subtree is one goal's spend. */
const ISSUE_SUBTREE = /^issue:(\d+)(?::|$)/;

/** `pr:41:ci` and `pr:41:comments` are concerns *of* `pr:41`, which is the node. */
const PR_NODE = /^(pr:\d+)(?::|$)/;

/**
 * The pull request a `pr:*` origin concerns, or null for a ref that names none.
 *
 * One reduction, exported, because two modules need it for different ends — the
 * lineage walk below, and `buildCiHealth`'s per-pull-request CI spend, which joins
 * an agent's `pr:41:ci` origin to the `pr:41` its CI verdicts are recorded against.
 * Two regexes over one ref shape is the second opinion this module already refuses
 * to have about goal attribution.
 */
export function prNodeRefOf(originRef: string): string | null {
  return PR_NODE.exec(originRef)?.[1] ?? null;
}

/**
 * How far up the lineage the walk goes. `parent_ref` is write-once and therefore
 * acyclic by construction, so this is the belt to that brace — the same stance
 * `listWorkSubtree`'s `UNION` takes, and for the same reason: an accounting read
 * must not be the thing that hangs the cockpit.
 */
const MAX_HOPS = 12;

export function rollUpIssueSpend(input: SpendInput): SpendRollup {
  const originOfTask = new Map(input.tasks.map((t) => [t.id, t.originRef]));
  const parentOf = new Map(input.nodes.map((n) => [n.ref, n.parentRef]));
  const byIssue = new Map<string, IssueSpend>();
  const attribution = new Map<string, number | null>();
  let unattributedCostUsd = 0;

  for (const agent of input.agents) {
    // A runtime that reported nothing (PTY mode, or a run that ended before its
    // first `result`) contributes no row and no agent count — counting it would
    // put "3 agents · $0.00" on a goal three PTY agents have worked, which reads
    // as free rather than as unmeasured.
    if (agent.costUsd === null && agent.inputTokens === null && agent.outputTokens === null) continue;
    const cost = agent.costUsd ?? 0;
    const issueNumber = issueBehind(originOfTask.get(agent.taskId) ?? null, parentOf);
    attribution.set(agent.id, issueNumber);
    if (issueNumber === null) {
      unattributedCostUsd = roundUsd(unattributedCostUsd + cost);
      continue;
    }
    const ref = issueOrigin(issueNumber);
    const spend = byIssue.get(ref) ?? {
      originRef: ref,
      issueNumber,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      agents: 0,
    };
    spend.costUsd = roundUsd(spend.costUsd + cost);
    spend.inputTokens += agent.inputTokens ?? 0;
    spend.outputTokens += agent.outputTokens ?? 0;
    spend.agents += 1;
    byIssue.set(ref, spend);
  }
  return { byIssue, unattributedCostUsd, attribution };
}

/** The goal an origin's spend belongs to: by name if it can be, by lineage otherwise. */
function issueBehind(originRef: string | null, parentOf: ReadonlyMap<string, string | null>): number | null {
  let ref = originRef === null ? null : (prNodeRefOf(originRef) ?? originRef);
  for (let hop = 0; ref !== null && hop < MAX_HOPS; hop++) {
    const named = ISSUE_SUBTREE.exec(ref);
    if (named) return Number(named[1]);
    ref = parentOf.get(ref) ?? null;
  }
  return null;
}

/**
 * Sums of floats, kept to the cent-and-then-some the provider reports in. Without
 * this a handful of additions ships `0.30000000000000004` to the cockpit, which is
 * not wrong so much as unreadable — and rounding at the *sum* rather than at the
 * render keeps every reader of the wire agreeing on one figure.
 *
 * Exported because {@link rollUpIssueSpend} is not the only thing that adds these
 * up: `buildSpendInsights` sums the same money by phase and by day, and two
 * roundings of one currency is two answers to "what did this cost" that agree
 * until they don't.
 */
export function roundUsd(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
