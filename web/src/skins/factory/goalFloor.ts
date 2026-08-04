import type { Issue, Plan, PlanPart, PullRequest, QueueItem, Task, WorkNodeView } from '../../types.js';
import { watchBucket } from '../../worldBuckets.js';
import { scannersFor, type Scanner } from './scanners.js';
import {
  assayStatus,
  assemblerStatus,
  crateMachineStatus,
  furnaceStatus,
  launchStatus,
  manifestStatus,
  patchStatus,
  prMachineStatus,
  satelliteStatus,
  signalPostStatus,
  siloStatus,
  UNBUILT,
  type FloorStage,
  type MachinePresence,
  type MachineStatus,
  type LaunchReading,
  type PartProgress,
  type PrMachineReading,
  type SatelliteReading,
  type StatusCommentReading,
} from './vocabulary.js';

/**
 * One goal, drawn as a production line: ticket → assay → plan → parts → checks →
 * merge → goal check → ticket update → done.
 *
 * Pure, and separate from the component, for the reason `techTree.ts` was — the
 * interesting part is the layout and the interesting part is what wants testing —
 * and this module *is* that file, moved: `stateOf` is {@link partProgress} and
 * `depths` is subsumed by {@link layoutFloor}'s longest-path column. Keeping both
 * would have left two components deriving a part's state from `PlanPart.status`
 * independently, which is the drift class this codebase has already paid for
 * twice.
 *
 * Two things are deliberately apart here:
 *
 * - **Position comes from structure alone.** {@link layoutFloor} sees refs and
 *   dependency edges and nothing else — no status, no tone, no timestamp — and is
 *   memoised on the shape, so a machine moves only when a part appears, is
 *   retired or opens a pull request. Without the split a floor is re-laid on
 *   every poll and jitters exactly when an operator is watching it most closely,
 *   which is when something is going wrong.
 * - **Every machine is a work item.** A splitter and a merger have no status, no
 *   agent and no origin ref — they are where the edge list branches — so they are
 *   belt *fixtures* rather than machines. Drawing one as a machine also stretches
 *   it to the full height of the fan-out, which is the same mistake showing up as
 *   a visual bug.
 */

/* ------------------------------ the strip ----------------------------- */

/**
 * The statuses that mean the harness has this goal in hand *now*, whatever its
 * tags say. Also the default pick's heuristic — a floor with nothing moving on it
 * is the least useful thing to land on — so the filter below and the pick read one
 * set rather than two that agree by coincidence.
 */
const IN_PRODUCTION = new Set(['active', 'has_pr', 'planning', 'delivered']);

export function inProduction(issue: Issue): boolean {
  return IN_PRODUCTION.has(issue.pickup?.status ?? '');
}

/**
 * A run the operator has not ended (issues #203, #234) — the retention that stops
 * a goal (and the one way in to its report) vanishing when the tracker forgets
 * the issue or its watch tag comes off. Dismissal is what removes it, and only
 * that: no pulse, poll or ticket close drops one.
 *
 * True for an unfinished run too, which is the #234 change: a goal the harness
 * worked and nobody finished is exactly the one an operator has to be able to see
 * in order to abandon it.
 */
export function retainedRun(issue: Issue): boolean {
  return Boolean(issue.run) && !issue.run!.dismissed;
}

/**
 * Which goals get a floor, and in what order.
 *
 * Issues are **opt-in**, so an untagged ticket is one nothing has staked a claim
 * to: it has no production line, and drawing a full one for it claims machines
 * that were never built. The strip listed every open issue the provider returned,
 * which on a real world is mostly those.
 *
 * Three things decide it, and each is why something here is not simply "filter on
 * the tag":
 *
 * - **Gates off wins first.** An empty watch label is the documented
 *   act-on-everything escape hatch (`labelPrefix: ''`), and issues default
 *   *opt-out*, so filtering there would hide every goal on exactly the deployments
 *   that turned the gate off. `WorldSummary`'s `gated` check exists for the same
 *   reason, and reads *either* label because it files rows into three tabs; the
 *   watch label alone is what decides this one, since with none there is nothing a
 *   claim could be staked with.
 * - **A claim is {@link watchBucket}'s answer**, the World panel's own predicate,
 *   rather than a second reading of the same labels sitting nowhere near it.
 * - **In-flight work is drawn whatever the tags say.** A `-watch` tag removed
 *   mid-flight must not make a live plan, an open pull request or a running agent
 *   invisible — the work carries on either way, and the floor is where it is seen.
 *   That covers `ignored` as well as `unwatched`: the reason is the visibility of
 *   live work, not the tag's polarity.
 *
 * Order is claimed goals first, then **ascending issue number** within each group.
 * The strip is a place an operator learns positions in, so it is sorted on the two
 * things that barely move; ordering by status or activity would shuffle it under
 * them exactly while something is going wrong.
 */
