import type {
  AppState,
  CockpitDecision,
  Escalation,
  HumanTask,
  PlanPart,
  Proposal,
  SetupCheck,
  SetupPayload,
  SetupVerdict,
  OpenPullRequest,
  ViewerAssignment,
} from '../types.js';
import { goalIssue, goalOfPr } from './goalPage.js';
import { watchBucket } from '../worldBuckets.js';

/**
 * What kind of answer a row wants. `permission` and the four proposal kinds are
 * escalations underneath, split out because the verdict differs: a permission
 * goes to `/permission`, a proposal carries accept/reject, and a plain question
 * takes free text. Drawing them as one kind is how a surface ends up offering the
 * wrong control.
 *
 * **A proposal is four kinds, not one.** They were one — `proposal`, labelled
 * `Plan` — and the label was a lie on three of them: a drafted reply, a merge and
 * an assessment's follow-up all arrived on the rail and in the ask panel under the
 * word `Plan`, which names the one thing they are not. What answers them differs
 * too (`ACCEPT_LABEL` in `web/src/components/EscalationCard.tsx` has always known
 * that), so the kind is the proposal's own kind and the tag says which act is
 * waiting.
 */
/**
 * `config` and `config_gap` are the harness's own configuration, read by
 * `src/setup/reading.ts` and merged in here rather than drawn on a surface of
 * their own. Two kinds rather than one with a per-row tone: `KIND_TONE` is total
 * over this union, which is what makes a new kind fail the typecheck instead of
 * rendering untinted — and a row's severity has to be legible, since "your token
 * expired" and "a gate is off" are not the same news. `config` is red (the fleet
 * cannot work, or is spending money it should not), `config_gap` amber (it works,
 * but something of yours is hiding work from it).
 */
/**
 * `intake` is the goal appraisal's refusal (#158): an `unclear` verdict stops pickup
 * for the whole goal, and it is raised on the queue rather than only on the
 * tickets tab. It lived there alone, which put the one reading that stops a goal
 * dead on a page an operator opens to *groom* the backlog — while the rail, the
 * surface that exists to say what is waiting on a person, said nothing about it.
 * An operator who never opens that tab sees a goal that looks like it simply has
 * not come up yet. → `docs/spec/06-issue-pickup.md#block-or-inform-and-why-blocking-is-safe`
 */
/**
 * `dispatch` is the one kind derived from the *decision log* rather than from a
 * row somebody raised — a dispatch the executor has refused on every pulse for
 * three pulses running. Nothing else in the harness records that: no escalation
 * is raised, no task is filed, and the task row the attempt made is settled
 * `interrupted` on the way out, so a fleet stuck on one reads as a fleet with
 * nothing to do. → `docs/spec/09-execution.md#a-refusal-that-keeps-repeating`
 */
export type NeedKind =
  | 'config'
  | 'config_gap'
  | 'recovery'
  | 'escalation'
  | 'permission'
  | 'plan'
  | 'reply'
  | 'merge'
  | 'shortfall'
  | 'intake'
  | 'profile'
  | 'placement'
  | 'bench'
  | 'close_out'
  | 'validate'
  | 'burn'
  | 'limit'
  | 'supply'
  | 'dispatch'
  | 'assigned';

/**
 * Who is stopped. `blocking` means an agent is parked and cannot proceed;
 * `yours` means the obligation is the operator's and nothing is waiting inside
 * the fleet — which is where the goal-profile gate sits, holding a whole goal's
 * dispatch with no agent parked on it. The split is strict and it is about a
 * *held slot*, not about how much is stopped: widening it for a gate nobody is
 * sitting in would cost the group the only thing it means.
 *
 * It is drawn as **weight, not hue** — hue belongs to the kind (`KIND_TONE`,
 * `web/src/console/QueueRail.tsx`). The rail once spent its whole palette on this
 * one bit, red against amber, which made every ask on the bench read as an alarm
 * and left a delivered goal's close-out indistinguishable from a crash. The group
 * is now said three ways instead: the `Blocking` sub-heading, the sort order, and
 * a full-strength stripe with a filled tag against a softened one.
 *
 * A usage-limit park (issue #318) is `blocking` for the rule's own reason and not
 * by analogy: the agent is stopped, its worktree and its slot are held, and the
 * harness will not resume it on its own. What differs from a question is only
 * *what* the operator does — wait for the window to turn over, then resume.
 */
export type NeedGroup = 'blocking' | 'yours';

/**
 * Pull requests a **person** put on the operator, as rows.
 *
 * The one kind of row with nothing behind it — no escalation, no proposal, no
 * task, and no rule that will ever act on it. That is the whole reason it is
 * here: everything else in this queue is the harness saying it is stuck, and a
 * pull request somebody assigned to you is work the harness does not know exists.
 * It sat in the provider's own inbox, which is the surface the console was built
 * so an operator would not have to keep open.
 *
 * **Keyed on `attention.assignedToYou`, never on the pull request's assignment
 * itself.** The verdict sets that field only when the assignment is what makes
 * the pull request your court — so a PR assigned to you with an agent already on
 * its branch, or one whose merge is waiting on your verdict, draws no row here.
 * The first is the harness's to finish, and the second already has a row of its
 * own; both would be the same ask twice, which is how a queue teaches an operator
 * to skim it.
 *
 * **`yours`, never `blocking`.** Nothing is parked and no slot is held — the
 * group is strictly about that, and widening it for how much an operator has to
 * do would cost it the only thing it means.
 */
