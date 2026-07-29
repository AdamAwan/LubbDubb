import type { Issue, Plan, PlanPart, PullRequest, QueueItem, Task, WorkNodeView } from '../../types.js';
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
  scannerStatus,
  signalPostStatus,
  siloStatus,
  type FloorStage,
  type MachinePresence,
  type MachineStatus,
  type PartProgress,
  type PrMachineReading,
  type SatelliteReading,
  type ScannerState,
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
 * time a plan rejoins. That also means this tolerates **in-degree greater than
 * one** today, before the schema can emit it — `PlanPart.dependsOn` is capped at
 * one entry at the plan document's zod boundary, and relaxing that cap (#170) is
 * a change to what a plan may *say* rather than a drawing decision, so it is
 * deliberately not made here. When it lands this needs no cockpit change.
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

interface Scanner {
  name: string;
  state: ScannerState;
  status: MachineStatus;
}

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
  /** The plan this plate is about, so the shared modal can be opened from it. */
  planId: string | null;
}

export interface GoalFloorModel {
  issueNumber: number;
  title: string;
  machines: Machine[];
  edges: FloorEdge[];
  fixtures: FloorFixture[];
  layout: FloorLayout;
  plates: FloorPlate[];
  /** The plan behind this floor, for the panel's Replan / View controls. */
  planId: string | null;
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
 * It never links: `Plan.statusCommentRef` is a *provider comment id*, not a URL,
 * and `refUrls` cannot resolve one — so the only thing the cockpit may claim is
 * that a comment exists.
 */
const COMMENT_META: Record<StatusCommentReading, string> = {
  written: 'status comment · written',
  unwritten: 'status comment · none written',
  no_plan: 'no plan · no status comment to write',
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
  const activeOrigins = new Set(
    tasks.filter((t) => t.status === 'active' || t.status === 'queued').map((t) => t.originRef ?? ''),
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
      meta: [`rule 3f · by ${assay.by}`],
      presence: 'built',
      status: assayStatus(assay.verdict),
      scanners: [],
      prNumber: null,
      fill: null,
      siloLabel: null,
    });
    edges.push({ from: head, to: assayRef });
    head = assayRef;
    if (assay.verdict === 'unclear') {
      plates.push({ who: 'Assay · refused', tone: 'bad', text: assay.summary, route: null, planId: null });
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
    fill: null,
    siloLabel: null,
  });
  edges.push({ from: head, to: furnaceRef });

  if (plan?.reason && plan.status === 'awaiting_approval') {
    plates.push({ who: 'Blueprint', tone: 'ghost', text: plan.reason, route: null, planId: plan.id });
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
        scanners: pr && progress !== 'shipped' ? scannersFor(pr) : [],
        prNumber: part.prNumber,
        fill: null,
        siloLabel: null,
      });
      if (pr) plates.push(...prPlates(pr));
      // An unapproved plan already has one plate saying so; a plate per ghost
      // part would be the same sentence three times.
      if (!ghostPlan && held && held.status !== 'dispatching') {
        plates.push({ who: `Assembler · ${i + 1}`, tone: 'warn', text: held.reason, route: null, planId: null });
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
      scanners: singlePr ? scannersFor(singlePr) : [],
      prNumber: issue.linkedPrNumber,
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
    fill: total === 0 ? 0 : filled / total,
    siloLabel: `${filled} / ${total || '—'} in`,
  });
  for (const from of terminals.length > 0 ? terminals : [furnaceRef]) edges.push({ from, to: siloRef });

  // -- the goal check, and the tail on its yes arm -----------------------
  const shortfall = issue.shortfall ?? null;
  const conclusion = issue.conclusion ?? null;
  const delivered = pickupStatus === 'delivered' || pickupStatus === 'done';
  const reading = satelliteReading(conclusion, shortfall);
  const satRef = `${patchRef}:assess`;
  machines.push({
    ref: satRef,
    kind: 'satellite',
    kindLabel: 'Satellite',
    name: reading === 'unbuilt' ? 'Goal check' : 'Goal checked',
    meta: [`rule 3e · assessment`, ...(conclusion?.by ? [`by ${conclusion.by}`] : [])],
    presence: reading === 'unbuilt' ? 'unbuilt' : 'built',
    status: satelliteStatus(reading),
    scanners: [],
    prNumber: null,
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
      planId: plan?.id ?? null,
    });
  }

  // The manifest and the signal post sit on the goal check's **yes** arm, which
  // is why no floor in flight reaches them: a shortfall returns before this
  // point. Drawing them unbuilt on every floor would claim a tail the workflow
  // has not got to.
  let tail = satRef;
  if (delivered && !shortfall) {
    const manifestRef = `${patchRef}:manifest`;
    machines.push({
      ref: manifestRef,
      kind: 'manifest',
      kindLabel: 'Manifest',
      name: 'Report what was done',
      meta: conclusion?.note ? [conclusion.note] : ['—'],
      presence: 'built',
      status: manifestStatus(Boolean(conclusion?.note)),
      scanners: [],
      prNumber: null,
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
      // one living status comment the plan reconciler keeps. The comment line is
      // a fact, never a link — a provider comment id is not a URL.
      meta: [
        issue.workItemState ? `state · ${issue.workItemState}` : 'no workflow state on this provider',
        COMMENT_META[comment],
      ],
      presence: 'built',
      status: signalPostStatus(issue.workItemState, comment),
      scanners: [],
      prNumber: null,
      fill: null,
      siloLabel: null,
    });
    edges.push({ from: manifestRef, to: signalRef });
    tail = signalRef;
  }

  if (delivered || shortfall) {
    const launchRef = `${patchRef}:launch`;
    machines.push({
      ref: launchRef,
      kind: 'launch',
      kindLabel: 'Launch',
      name: shortfall ? 'Failed verification' : 'Delivered',
      meta: [shortfall ? 'returned by the assessor' : 'pickup held · reversible'],
      presence: 'built',
      status: launchStatus(Boolean(shortfall)),
      scanners: [],
      prNumber: null,
      fill: null,
      siloLabel: null,
    });
    edges.push({ from: tail, to: launchRef });
  }

  // Whatever the harness itself says about why nothing is moving, quoted. Last,
  // so the specific machine plates above read first.
  for (const reason of issue.pickup?.reasons ?? []) {
    if (!plates.some((p) => p.text === reason)) {
      plates.push({ who: 'Ore patch', tone: patchStatus(pickupStatus).tone, text: reason, route: null, planId: null });
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

/**
 * The scanner row: one per failing check from the classification verdict, plus
 * the two the aggregate needs, plus human review.
 *
 * **Human review is fed from `pr.approved`, not from the verdict**, and that is
 * the one thing to preserve here: reviewer policies deliberately do not fold into
 * `ciChecks` — they map to `approved` / `unresolvedComments` — so a scanner drawn
 * off `ciVerdict` would be permanently absent.
 *
 * No check *name* is written here. Every name comes off the verdict, so a floor
 * running against a config naming any check at all renders with no change.
 */
function scannersFor(pr: PullRequest): Scanner[] {
  const scanners: Scanner[] = [];
  const add = (name: string, state: ScannerState) => scanners.push({ name, state, status: scannerStatus(state) });
  const verdict = pr.ciVerdict;
  const named = (verdict?.dispatch.length ?? 0) + (verdict?.escalate.length ?? 0) + (verdict?.ignored.length ?? 0);

  for (const m of verdict?.dispatch ?? []) add(m.name, 'damaged');
  for (const m of verdict?.escalate ?? []) add(m.name, 'not_ours');
  for (const m of verdict?.ignored ?? []) add(m.name, 'muted');
  if (named === 0) {
    // The provider reported no per-check detail. That is missing detail rather
    // than a clean bill of health, so the aggregate speaks for itself under the
    // generic name the workflow doc uses for the whole row.
    if (pr.ciStatus === 'passing') add('quality gates', 'pass');
    else if (pr.ciStatus === 'failing') add('quality gates', 'damaged');
    else if (pr.ciStatus === 'pending') add('quality gates', 'awaiting');
  }
  add('human review', pr.approved === true ? 'pass' : 'awaiting');
  return scanners;
}

/** A blocked PR's plate quotes the server's health reasons; it composes none. */
function prPlates(pr: PullRequest): FloorPlate[] {
  return (pr.health?.reasons ?? []).map((text) => ({
    who: `Pull request #${pr.number}`,
    tone: (pr.ciStatus === 'failing' ? 'bad' : 'warn') as MachineStatus['tone'],
    text,
    route: null,
    planId: null,
  }));
}

function satelliteReading(
  conclusion: Issue['conclusion'] | null,
  shortfall: Issue['shortfall'] | null,
): SatelliteReading {
  if (shortfall) return 'returned';
  if (!conclusion || conclusion.by !== 'assessor') return 'unbuilt';
  return conclusion.verdict === 'done' ? 'verified' : 'more_work';
}