export function floorGoals(issues: readonly Issue[], gate: { watchLabel: string; ignoreLabel: string }): Issue[] {
  const gated = Boolean(gate.watchLabel);
  const claimed = (issue: Issue): boolean =>
    !gated || watchBucket(issue.labels, { ...gate, defaultWatched: false }) === 'watched';
  // Four ways onto the strip, and the order of the checks is the point:
  // - **in-flight work is always drawn** (see the docstring), and a dismissed run
  //   whose goal re-enters production is exactly that, so this comes first;
  // - a **dismissed** run that is *not* back in production is hidden — the
  //   operator ended it, and since #234 that ends the harness's interest in it too,
  //   so there is nothing left for the floor to draw;
  // - otherwise a **claimed** goal or a **retained run** is drawn: the former is
  //   today's rule, the latter is the retention keeping a goal (and its report) on
  //   the floor after the world forgot the issue.
  const show = (issue: Issue): boolean => {
    if (inProduction(issue)) return true;
    if (issue.run?.dismissed) return false;
    return claimed(issue) || retainedRun(issue);
  };
  return issues.filter(show).sort((a, b) => Number(claimed(b)) - Number(claimed(a)) || a.number - b.number);
}

/* ------------------------------- layout ------------------------------- */

interface FloorEdge {
  from: string;
  to: string;
}

/** Where one machine stands: dependency depth across, branch down. */
interface FloorSlot {
  column: number;
  lane: number;
}

interface FloorLayout {
  slots: Map<string, FloorSlot>;
  columns: number;
  lanes: number;
}

/** Bounded so a session that opens every goal in a large world does not retain them all. */
const LAYOUT_CACHE_MAX = 24;
const layoutCache = new Map<string, FloorLayout>();

/**
 * `(column, lane)` per machine, from refs and dependency edges alone.
 *
 * Column is **longest-path depth**, not the depth of the first prerequisite that
 * happens to be listed: a part waiting on several must never draw to the left of
 * something it waits on, and `dependsOn[0]` gets exactly that wrong the first
 * time a plan rejoins. This was written to tolerate **in-degree greater than one**
 * before the schema could emit it; #170 relaxed the arity cap at the plan
 * document's zod boundary, and — as intended — the drawing needed no change for a
 * rejoining plan to lay out correctly.
 *
 * Cycle-guarded for the reason the tech tree's walk was: the server refuses
 * cycles at ingestion, but this runs against whatever a snapshot happens to
 * carry, and a cockpit that hangs is a worse failure than one that draws a cycle
 * flat.
 *
 * Lanes are assigned in the order refs are given, which is the caller's own
 * structural order (`seq`), so the same graph lays out the same way every time.
 */
export function layoutFloor(refs: readonly string[], edges: readonly FloorEdge[]): FloorLayout {
  const key = `${refs.join('|')}>>${edges
    .map((e) => `${e.from}->${e.to}`)
    .sort()
    .join('|')}`;
  const hit = layoutCache.get(key);
  if (hit) return hit;

  const present = new Set(refs);
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    if (!present.has(edge.from) || !present.has(edge.to)) continue;
    const list = incoming.get(edge.to);
    if (list) list.push(edge.from);
    else incoming.set(edge.to, [edge.from]);
  }

  const depth = new Map<string, number>();
  const walking = new Set<string>();
  const depthOf = (ref: string): number => {
    const cached = depth.get(ref);
    if (cached !== undefined) return cached;
    if (walking.has(ref)) return 0;
    walking.add(ref);
    let deepest = 0;
    for (const from of incoming.get(ref) ?? []) deepest = Math.max(deepest, depthOf(from) + 1);
    walking.delete(ref);
    depth.set(ref, deepest);
    return deepest;
  };

  const filled = new Map<number, number>();
  const slots = new Map<string, FloorSlot>();
  for (const ref of refs) {
    const column = depthOf(ref);
    const lane = filled.get(column) ?? 0;
    filled.set(column, lane + 1);
    slots.set(ref, { column, lane });
  }

  const layout: FloorLayout = {
    slots,
    columns: Math.max(1, ...[...slots.values()].map((s) => s.column + 1)),
    lanes: Math.max(1, ...[...slots.values()].map((s) => s.lane + 1)),
  };
  if (layoutCache.size >= LAYOUT_CACHE_MAX) layoutCache.clear();
  layoutCache.set(key, layout);
  return layout;
}

/**
 * Where the belt divides and where it rejoins, from the edge list alone.
 *
 * A fixture is not a machine: it has no status, no agent and no origin ref, so it
 * carries only the node it hangs off and which side of it the branching is on.
 */