function assignedPrRows(state: AppState): NeedRow[] {
  const rows: NeedRow[] = [];
  for (const pr of state.world.pullRequests) {
    const assignment = pr.attention?.assignedToYou;
    if (assignment === undefined) continue;
    const goalRef = goalOfPr(state, pr.number);
    rows.push({
      id: `assigned:pr:${pr.number}`,
      kind: 'assigned',
      group: 'yours',
      // What a person asked, and what they asked it about. The verdict's leading
      // reason names them (`Priya Raman marked you as a reviewer`) and the pull
      // request's own title says what it is — which together are the whole of
      // what an operator needs to decide whether to open it.
      //
      // The arm's own reason is deliberately **not** carried here. `waiting on
      // review` is this very row said back to you, and `not tagged … — the
      // harness is leaving it alone` explains the *fleet's* silence, not your
      // obligation; both still stand on the pull request row, where the question
      // being asked is what the harness makes of the PR rather than what a
      // colleague wants from you.
      title: askLine(assignedLine(pr), goalRef, state),
      ...(REVIEWER_NOTE[assignment] === undefined ? {} : { note: REVIEWER_NOTE[assignment] }),
      goalRef,
      originRef: `pr:${pr.number}`,
      opens: opensAt(goalRef, state),
      // Nobody is running it — that is the news. An id here would name some
      // earlier agent on the same branch.
      agentId: null,
      agentLabel: null,
      holding: 0,
      // How long it has been waiting on *you* — the review-wait watermark the
      // pulse folds (`awaitingReview`), which the verdict carries on an assigned
      // court for exactly this. It is not when the assignment was made: no
      // provider payload says that, and stamping the snapshot's "now" for it would
      // draw a fresh age on every poll, a row that has been yours all week reading
      // as one that arrived a moment ago.
      //
      // Empty where the clock is not running — red CI, an unhandled comment, a
      // staffed branch, or a harness that has not yet observed a pulse of this
      // pull request — and an empty string draws no age, which is the honest
      // rendering of a span nothing observed. It also sorts such a row to the top
      // of its group, which is where an ask whose age is unknown belongs.
      raisedAt: pr.attention?.reviewWaitingSince ?? '',
    });
  }
  return rows;
}

/**
 * Which kind of reviewer, for the metadata line. An `assignee` has no note: "this
 * is yours to drive" is already what the sentence says, and a chip repeating it
 * would be the row's only line of pure decoration.
 */
const REVIEWER_NOTE: Partial<Record<ViewerAssignment, string>> = {
  'reviewer-required': 'Required reviewer',
  'reviewer-optional': 'Optional reviewer',
};

/**
 * The row's sentence: what a person asked, then the pull request they asked it
 * about, in that order — the order an operator reads it in, since the name is
 * what makes the row an obligation and the title is what makes it judgeable.
 *
 * The lead is the verdict's own first reason rather than a second copy of the
 * wording, and it is capitalised here because every other row on this rail opens
 * with a capital and a reason is written as a clause. A pull request the world
 * carries with no title is a shape no provider produces, but it costs one
 * conditional to draw honestly instead of `on “”`.
 */
function assignedLine(pr: OpenPullRequest): string {
  const lead = pr.attention?.reasons[0] ?? '';
  const sentence = lead === '' ? `PR #${pr.number} is yours` : `${lead[0]?.toUpperCase() ?? ''}${lead.slice(1)}`;
  const title = pr.title.trim();
  return oneLine(title === '' ? sentence : `${sentence} on “${title}”`);
}

/**
 * What clicking a row opens. `goal` is the goal's page, where the ask is read
 * next to what it is about; `config` is the config page at the group owning the
 * key a config row is about — the row body is a way *there*, and the fix beside it
 * is a shortcut past it rather than the only road to it; `ask` is the ask on its own, for a row whose origin
 * is not a goal the console can draw — an escalation raised on a pull request, a
 * bench task with no ticket, a goal the world no longer carries. `null` is the
 * recovery hold alone, which is answered on the banner above the console.
 *
 * Decided in the derivation because only the derivation can tell a ref that *has*
 * a page from one that merely looks like it does. A rail that reads `goalRef`
 * instead draws a row whose click lands nowhere — which is indistinguishable, to
 * the operator, from a console that is broken.
 */
type NeedDestination = 'goal' | 'ask' | 'config' | null;