interface FloorFixture {
  /** The machine the fixture sits after (`splitter`) or before (`merger`). */
  ref: string;
  kind: 'splitter' | 'merger';
}

export function floorFixtures(edges: readonly FloorEdge[]): FloorFixture[] {
  const out = new Map<string, number>();
  const inn = new Map<string, number>();
  for (const e of edges) {
    out.set(e.from, (out.get(e.from) ?? 0) + 1);
    inn.set(e.to, (inn.get(e.to) ?? 0) + 1);
  }
  const fixtures: FloorFixture[] = [];
  for (const [ref, n] of out) if (n > 1) fixtures.push({ ref, kind: 'splitter' });
  for (const [ref, n] of inn) if (n > 1) fixtures.push({ ref, kind: 'merger' });
  return fixtures;
}

/* ------------------------------ the fold ------------------------------ */

/**
 * A part's progress, one-way from `PlanPart.status`, so nothing here can disagree
 * with the plan panel about whether a part is done.
 *
 * Both terminals read as `shipped` — a concluded part produced a write-up or a
 * determination rather than a merge, and there is nothing left to wait for. That
 * is `partSettled` on the server, asked the same way and for the same reason:
 * every `=== 'merged'` that meant *reached its terminal* has to go through one
 * predicate or they drift into disagreeing about what done is.
 */
export function partProgress(part: PlanPart): PartProgress {
  switch (part.status) {
    case 'merged':
    case 'concluded':
      return 'shipped';
    case 'in_review':
    case 'dispatched':
      return 'building';
    case 'ready':
      return 'ready';
    case 'blocked':
      return 'blocked';
    default:
      return 'locked';
  }
}

/**
 * `retired` is excluded rather than drawn greyed, matching `liveParts` on the
 * server: a replan that dropped a part dropped it, and showing it would imply the
 * plan still owes that work.
 */
function isLive(part: PlanPart): boolean {
  return part.status !== 'retired';
}

/* ------------------------------ the floor ----------------------------- */

export interface Machine {
  ref: string;
  kind: FloorStage;
  /** The stage's name in the factory's vocabulary — `Assembler · 2`, `Furnace`. */
  kindLabel: string;
  /** The work item's own title, or the stage's subject. */
  name: string;
  /** Structural detail lines. Never a reason: a reason goes on a plate, verbatim. */
  meta: string[];
  presence: MachinePresence;
  status: MachineStatus;
  /** Quality gates on this machine's pull request; empty everywhere else. */
  scanners: Scanner[];
  /** A `#n` to link, when this machine has a pull request behind it. */
  prNumber: number | null;
  /**
   * Something else this machine can open, as a ref to look up in `refUrls` under a
   * caption of its own — today only the signal post's status comment (#171),
   * whose ref (`issue:12:comment:456`) is machinery rather than something to
   * print. Null everywhere else, and never set beside `prNumber`: they share one
   * corner of the node, and a machine claiming two ways out would draw one over
   * the other.
   */
  link: { ref: string; label: string } | null;
  /** The silo's fill, 0–1. Null on every other machine. */
  fill: number | null;
  siloLabel: string | null;
}

/**
 * A reason plate: what a stopped machine is stopped for, **in the harness's own
 * words**.
 *
 * `text` is always a string the server already computed — an assay summary, a
 * planner's reason, a health reason, a queue item's reason. Nothing here
 * assembles prose and nothing parses any, for `signalPolarity`'s reason: a
 * summary is written for a human and nobody promised to keep its wording stable.
 */
interface FloorPlate {
  who: string;
  tone: MachineStatus['tone'];
  text: string;
  /** A shortfall's declared route, which is the one plate that points backwards. */
  route: string | null;
  /**
   * The issue whose intake verdict this plate can override, and null on every
   * other plate — including a `workable` one, which draws no plate at all.
   *
   * A field rather than the component reading `floor.issueNumber` off the model:
   * the floor always knows its issue, so a component-side test for "is this the
   * assay plate" would be a second answer to a question this file already
   * decided, and the first `workable` plate anyone adds would silently grow an
   * override for a verdict that blocks nothing.
   */
  assayIssue: number | null;
}

export interface GoalFloorModel {
  issueNumber: number;
  title: string;
  machines: Machine[];
  edges: FloorEdge[];
  fixtures: FloorFixture[];
  layout: FloorLayout;
  plates: FloorPlate[];
  /**
   * The plan behind this floor — the floor's one way into the shared modal, and
   * its Replan control.
   *
   * On the *floor* rather than on a plate, because a plate is a stopped machine's
   * reason and every reason is transient: the Blueprint plate that used to carry
   * these controls draws only while a decomposition is `awaiting_approval`, so
   * approving a plan was the moment its record stopped being readable. What the
   * plan is doing belongs to the furnace machine; whether there *is* one is a fact
   * about the floor.
   */
  planId: string | null;
  /**
   * The goal whose shared notepad can be opened, as an `issue:<n>` ref, or null
   * when the agents on it wrote nothing.
   *
   * Keyed on the pad **having entries**, for `retroRef`'s reason: the notepad is
   * written during the work and read long after it, so it must not stop being
   * reachable when the floor changes status. It is the raw testimony beside the
   * Manifest's write-up, and it exists on goals no retrospective was ever written
   * for — a run still going, or one that failed before anything wrote it up.
   */
  padRef: string | null;
  /**
   * The goal whose retrospective can be opened, as an `issue:<n>` ref, or null
   * when nobody has written one.
   *
   * Keyed on the retrospective **existing**, never on what the floor is doing —
   * the lesson `planId` was moved off the Blueprint plate to learn. A write-up is
   * a standing record; the moment it stops being readable must not be the moment
   * the machine that produced it changes status.
   */
  retroRef: string | null;
}

interface GoalFloorInput {
  issue: Issue;
  plan: Plan | null;
  /** Every part of {@link GoalFloorInput.plan}, retired ones included. */
  parts: PlanPart[];
  openPrs: PullRequest[];
  closedPrs: PullRequest[];
  tasks: Task[];
  upcoming: QueueItem[];
  /**
   * The durable record for this issue, fetched once when the floor was opened.
   * It may only **add** settled machines the world has forgotten — a PR merged
   * past `closedPrWindowMs`. The snapshot wins wherever both speak, and that one
   * line is the whole of the merge: two sources each partly owning a field is how
   * they start disagreeing.
   */
  recorded: WorkNodeView[];
}

const issueOrigin = (n: number): string => `issue:${n}`;
const partOrigin = (n: number, slug: string): string => `issue:${n}:part:${slug}`;

/**
 * The signal post's second meta line, one string per reading.
 *
 * The line is the *reading* and is drawn whatever the provider can resolve; the
 * machine's `link` beside it is the way in, and appears only when there is a URL
 * (#171). Keeping them apart is what lets a plan under a provider that builds no
 * URLs still say it has posted a notice, without offering a link to nowhere.
 */
const COMMENT_META: Record<StatusCommentReading, string> = {
  written: 'status comment · written',
  unwritten: 'status comment · none written',
  no_plan: 'no plan · no status comment to write',
};

/** The launch's name and line, one per reading — see {@link LaunchReading}. */
const LAUNCH_NAMES: Record<LaunchReading, string> = {
  away: 'Delivered',
  returned: 'Failed verification',
  unbuilt: 'Not launched',
};
const LAUNCH_META: Record<LaunchReading, string> = {
  away: 'pickup held · reversible',
  returned: 'returned by the assessor',
  unbuilt: 'no goal check yet',
};

/**
 * Three readings, not two. A plan that has written no comment yet has a writer
 * that has not spoken; an unplanned issue has no writer at all, which is a
 * different fact and gets different words.
 */
function statusCommentReading(plan: Plan | null): StatusCommentReading {
  if (!plan) return 'no_plan';
  return plan.statusCommentRef ? 'written' : 'unwritten';
}