/** One row of the merged queue. */
export interface NeedRow {
  /** The source row's own id, so answering it settles exactly this row. */
  id: string;
  kind: NeedKind;
  group: NeedGroup;
  /** The ask on one line. */
  title: string;
  /**
   * `issue:<n>` when the ask belongs to a goal; null for fleet-wide holds. This
   * is what the row *says* — where it goes is {@link NeedDestination}, since a
   * goal can be named by a ref the console has no page for.
   */
  goalRef: string | null;
  /**
   * The ref the ask was actually raised on (`pr:142`, `issue:12:part:signer`), as
   * the harness recorded it. Kept beside {@link goalRef} rather than folded into
   * it because the two answer different questions: `goalRef` is the goal the ask
   * is read *next to*, and this is what it is *about*. A row with no goal has one
   * of these or nothing at all, and the ask panel draws it — an ask whose subject
   * a surface cannot name is one the operator answers blind.
   */
  originRef: string | null;
  /** Where a click goes. */
  opens: NeedDestination;
  /**
   * The agent this row is about, when there is one — the parked agent on an
   * escalation or a limit park, the spending one on a burn notice. Never the
   * agent that merely raised the row: a bystander's id beside an ask reads as the
   * thing to go and look at.
   */
  agentId: string | null;
  /**
   * What that agent is *on*, in words — its task's title, resolved here from the
   * snapshot the browser already holds. It is what the rail draws, because an
   * `agent_ab4sc` beside an ask names nothing an operator recognises: the id is
   * minted (`agent_${nanoid(10)}`, `src/store/agents.ts`) and an agent has no name
   * of its own, so its task's title is the harness's only answer to "what is this
   * run". Null when there is no agent, or none the snapshot still carries — the
   * rail then says so in words rather than falling back to the id.
   */
  agentLabel: string | null;
  /**
   * A short qualifier for the row's metadata line — what the row's *sentence*
   * deliberately leaves out because it would read as boilerplate in it.
   *
   * The one user is which kind of reviewer an assigned pull request made you
   * (`Required reviewer` / `Optional reviewer`), which is a real distinction and
   * a bad clause: every row would carry it and no two rows would differ by it.
   * Read off `attention.assignedToYou` — the *field*, never the wording — so a
   * rephrased reason cannot silently change what the row claims.
   */
  note?: string;
  /** Live plan parts this ask is holding. Zero when it genuinely holds nothing. */
  holding: number;
  raisedAt: string;
  /**
   * The configuration check behind a `config` / `config_gap` row, carrying its
   * verdict, its remedy and the fix the rail draws a control for. Absent on every
   * other kind — nothing else in the queue has a one-click answer, because an
   * escalation's answer is words only a person has.
   */
  check?: SetupCheck;
  /** Set once a fix on this row has been written, until the operator dismisses it. */
  applied?: AppliedFix;
}

/**
 * A config fix that has been written, held until the operator dismisses it.
 *
 * Deliberately not a verdict the reading could carry: the reading is a fresh look
 * at the file every time, and this is a fact about *this cockpit session* — what
 * you just did, so you can see it and take it back. Held in `useCockpit` beside
 * the reading rather than in it. → `docs/spec/26-setup.md#applying-a-fix`
 */
export interface AppliedFix {
  checkId: string;
  /** `userId = AdamAwan`, in the settled strip's own words. */
  summary: string;
  /** The file it landed in, so the operator can go and look. */
  file: string;
}

/**
 * How many live parts named this slug — the same rule the bench station has
 * always used, lifted out so the queue, the goal page and the station cannot
 * disagree about what an ask is holding. Direct dependents only: a transitive
 * count would claim work that a sibling, not this ask, is the blocker for.
 */
export function partHolding(planId: string, slug: string, parts: readonly PlanPart[]): number {
  return parts.filter((p) => p.status !== 'retired' && p.planId === planId && p.dependsOn.includes(slug)).length;
}

/**
 * The goal a ref belongs to, as `issue:<n>`.
 *
 * `issue:12:part:x` and `issue:12` both fold to `issue:12`. A **`pr:<n>`** origin
 * is resolved through the world (`goalOfPr`): the goal page is where an ask is
 * meant to be read, and most asks the harness raises come from a pull request, so
 * reading only the literal prefix sent every rebase and CI question to a panel
 * with no context around it while the goal that PR belongs to sat one lookup away.
 * Null survives for a pull request no ticket owns — the harness works those too,
 * and there is no goal to invent for them.
 */
function goalOf(ref: string | null | undefined, state: AppState): string | null {
  const m = /^(issue:\d+)/.exec(ref ?? '');
  // noUncheckedIndexedAccess makes a capture group read as possibly undefined
  // even once `m` is non-null; the regex guarantees it's set when `m` matches.
  if (m?.[1]) return m[1];
  const pr = /^pr:(\d+)/.exec(ref ?? '');
  return pr?.[1] ? goalOfPr(state, Number(pr[1])) : null;
}

/**
 * The name of the work an agent is on: its task's title, clamped to one line.
 *
 * Resolved once here rather than in the rail, so the row carries a reading and
 * not an id to look up — and so the fallback is decided in one place. A title is
 * free text an agent or the dispatcher wrote, so a line break in it would put a
 * paragraph in a queue row; the first line is the summary either way.
 */
function agentLabelOf(agentId: string | null, state: AppState): string | null {
  if (agentId === null) return null;
  const agent = state.agents.find((a) => a.id === agentId);
  const title = agent === undefined ? null : (state.tasks.find((t) => t.id === agent.taskId)?.title ?? null);
  const line = title?.split('\n')[0]?.trim() ?? '';
  return line === '' ? null : line;
}