export function buildGoalFloor(input: GoalFloorInput): GoalFloorModel {
  const { issue, plan, openPrs, closedPrs, tasks, upcoming, recorded } = input;
  const n = issue.number;
  const parts = input.parts
    .filter(isLive)
    .slice()
    .sort((a, b) => a.seq - b.seq);
  const machines: Machine[] = [];
  const edges: FloorEdge[] = [];
  const plates: FloorPlate[] = [];

  const prByNumber = new Map<number, PullRequest>();
  for (const pr of [...closedPrs, ...openPrs]) prByNumber.set(pr.number, pr);
  const recordedPr = new Map<string, WorkNodeView>(recorded.filter((r) => r.kind === 'pr').map((r) => [r.ref, r]));
  const queued = new Map(upcoming.map((q) => [q.origin, q]));
  // The same three statuses `isActiveTask` calls outstanding. It used to read
  // `'active' || 'queued'`, and `active` is not a `TaskStatus` — so a running or
  // waiting agent left its station drawn as unstaffed, and only the window
  // between the task row and the spawn ever lit up.
  const activeOrigins = new Set(
    tasks
      .filter((t) => t.status === 'queued' || t.status === 'running' || t.status === 'waiting')
      .map((t) => t.originRef ?? ''),
  );

  // -- the patch ---------------------------------------------------------
  const patchRef = issueOrigin(n);
  const pickupStatus = issue.pickup?.status ?? 'eligible';
  machines.push({
    ref: patchRef,
    kind: 'patch',
    kindLabel: 'Ore patch',
    name: issue.title,
    meta: [`${patchRef}${issue.workItemState ? ` · ${issue.workItemState}` : ''}`],
    presence: 'built',
    status: patchStatus(pickupStatus),
    scanners: [],
    prNumber: null,
    link: null,
    fill: null,
    siloLabel: null,
  });

  // -- the assay drill ---------------------------------------------------
  //
  // Absent is not stopped: a goal nothing has assayed has **no drill on the
  // floor**, while one refused at intake has a drill that is stopped and carries
  // the reason it wrote on the ticket. Collapsing the two would put #158 back.
  const assay = issue.assay ?? null;
  let head = patchRef;
  if (assay) {
    const assayRef = `${patchRef}:assay`;
    machines.push({
      ref: assayRef,
      kind: 'assay',
      kindLabel: 'Assay',
      name: assay.verdict === 'workable' ? 'Goal is workable' : 'Goal unclear',
      meta: [`rule issue-assay · by ${assay.by}`],
      presence: 'built',
      status: assayStatus(assay.verdict),
      scanners: [],
      prNumber: null,
      link: null,
      fill: null,
      siloLabel: null,
    });
    edges.push({ from: head, to: assayRef });
    head = assayRef;
    if (assay.verdict === 'unclear') {
      plates.push({
        who: 'Assay · refused',
        tone: 'bad',
        text: assay.summary,
        route: null,
        assayIssue: n,
      });
    }
  }

  // -- the furnace -------------------------------------------------------
  //
  // Drawn even when there is no plan: a floor whose furnace was never reached
  // says so, which is what makes the refusal above legible as a *stop* rather
  // than as the funnel simply being off.
  const refused = assay?.verdict === 'unclear';
  const furnaceRef = `${patchRef}:plan`;
  machines.push({
    ref: furnaceRef,
    kind: 'furnace',
    kindLabel: 'Furnace',
    name: plan ? furnaceName(plan, parts.length) : refused ? 'Never reached' : 'Nothing smelted',
    meta: plan ? [`plan · ${plan.status.replace(/_/g, ' ')}`] : ['—'],
    presence: plan ? 'built' : 'unbuilt',
    status: plan ? furnaceStatus(plan.status) : { word: 'Unbuilt', tone: 'off' },
    scanners: [],
    prNumber: null,
    link: null,
    fill: null,
    siloLabel: null,
  });
  edges.push({ from: head, to: furnaceRef });

  if (plan?.reason && plan.status === 'awaiting_approval') {
    plates.push({ who: 'Blueprint', tone: 'ghost', text: plan.reason, route: null, assayIssue: null });
  }

  // -- the assembly floor ------------------------------------------------
  //
  // A part's pull request is folded onto the part rather than drawn beside it:
  // the part is the work item and the PR is what it produced, so a column is a
  // dependency step and not every other thing on the line.
  const ghostPlan = plan?.status === 'awaiting_approval';
  const bySlug = new Map(parts.map((p) => [p.slug, p]));
  const terminals: string[] = [];
  // The `single` arm's one pull request, hoisted so the silo below counts the
  // same PR the machine drew rather than looking it up a second way.
  const singlePr = issue.linkedPrNumber ? (prByNumber.get(issue.linkedPrNumber) ?? null) : null;
  const singleRef = issue.linkedPrNumber ? `pr:${issue.linkedPrNumber}` : null;

  if (parts.length > 0) {
    const settled = new Set(parts.filter((p) => partProgress(p) === 'shipped').map((p) => p.slug));
    const dependents = new Set<string>();
    for (const part of parts) for (const dep of part.dependsOn) if (bySlug.has(dep)) dependents.add(dep);

    parts.forEach((part, i) => {
      const ref = partOrigin(n, part.slug);
      const live = part.dependsOn.filter((d) => bySlug.has(d));
      for (const dep of live) edges.push({ from: partOrigin(n, dep), to: ref });
      if (live.length === 0) edges.push({ from: furnaceRef, to: ref });
      if (!dependents.has(part.slug)) terminals.push(ref);

      const pr = part.prNumber ? (prByNumber.get(part.prNumber) ?? null) : null;
      const progress = partProgress(part);
      const held = queued.get(ref);
      machines.push({
        ref,
        kind: 'assembler',
        kindLabel: `Assembler · ${i + 1}`,
        name: part.title,
        meta: [
          `recipe: ${part.scope}`,
          outcomeLine(part),
          ...(live.length > 0 ? [`waits on: ${live.join(' + ')}`] : []),
          ...(activeOrigins.has(ref) && part.branch ? [`bot on ${part.branch}`] : []),
          // The record's only job: a PR the world has forgotten is still a thing
          // that happened, and without this the machine draws a number with
          // nothing behind it. It adds a line; it never contradicts one.
          ...(part.prNumber && !pr && recordedPr.has(`pr:${part.prNumber}`) ? ['merged · off the record'] : []),
        ],
        presence: ghostPlan || progress === 'locked' ? 'ghost' : 'built',
        // A part the queue is holding says *why it is held*, in the queue's own
        // words, rather than "ready to start" beside a bot that is never coming.
        // A limit you cannot see looks exactly like an idle fleet, which is the
        // invisibility `capped` and `unapproved` were added to `QueueItem` to fix
        // — so the crate's vocabulary is reused here rather than restated.
        //
        // The ghost wins over the queue: every part of an unapproved plan is
        // `ready` *and* queued `unapproved`, and letting the queue answer would
        // give siblings two different tones for one fact.
        status:
          !ghostPlan && held && held.status !== 'dispatching' && progress === 'ready'
            ? crateMachineStatus(held, false)
            : assemblerStatus(progress, {
                ghost: ghostPlan,
                ahead: live.filter((d) => !settled.has(d)).length,
              }),
        // Checks on a settled pull request are history: the merge happened, and
        // a row of green scanners under it says nothing an operator can act on.
        scanners: pr && progress !== 'shipped' ? scannersFor(pr, { withReview: true }) : [],
        prNumber: part.prNumber,
        link: null,
        fill: null,
        siloLabel: null,
      });
      if (pr) plates.push(...prPlates(pr));
      // A jammed assembler is the one stopped machine whose reason is on its own
      // row: it is never queued, so the `held` arm below cannot speak for it, and
      // it has no pull request for `prPlates` to read. Without this it drew a red
      // word and nothing else. Verbatim, like every other plate.
      if (!ghostPlan && progress === 'blocked' && part.blockedReason) {
        plates.push({
          who: `Assembler · ${i + 1}`,
          tone: 'bad',
          text: part.blockedReason,
          route: null,
          assayIssue: null,
        });
      }
      // An unapproved plan already has one plate saying so; a plate per ghost
      // part would be the same sentence three times.
      if (!ghostPlan && held && held.status !== 'dispatching') {
        plates.push({
          who: `Assembler · ${i + 1}`,
          tone: 'warn',
          text: held.reason,
          route: null,
          assayIssue: null,
        });
      }
    });
  } else if (singleRef && issue.linkedPrNumber) {
    // The `single` arm, and the unplanned one: no assembler, because there is no
    // part — the pull request is the work item itself.
    const reading = singlePr ? prReading(singlePr) : recordedPr.has(singleRef) ? 'shipped' : 'on_the_pad';
    machines.push({
      ref: singleRef,
      kind: 'pr',
      kindLabel: 'Pull request',
      name: singlePr?.title ?? recordedPr.get(singleRef)?.title ?? `PR #${issue.linkedPrNumber}`,
      meta: [singlePr?.branch ? `branch ${singlePr.branch}` : 'no longer in the world'],
      presence: 'built',
      status: prMachineStatus(reading),
      scanners: singlePr ? scannersFor(singlePr, { withReview: true }) : [],
      prNumber: issue.linkedPrNumber,
      link: null,
      fill: null,
      siloLabel: null,
    });
    edges.push({ from: furnaceRef, to: singleRef });
    terminals.push(singleRef);
    if (singlePr) plates.push(...prPlates(singlePr));
  }

  // -- the silo ----------------------------------------------------------
  const total = parts.length > 0 ? parts.length : issue.linkedPrNumber ? 1 : 0;
  const filled =
    parts.length > 0
      ? parts.filter((p) => partProgress(p) === 'shipped').length
      : singlePr
        ? Number(prReading(singlePr) === 'shipped')
        : Number(Boolean(singleRef && recordedPr.has(singleRef)));
  const siloRef = `${patchRef}:silo`;
  machines.push({
    ref: siloRef,
    kind: 'silo',
    kindLabel: 'Silo',
    name: 'The goal',
    meta: [],
    presence: 'built',
    status: siloStatus(filled, total),
    scanners: [],
    prNumber: null,
    link: null,
    fill: total === 0 ? 0 : filled / total,
    siloLabel: `${filled} / ${total || '—'} in`,
  });
  for (const from of terminals.length > 0 ? terminals : [furnaceRef]) edges.push({ from, to: siloRef });

  // -- the goal check, and the tail on its yes arm -----------------------
  const shortfall = issue.shortfall ?? null;
  const conclusion = issue.conclusion ?? null;
  // The standing delivery is asked *first* and on its own, not read off the
  // pickup status. `issuePickupStatus` answers its plan `parts` arm before the
  // delivery park, so a delivered *decomposed* issue reports `planning` — and
  // reading the tail off that status left the whole yes arm undrawn for exactly
  // the floors that had reached the end. The two pickup arms stay beside it: a
  // closed issue is `done`, and an unplanned delivered one is `delivered`, which
  // the field agrees with rather than replaces.
  const delivery = issue.delivery ?? null;
  const reading = satelliteReading(delivery, shortfall);
  // The tail reads the **verdict**, and nothing else (issue #234). It used to also
  // accept two pickup statuses, and `done` is any *closed* issue — so the Manifest,
  // the Signal post and the Launch drew on the goal check's yes arm while the check
  // itself read unbuilt: three built stations under a green *Delivered · Away*, on a
  // goal nothing had assessed. A ticket being closed is admin work anyone can do at
  // any moment, and promoting it to the harness's own verdict is the thing #234
  // exists to stop.
  const delivered = reading === 'verified';
  const satRef = `${patchRef}:assess`;
  machines.push({
    ref: satRef,
    kind: 'satellite',
    kindLabel: 'Satellite',
    name: reading === 'unbuilt' ? 'Goal check' : 'Goal checked',
    // Attributed to whoever cast the verdict this machine is *reading* — the
    // delivery or the shortfall — and to nothing else. `conclusion.by` was the
    // wrong author for the same reason it was the wrong reading: for a decomposed
    // issue it resolves to `plan`, so a satellite saying *Verified · by plan*
    // would credit the goal check to a roll-up that never made one.
    meta: [`rule issue-assess · assessment`, ...(satelliteAuthor(delivery, shortfall) ?? [])],
    presence: reading === 'unbuilt' ? 'unbuilt' : 'built',
    status: satelliteStatus(reading),
    scanners: [],
    prNumber: null,
    link: null,
    fill: null,
    siloLabel: null,
  });
  edges.push({ from: siloRef, to: satRef });

  if (shortfall) {
    plates.push({
      who: 'Launch failed verification',
      tone: 'bad',
      text: shortfall.summary,
      route: shortfall.cause,
      assayIssue: null,
    });
  }

  // The manifest and the signal post sit on the goal check's **yes** arm: a
  // shortfall returns before this point, so a returned floor draws neither.
  //
  // Without a verdict at all they are drawn **unbuilt** (issue #234), the
  // vocabulary the furnace already uses for a stage nothing has reached. Cutting
  // the route short instead said the same thing by omission — and said it in a
  // shape indistinguishable from the floor simply ending there, which is how three
  // stations came to be drawn as built off a closed ticket without anyone noticing
  // the goal check underneath them read *Not yet built*.
  let tail = satRef;
  if (!shortfall) {
    const manifestRef = `${patchRef}:manifest`;
    const retro = issue.retrospective ?? null;
    machines.push({
      ref: manifestRef,
      kind: 'manifest',
      kindLabel: 'Manifest',
      name: delivered ? 'Report what was done' : 'Nothing to report yet',
      // The retrospective's summary is the station's line; the working agent's own
      // conclusion note stays beneath it rather than being replaced. They answer
      // different questions — how the run went, and whether the goal was met — and
      // a station that showed only the second would still be reporting nothing
      // about the run it is named for.
      meta: delivered
        ? [retro?.summary ?? 'no retrospective yet', ...(conclusion?.note ? [conclusion.note] : [])]
        : ['—'],
      presence: delivered ? 'built' : 'unbuilt',
      status: delivered ? manifestStatus(Boolean(retro)) : UNBUILT,
      scanners: [],
      prNumber: null,
      link: null,
      fill: null,
      siloLabel: null,
    });
    edges.push({ from: tail, to: manifestRef });

    const signalRef = `${patchRef}:signal`;
    const comment = statusCommentReading(plan);
    machines.push({
      ref: signalRef,
      kind: 'signal',
      kindLabel: 'Signal post',
      name: 'Update the ticket',
      // Both signals the harness actually sends (#171): the state move, and the
      // one living status comment the plan reconciler keeps. The meta line states
      // the reading; the link opens the notice itself, and only when the provider
      // resolved a URL for it — so the post can say it has spoken on a provider
      // that builds no URLs without offering a way in that goes nowhere.
      // The reminder to go and close the ticket, and it can stand as long as it
      // needs to: since #234 the run's life does not depend on the answer, so a
      // ticket nobody has got round to closing costs the workflow nothing.
      meta: delivered
        ? [
            issue.workItemState ? `state · ${issue.workItemState}` : 'no workflow state on this provider',
            COMMENT_META[comment],
          ]
        : ['—'],
      presence: delivered ? 'built' : 'unbuilt',
      status: delivered ? signalPostStatus(issue.workItemState, comment) : UNBUILT,
      scanners: [],
      prNumber: null,
      link: plan?.statusCommentRef ? { ref: plan.statusCommentRef, label: 'notice ↗' } : null,
      fill: null,
      siloLabel: null,
    });
    edges.push({ from: manifestRef, to: signalRef });
    tail = signalRef;
  }

  // Three readings, not two (issue #234): a launch that went, one the assessor
  // sent back, and one that has not happened — the last is what a floor with no
  // goal check has, and it is a different fact from either of the others.
  const launchRef = `${patchRef}:launch`;
  const launch: LaunchReading = shortfall ? 'returned' : delivered ? 'away' : 'unbuilt';
  machines.push({
    ref: launchRef,
    kind: 'launch',
    kindLabel: 'Launch',
    name: LAUNCH_NAMES[launch],
    meta: [LAUNCH_META[launch]],
    presence: launch === 'unbuilt' ? 'unbuilt' : 'built',
    status: launchStatus(launch),
    scanners: [],
    prNumber: null,
    link: null,
    fill: null,
    siloLabel: null,
  });
  edges.push({ from: tail, to: launchRef });

  // Whatever the harness itself says about why nothing is moving, quoted. Last,
  // so the specific machine plates above read first.
  for (const reason of issue.pickup?.reasons ?? []) {
    if (!plates.some((p) => p.text === reason)) {
      plates.push({
        who: 'Ore patch',
        tone: patchStatus(pickupStatus).tone,
        text: reason,
        route: null,
        assayIssue: null,
      });
    }
  }

  const refs = machines.map((m) => m.ref);
  return {
    issueNumber: n,
    title: issue.title,
    machines,
    edges,
    fixtures: floorFixtures(edges),
    layout: layoutFloor(refs, edges),
    plates,
    planId: plan?.id ?? null,
    // Both keyed on the record existing, and on nothing else — see `retroRef`.
    padRef: (issue.scratchpad?.entries ?? 0) > 0 ? `issue:${n}` : null,
    retroRef: issue.retrospective ? `issue:${n}` : null,
  };
}