/**
 * A row's line: what is being asked, and the goal it is about.
 *
 * One factual sentence, assembled here rather than taken from whatever prose the
 * ask arrived with. The rail used to draw `escalation.prompt` verbatim, and a
 * plan approval's prompt is four paragraphs — so the card that mattered most was
 * the tallest thing on the rail, and a queue of them was unreadable at a glance.
 * Everything that prose says is still one click away in the band the row opens;
 * what the row owes the operator is which ask it is, and which goal it is about.
 *
 * The goal is named `#395 · <its title>`, because a number alone is not something
 * an operator recognises — and the ref is dropped when the summary already spells
 * it out, so a close-out does not read `Close issue #395 in the tracker for #395`.
 *
 * @see docs/spec/17-cockpit.md — the queue rail
 */
function askLine(summary: string, goalRef: string | null, state: AppState): string {
  const issue = goalRef === null ? undefined : goalIssue(state, goalRef);
  if (issue === undefined) return summary;
  const named = new RegExp(`#${issue.number}(?!\\d)`).test(summary);
  return `${summary}${named ? '' : ` for #${issue.number}`} · ${issue.title}`;
}

/** Long enough for a sentence, short enough that two rows fit where one used to. */
const MAX_SUMMARY = 110;

/**
 * Free text as one clamped line. Everything an ask arrives with is prose somebody
 * wrote — an agent, a planner, a template — so a row that drew it whole would be
 * whatever length that author felt like.
 *
 * Absent text is a line rather than a throw. These are wire strings, and a row
 * whose prose the server did not send is still a row the operator has to be shown:
 * a derivation that threw on it would take the whole queue down with it.
 */
function oneLine(text: string | null | undefined): string {
  const line = (text ?? '').split('\n')[0]?.trim() ?? '';
  return line.length <= MAX_SUMMARY ? line : `${line.slice(0, MAX_SUMMARY - 1).trimEnd()}…`;
}

/**
 * Who wrote the review comment a drafted reply answers, when the world still
 * carries it. Named because that is what makes the row judgeable from the rail:
 * "a reply is waiting" says nothing an operator can act on, and who it is to says
 * most of it. Null degrades to a line that simply does not name them.
 */
function commentAuthor(state: AppState, prNumber: unknown, commentId: unknown): string | null {
  if (typeof prNumber !== 'number' || typeof commentId !== 'string') return null;
  const pr = state.world.pullRequests.find((p) => p.number === prNumber);
  return pr?.unresolvedComments.find((c) => c.id === commentId)?.author ?? null;
}

/**
 * What an escalation-backed row says, in the harness's words rather than the
 * ask's own prose.
 *
 * Each arm states the act that is waiting — the thing the operator is deciding —
 * and nothing about why. A proposal already knows which act it is, so the line is
 * derived from the proposal rather than guessed from the prompt; a plain question
 * has no act, and its own first line is the most factual thing there is.
 */
function escalationSummary(
  e: Escalation,
  proposal: Proposal | undefined,
  originRef: string | null,
  state: AppState,
): string {
  const { context } = e;
  const pr = typeof context.prNumber === 'number' ? ` for PR #${context.prNumber}` : '';
  if (proposal) {
    switch (proposal.kind) {
      case 'plan':
        return 'Plan ready';
      case 'reply_draft': {
        const author = commentAuthor(state, context.prNumber, context.commentId);
        return `Draft reply${author === null ? '' : ` to ${author}`}${pr}`;
      }
      case 'merge':
        return `Merge waiting on your verdict${pr}`;
      case 'shortfall':
        return 'The delivered work did not reach the goal';
    }
  }
  if (context.permission) return oneLine(`${context.permission.toolName}: ${context.permission.summary}`);
  // The arm with no proposal under it: the goal itself is what the assessor found
  // wrong, so nothing is dispatched and nothing will be until a person rules.
  if (isShortfallAsk(originRef)) return 'Assessed as not delivered';
  const questions = Array.isArray(context.questions) ? context.questions.length : 0;
  if (questions > 0) return `${questions} questions from the agent`;
  return oneLine(e.prompt);
}

function holdingForTask(task: HumanTask, parts: readonly PlanPart[]): number {
  if (!task.partId) return 0;
  const step = parts.find((p) => p.id === task.partId);
  return step ? partHolding(step.planId, step.slug, parts) : 0;
}

function holdingForEscalation(e: Escalation, state: AppState): number {
  const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
  const m = /^issue:\d+:part:(.+)$/.exec(originRef ?? '');
  if (!m) return 0;
  const step = (state.planParts ?? []).find((p) => p.slug === m[1]);
  return step ? partHolding(step.planId, step.slug, state.planParts ?? []) : 0;
}

/**
 * Which row kind a proposal draws as — total over {@link ProposalKind}, so a
 * fifth act fails the typecheck here rather than inheriting whichever word the
 * last one happened to wear.
 */
const PROPOSAL_KIND: Record<Proposal['kind'], NeedKind> = {
  plan: 'plan',
  reply_draft: 'reply',
  merge: 'merge',
  shortfall: 'shortfall',
};

/**
 * A shortfall the harness is asking about rather than proposing an arm for — the
 * assessment found the *goal* to be what is wrong, so nothing is dispatched and
 * there is no proposal under the row ([13](../../../docs/spec/13-jobs-and-tickets.md)).
 * It is still a shortfall, and a row that read `Escalation` would file the one ask
 * about a delivered goal with the ones about a stuck agent.
 */