function furnaceName(plan: Plan, live: number): string {
  if (plan.status === 'single') return 'One PR will do';
  if (plan.status === 'planning') return 'Reading the repository';
  return live === 1 ? 'Smelted into 1 part' : `Smelted into ${live} parts`;
}

/** What a part is expected to produce, or produced — never inferred from an artifact. */
function outcomeLine(part: PlanPart): string {
  const kind = part.outcomeKind ?? part.expectedKind ?? 'code';
  return part.prNumber ? `out: ${kind} · PR #${part.prNumber}` : `out: ${kind}`;
}

function prReading(pr: PullRequest): PrMachineReading {
  if (pr.state === 'merged' || pr.merged === true) return 'shipped';
  if (pr.state === 'closed') return 'scrapped';
  const verdict = pr.ciVerdict;
  if (pr.ciStatus === 'failing') {
    if (verdict && verdict.dispatch.length === 0 && verdict.escalate.length > 0) return 'held';
    return 'repairing';
  }
  return pr.health?.blocked ? 'blocked' : 'on_the_pad';
}

/** A blocked PR's plate quotes the server's health reasons; it composes none. */
function prPlates(pr: PullRequest): FloorPlate[] {
  return (pr.health?.reasons ?? []).map((text) => ({
    who: `Pull request #${pr.number}`,
    tone: (pr.ciStatus === 'failing' ? 'bad' : 'warn') as MachineStatus['tone'],
    text,
    route: null,
    assayIssue: null,
  }));
}

/**
 * What the goal check has said, read off the two rows it actually writes.
 *
 * Never off `conclusion`. That is a *fold* — operator toggle, then shortfall,
 * then the working agent, then the plan roll-up — and only one of its four arms
 * is the assessor's. Reading a fold to answer about one of its inputs gave both
 * of the wrong answers at once here: `{by: 'assessor', verdict: 'done'}` is a
 * shape the fold cannot produce (the positive verdict lives in `issue_deliveries`,
 * not `issue_conclusions`), so the built arm was unreachable; while a plan-derived
 * `done` would have claimed a goal check off a roll-up that says every part
 * merged and says nothing about whether the goal was reached.
 *
 * A plan-derived `done` therefore still reads `unbuilt`, deliberately: an issue
 * whose parts all merged and which nobody has assessed has not had its goal
 * checked, and saying otherwise is the inverse of the bug this fixes.
 */
function satelliteReading(delivery: Issue['delivery'] | null, shortfall: Issue['shortfall'] | null): SatelliteReading {
  // Asked first: the two rows are mutually exclusive in the store, so this
  // ordering only decides a world where they somehow are not — and there the
  // negative is the one an operator has to see.
  if (shortfall) return 'returned';
  return delivery ? 'verified' : 'unbuilt';
}

/** Who cast the verdict the satellite is reading, or nothing if it read none. */
function satelliteAuthor(delivery: Issue['delivery'] | null, shortfall: Issue['shortfall'] | null): string[] | null {
  const by = shortfall?.by ?? delivery?.by ?? null;
  return by ? [`by ${by}`] : null;
}