function isShortfallAsk(originRef: string | null): boolean {
  return /^issue:\d+:shortfall$/.test(originRef ?? '');
}

function kindOf(e: Escalation, proposal: Proposal | undefined, originRef: string | null): NeedKind {
  if (e.context.permission) return 'permission';
  if (proposal) return PROPOSAL_KIND[proposal.kind];
  return isShortfallAsk(originRef) ? 'shortfall' : 'escalation';
}

/**
 * Which row kind a human task draws as.
 *
 * A total map rather than a pair of ternaries, so a new {@link HumanTaskKind}
 * fails the typecheck here instead of silently drawing as a bench task — which is
 * how the harness's own self-settling rows end up wearing the copy for the ones
 * only a person can close.
 */
const TASK_KIND: Record<HumanTask['kind'], NeedKind> = {
  ask: 'bench',
  close_out: 'close_out',
  validate: 'validate',
  burn: 'burn',
  supply: 'supply',
};

function needKindOfTask(kind: HumanTask['kind']): NeedKind {
  return TASK_KIND[kind];
}

/**
 * Where an answerable row goes: its goal's page when that goal has one, and the
 * ask panel otherwise. Every row that can be answered gets one of the two — an
 * ask nothing opens is an ask nobody answers, and the fleet stays parked on it.
 */
function opensAt(goalRef: string | null, state: AppState): NeedDestination {
  return goalRef !== null && goalIssue(state, goalRef) !== undefined ? 'goal' : 'ask';
}

/**
 * The harness's own configuration, as rows.
 *
 * **An `ok` or `unknown` check draws nothing.** `unknown` is not folded into
 * `bad` here — it is the check saying it could not ask, and a surface that turned
 * that into a row would state a fault the harness has no evidence for. Saying
 * nothing is the honest rendering of "I could not tell", and it is what the empty
 * rail already says in words.
 *
 * **Always `yours`, never `blocking`.** Tempting for a missing credential, since
 * with one the fleet reads nothing at all — but the group is strictly about a
 * *held slot*, and nothing here is parked on a worktree. Widening it for how much
 * is stopped would cost the group the only thing it means.
 *
 * Null while no reading has been taken, which is also what a fully-configured
 * harness looks like: the fetch failed, or every check is `ok`. Both draw nothing,
 * and neither is a fault to put in front of an operator.
 */
const KIND_FOR_VERDICT: Record<SetupVerdict, NeedKind | null> = {
  bad: 'config',
  warn: 'config_gap',
  // Neither draws a row, and `unknown` is not folded into `bad` on the way past:
  // it is the check saying it could not ask, and a row for it would state a fault
  // nothing has evidence for. Total over the verdict so a fourth one fails the
  // typecheck here rather than silently drawing as a fault.
  ok: null,
  unknown: null,
};

function configRows(setup: SetupPayload | null, applied: readonly AppliedFix[]): NeedRow[] {
  if (setup === null) return [];
  return setup.checks
    .filter((check) => {
      if (KIND_FOR_VERDICT[check.verdict] !== null) return true;
      // A check the operator just fixed keeps its row until they dismiss it. The
      // reading re-fetches the moment the file lands, so without this the row a
      // fix was applied from vanishes mid-click — and a write nobody saw is a
      // write nobody can check. It settles instead, says what it wrote and where,
      // and offers the undo.
      return applied.some((entry) => entry.checkId === check.id);
    })
    .map((check) => ({
      id: `setup:${check.id}`,
      kind: KIND_FOR_VERDICT[check.verdict] ?? 'config_gap',
      group: 'yours' as const,
      title: check.detail,
      goalRef: null,
      originRef: null,
      opens: 'config' as const,
      agentId: null,
      agentLabel: null,
      holding: 0,
      // The reading is fetched, not stamped: there is no instant at which a
      // credential started being missing. An empty string already draws no age,
      // which is the honest answer rather than "now" on every re-fetch.
      raisedAt: '',
      check,
      applied: applied.find((entry) => entry.checkId === check.id),
    }));
}

/**
 * How many separate pulses a dispatch must be refused on, unbroken, before the
 * rail says anything.
 *
 * Three rather than one, because a single rejection is not news: a slot is held
 * from `ensure` until the agent's process is reaped, so a fleet running at its
 * cap trips exhaustion transiently and the very next pulse goes through. Three
 * consecutive pulses is a refusal that is not clearing on its own — which is the
 * only kind a person has to do anything about.
 * → `docs/spec/09-execution.md#a-refusal-that-keeps-repeating`
 */
const REFUSAL_PULSES = 3;

/**
 * A dispatch the executor has refused on every recent pulse, and what the last
 * refusal said.
 *
 * @public read back by the needs band, which draws the refusal in full under the row
 */
export interface RefusedDispatch {
  /** What the run is grouped by: the action's `originRef`, or its branch when it has none. */
  key: string;
  originRef: string | null;
  /** The branch the dispatch wanted, on a code dispatch. Null for a desk one. */
  branch: string | null;
  /** How many separate pulses the refusal has survived. */
  pulses: number;
  /** The newest refusal's reason, verbatim as the executor recorded it. */
  detail: string;
  /** The rule that keeps proposing it, when the row carries one. */
  rule: string | null;
  /** When the unbroken run of refusals started. */
  since: string;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Every dispatch that is being refused every pulse, newest run first.
 *
 * **Keyed on the outcome, never on the message.** A refusal is `rejected` in the
 * decision log whatever threw it, so the two the worktree pool raises — a branch
 * checked out somewhere the pool cannot lease, and a pool with nothing left to
 * give ([09](../../../docs/spec/09-execution.md#exhaustion)) — arrive here
 * together, and so does whatever the next one turns out to be. Matching the
 * sentence instead would cover exactly the two failures that have already
 * happened.
 *
 * **`deferred` is not a refusal.** The branch, pause and cap gates defer by
 * design and clear themselves on a later pulse; a rail that counted those would
 * raise an alarm every time the fleet ran at its cap, which is the fleet working.
 *
 * **The run has to be unbroken at the head of that origin's history**, rather
 * than a count over the window. That is what makes the row clear itself: the
 * moment one dispatch for the origin gets through, the streak is over and the row
 * is gone on the next snapshot — where a count would keep drawing until the old
 * rows aged out of the hundred the snapshot carries, which is a surface still
 * saying "stuck" some minutes after the operator fixed it.
 */
function refusedDispatches(state: AppState): RefusedDispatch[] {
  const runs = new Map<string, CockpitDecision[]>();
  const settled = new Set<string>();
  // Newest first, which is the order the snapshot ships them in — so the first
  // non-rejection seen for a key is the one that ends the run. Guarded like
  // `planParts` beside it: a test or a fixture assembling a partial state is a
  // shape the derivation has to survive, since it renders the whole console.
  for (const d of state.decisions ?? []) {
    if (d.action.type !== 'dispatch_code_agent' && d.action.type !== 'dispatch_desk_agent') continue;
    const key = d.subjectRef ?? str(d.action.branch);
    if (key === null || settled.has(key)) continue;
    // The run ends here and what is already collected stands: walking newest
    // first, everything gathered above this row *is* the unbroken head of the
    // origin's history. Dropping it on the older success would be reading the
    // list the wrong way round.
    if (d.outcome !== 'rejected') {
      settled.add(key);
      continue;
    }
    const run = runs.get(key);
    if (run) run.push(d);
    else runs.set(key, [d]);
  }
  const out: RefusedDispatch[] = [];
  for (const [key, run] of runs) {
    // Distinct cycles, not rows: one pulse can propose the same origin twice, and
    // two refusals inside a single cycle are still one bad pulse.
    const pulses = new Set(run.map((d) => d.cycleId)).size;
    if (pulses < REFUSAL_PULSES) continue;
    const newest = run[0];
    const oldest = run[run.length - 1];
    if (!newest || !oldest) continue;
    out.push({
      key,
      originRef: newest.subjectRef,
      branch: str(newest.action.branch),
      pulses,
      detail: newest.detail,
      rule: newest.rule,
      // The start of the run, because "how long has this been stuck" is the
      // question the age beside the row answers. The newest refusal's stamp would
      // read "just now" on a dispatch that has been refused for an hour.
      since: oldest.createdAt,
    });
  }
  return out;
}

/**
 * One refused run by its row id, for the band that draws it in full.
 *
 * Through the same derivation the rail's row came from rather than a second walk
 * of the log: a band that re-counted could disagree with the row above it about
 * how many pulses, which is the drift the shared function exists to prevent.
 *
 * @public the needs band resolves the row it was handed back to its refusal
 */
export function refusedDispatchFor(state: AppState, id: string): RefusedDispatch | null {
  return refusedDispatches(state).find((r) => `dispatch:${r.key}` === id) ?? null;
}

/**
 * The refusal, clamped to a line the rail can hold.
 *
 * The whole message is drawn in the band under the row — this is a display clamp
 * and not a parse: nothing downstream reads what comes back, and the sentence
 * boundary is preferred only because both refusals the pool raises put the branch
 * and the reason in their first one. A message with no sentence break is simply
 * cut.
 */
function refusalLine(detail: string): string {
  const stop = detail.indexOf('. ');
  if (stop > 0 && stop < 200) return detail.slice(0, stop + 1);
  return detail.length > 200 ? `${detail.slice(0, 199)}…` : detail;
}

/**
 * Rows for the dispatches that keep being refused.
 *
 * **`yours`, not `blocking`**, and against how much is stopped — the same call the
 * profile gate takes. The group is strictly about a held slot, and a refused
 * dispatch holds none: nothing was leased, `abandonUnstarted` settles the task,
 * and no agent is sitting in it. It is also the honest reading of the fix, which
 * is outside the harness in both cases the pool raises — an operator's own
 * checkout to switch, or a cap to lower.
 *
 * **Red, on `config`'s terms.** Nothing here is a gate waiting on a yes: the
 * harness has proposed this dispatch on every pulse and will go on proposing and
 * refusing it until somebody acts. That is something wrong, which is what the hue
 * says.
 */
function refusedDispatchRows(state: AppState): NeedRow[] {
  return refusedDispatches(state).map((r) => {
    const goalRef = goalOf(r.originRef, state);
    return {
      // Prefixed, because the run is derived from the log rather than from a row
      // of its own: a bare `pr:142` would collide with anything else keyed on the
      // ref, and the ask panel resolves a row by this id.
      id: `dispatch:${r.key}`,
      kind: 'dispatch' as const,
      group: 'yours' as const,
      title: askLine(`Refused on ${r.pulses} pulses running — ${refusalLine(r.detail)}`, goalRef, state),
      goalRef,
      originRef: r.originRef ?? r.branch,
      opens: opensAt(goalRef, state),
      // The dispatch never started, so there is no run to send anybody to. An id
      // here would name the agent of some earlier, unrelated attempt.
      agentId: null,
      agentLabel: null,
      // Genuinely zero: what is held is a dispatch, not a part waiting on an
      // answer, and a count invented here would sort it against asks that really
      // are holding work.
      holding: 0,
      raisedAt: r.since,
    };
  });
}

const GROUP_RANK: Record<NeedGroup, number> = { blocking: 0, yours: 1 };

/**
 * The merged queue, ordered. Recovery first because while it is up no pulse runs
 * at all, so every other row is waiting on it whether or not it says so. Then
 * blocking before yours, then whatever holds the most work, then oldest first.
 */
export function buildNeedsYou(
  state: AppState,
  setup: SetupPayload | null = null,
  applied: readonly AppliedFix[] = [],
): NeedRow[] {
  const parts = state.planParts ?? [];
  const proposals = state.proposals ?? [];
  const rows: NeedRow[] = [];

  rows.push(...configRows(setup, applied));
  rows.push(...refusedDispatchRows(state));
  rows.push(...assignedPrRows(state));

  if ((state.recovery ?? []).length > 0) {
    rows.push({
      id: 'recovery',
      kind: 'recovery',
      group: 'blocking',
      title: `${state.recovery.length} runs were orphaned by a restart`,
      goalRef: null,
      originRef: null,
      // The one row with nowhere to go: the recovery banner above the console is
      // where it is answered, and it is already on screen.
      opens: null,
      agentId: null,
      agentLabel: null,
      holding: 0,
      raisedAt: '',
    });
  }

  for (const e of state.escalations.filter((x) => x.status === 'open')) {
    const proposal = proposals.find((p) => p.escalationId === e.id);
    const originRef = state.tasks.find((t) => t.id === e.taskId)?.originRef ?? e.context.originRef ?? null;
    const goalRef = goalOf(originRef, state);
    rows.push({
      id: e.id,
      kind: kindOf(e, proposal, originRef),
      group: 'blocking',
      title: askLine(escalationSummary(e, proposal, originRef, state), goalRef, state),
      goalRef,
      originRef,
      opens: opensAt(goalRef, state),
      agentId: e.agentId,
      agentLabel: agentLabelOf(e.agentId, state),
      holding: holdingForEscalation(e, state),
      raisedAt: e.createdAt,
    });
  }

  // Agents the account's usage limit stopped. Keyed on the agent id, which is
  // also what the row's control resumes — there is no escalation underneath one
  // of these, because there is no question in it to answer.
  for (const agentId of state.parkedOnLimit) {
    const agent = state.agents.find((a) => a.id === agentId);
    if (!agent) continue;
    const originRef = state.tasks.find((t) => t.id === agent.taskId)?.originRef ?? null;
    const goalRef = goalOf(originRef, state);
    rows.push({
      id: agentId,
      kind: 'limit',
      group: 'blocking',
      title: askLine(oneLine(agent.waitingReason ?? 'Parked: no usage allowance left right now.'), goalRef, state),
      goalRef,
      originRef,
      opens: opensAt(goalRef, state),
      agentId,
      agentLabel: agentLabelOf(agentId, state),
      holding: 0,
      // The park has no row of its own to be stamped, so the agent's own clock is
      // the honest reading: it is the last thing that happened to it.
      raisedAt: agent.startedAt,
    });
  }

  // The goal appraisal's refusal (#158). Like the profile gate below it, the hold has
  // no row of its own anywhere — no escalation, no human task, no parked agent —
  // so a queue reading only those four sources left the one verdict that stops a
  // goal's pickup legible on the tickets tab alone.
  //
  // Read off `world.issues` for the profile gate's reason, and filtered on the
  // watch tag for the tickets tab's: nothing appraises a goal nobody opted in, so a
  // verdict on an unwatched item is left over from before it was dropped, and the
  // drop outranks it.
  for (const issue of state.world.issues) {
    if (issue.state !== 'open' || issue.appraisal?.verdict !== 'unclear') continue;
    if (watchBucket(issue.labels, state.config.watchLabel) !== 'watched') continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      // Prefixed, for the profile gate's reason: the row is derived from the goal
      // rather than from a row of its own, and the ask panel resolves one by id.
      id: `intake:${goalRef}`,
      kind: 'intake',
      group: 'yours',
      // The line says which ask it is and which goal it is about, and no more: the
      // appraiser's sentence is prose somebody wrote and belongs in the band, which
      // quotes it whole rather than clamping the only account of why this is held.
      title: askLine('Held at intake', goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      // The appraiser that cast the verdict is gone, and nothing was ever parked on
      // the answer — an id here would point at a run that ended.
      agentId: null,
      agentLabel: null,
      // The hold stops the goal before there is a plan to hold any parts, so a
      // count invented here would sort it against asks that really are holding
      // work.
      holding: 0,
      raisedAt: issue.appraisal.decidedAt,
    });
  }

  // The goal-profile gate (#342). It is the one hold the harness raises with no
  // row of its own anywhere — no escalation, no human task, no parked agent — so
  // a queue reading only those four sources left it legible on one page, the
  // goal's, which is the page an operator has no reason to open for a goal that
  // looks like it simply has not come up yet. It expires on nothing but the
  // answer, so unseen meant stopped for good.
  //
  // Read off `world.issues` rather than the retained runs too: a goal the world
  // no longer carries is not one the funnel is refusing to dispatch, and a row
  // for it would be an ask about nothing.
  for (const issue of state.world.issues) {
    const appraisal = issue.appraisal;
    if (!appraisal?.awaitingProfileAnswer || appraisal.proposedProfile === null) continue;
    const goalRef = `issue:${issue.number}`;
    rows.push({
      // Prefixed, because the row is derived from the goal rather than from a row
      // of its own: an id of `issue:12` alone would collide with anything else
      // keyed on the goal, and the panel resolves an ask by this id.
      id: `profile:${goalRef}`,
      kind: 'profile',
      group: 'yours',
      title: askLine(`Wants to run on “${appraisal.proposedProfile}”`, goalRef, state),
      goalRef,
      originRef: goalRef,
      opens: opensAt(goalRef, state),
      // The appraiser that proposed it is gone, and it was never parked on the
      // answer — an id here would point at a run that ended.
      agentId: null,
      agentLabel: null,
      // Nothing is holding parts: the gate stops the goal before there is a plan
      // to hold any, and a count invented here would sort it against asks that
      // really are blocking work.
      holding: 0,
      raisedAt: appraisal.decidedAt,
    });
  }

  // Where a goal belongs on the backlog: the container it rolls up to, and the
  // area node that puts it on a board. Read off `world.issues` for the profile
  // gate's reason — a goal the world no longer carries is not one whose ticket
  // anybody is still grooming.
  //
  // Unlike every other row on this queue, **nothing is held**. The work is
  // dispatched, done and merged whatever the answer is; what is wrong is that the
  // ticket is invisible to whoever plans the backlog, which is a fault nobody sees
  // until they go looking for the work and it is not on the board. That is
  // `config_gap`'s reading exactly — the harness works, and something of the
  // operator's own is hiding the work from them — which is why the two share a
  // tone rather than this borrowing the profile gate's.
  //
  // The server decides which questions are open, because it is the only side that
  // can: the browser has neither the project's area tree nor the root node that
  // says what "unclassified" means.
  for (const issue of state.world.issues) {
    for (const ask of issue.appraisal?.placement ?? []) {
      const goalRef = `issue:${issue.number}`;
      rows.push({
        // Keyed by field as well as goal: a goal can carry both questions at once,
        // and the panel resolves an ask by this id.
        id: `placement:${ask.field}:${goalRef}`,
        kind: 'placement',
        group: 'yours',
        title: askLine(
          ask.field === 'parent'
            ? `No parent — #${ask.proposedParent} proposed`
            : `On no team's board — “${ask.proposedAreaPath}” proposed`,
          goalRef,
          state,
        ),
        goalRef,
        originRef: goalRef,
        opens: opensAt(goalRef, state),
        // The appraiser that proposed it is long gone, and nothing was ever parked
        // on the answer — an id here would point at a run that ended.
        agentId: null,
        agentLabel: null,
        // Genuinely zero, and not the profile gate's "nothing yet": this holds no
        // part because it holds nothing at all.
        holding: 0,
        raisedAt: issue.appraisal?.decidedAt ?? '',
      });
    }
  }

  for (const t of (state.humanTasks ?? []).filter((x) => x.status === 'open')) {
    const goalRef = goalOf(t.originRef, state);
    rows.push({
      id: t.id,
      kind: needKindOfTask(t.kind),
      group: 'yours',
      title: askLine(oneLine(t.title), goalRef, state),
      goalRef,
      originRef: t.originRef ?? null,
      opens: opensAt(goalRef, state),
      // A burn notice is *about* its agent — the run is the subject, and the rail
      // draws the id beside the row. Every other human task's `agentId` is the
      // agent that happened to ask, which is not what this field means, so it
      // stays null there rather than putting a bystander's id on the row.
      agentId: t.kind === 'burn' ? t.agentId : null,
      agentLabel: t.kind === 'burn' ? agentLabelOf(t.agentId, state) : null,
      holding: holdingForTask(t, parts),
      raisedAt: t.createdAt,
    });
  }

  return rows.sort((a, b) => {
    if ((a.kind === 'recovery') !== (b.kind === 'recovery')) return a.kind === 'recovery' ? -1 : 1;
    if (a.group !== b.group) return GROUP_RANK[a.group] - GROUP_RANK[b.group];
    if (a.holding !== b.holding) return b.holding - a.holding;
    return a.raisedAt.localeCompare(b.raisedAt);
  });
}
