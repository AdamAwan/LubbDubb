import { isRecoveryVerdict } from '../agents/crashRecovery.js';
import { proposedCaveats } from '../plans/planCaveats.js';
import type { DesktopToolFactory } from './desktopContext.js';
import { toolError, toolJson } from './protocol.js';

/**
 * The two "Needs you" rows that are decisions rather than questions: an act the
 * harness proposed, and a run a crash orphaned.
 *
 * They were left off this channel at first and the operator asked for them: the
 * point of the desktop channel is that the harness can be run from wherever they
 * are, and an inbox with two kinds of row that can only be cleared in a browser
 * is an inbox that fills up while they are away. So the fence moved, and this
 * module is where it now sits.
 *
 * ## What accepting a proposal actually does
 *
 * `ProposalDesk.accept` is **one door for five kinds**, and they are not equally
 * reversible:
 *
 * - `plan` — releases a rule. The decomposition starts scheduling parts. Nothing
 *   leaves the machine, but the fleet begins spending on it.
 * - `plan_amendment` — replaces a running plan's document with the amended one.
 * - `shortfall` — sends a goal back to a planner, or appends a follow-up part.
 * - `reply_draft` — **posts a comment to the tracker or the pull request.**
 * - `merge` — **merges the pull request.**
 *
 * The last two reach outside this machine and cannot be taken back. That is said
 * in the tool's own description and again in what it hands back, because the
 * failure worth preventing here is not a refusal — the operator asked for these —
 * but a session that accepts a `merge` believing it approved a plan.
 * {@link proposalRead} exists so that never has to be guessed: it is the read that
 * says which kind a row is and what accepting it will do, in those words.
 *
 * **The caveat gate is not bypassed.** A plan that raises caveats is not released
 * until the verdict names each one, exactly as the cockpit's checkboxes require,
 * and the refusal hands back the ids still unticked so a session can acknowledge
 * them deliberately rather than by passing a flag.
 */

/** What each proposal kind does when accepted, in the words the reply uses. */
const ACCEPT_MEANS: Record<string, string> = {
  plan: 'the plan is released and the harness will start scheduling its parts. Nothing left this machine, but the fleet begins spending on it now.',
  plan_amendment:
    "the running plan's document is replaced with the amended one. Parts already dispatched keep running.",
  shortfall:
    'the goal was sent back — either to a planner for a rewrite or as a follow-up part, whichever the proposal named.',
  reply_draft: 'the comment was POSTED to the tracker or pull request. It is public and cannot be unsent.',
  merge: 'the pull request was MERGED. This cannot be undone from here.',
};

export const proposalRead: DesktopToolFactory = (deps) => ({
  description:
    'Read one proposed act in full before deciding it: which kind it is, what accepting it would actually do, ' +
    'the act itself, and any caveats that must be acknowledged first. Call this before proposal_decide — two ' +
    'of the five kinds publish something that cannot be taken back, and the id alone does not say which.',
  inputSchema: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The proposal id, from attention_read.' } },
    required: ['id'],
  },
  handler: (args) => {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return toolError('id required — take it from attention_read.');
    const proposal = deps.store.getProposal(id);
    if (!proposal) return toolError(`No proposal "${id}". Call attention_read for what is actually pending.`);
    const caveats = proposedCaveats(proposal);
    return toolJson({
      id: proposal.id,
      kind: proposal.kind,
      ref: proposal.ref,
      status: proposal.status,
      // The validated act the executor was about to run, verbatim: accepting runs
      // *that*, not a re-derivation of it from the world as it is now.
      action: proposal.action,
      note: proposal.note,
      acceptWouldMean: ACCEPT_MEANS[proposal.kind] ?? 'the act is performed as recorded.',
      // Ids, because they are what `proposal_decide` takes — a label a session can
      // read back to the operator and cannot then pass is a gate it cannot clear.
      caveats: caveats.map((c) => ({ id: c.id, label: c.label, detail: c.detail })),
      backOutAvailable: proposal.kind === 'plan',
      next:
        proposal.status !== 'pending'
          ? 'This is already decided. Nothing further is needed on it.'
          : proposal.kind === 'merge' || proposal.kind === 'reply_draft'
            ? 'Accepting this publishes something that cannot be taken back. Say plainly what it will do and get ' +
              'the operator to say yes to that, not to "the proposal".'
            : 'Say what accepting would do, and decide it with proposal_decide.',
    });
  },
});

export const proposalDecide: DesktopToolFactory = (deps) => ({
  description:
    'Decide one proposed act. "accept" PERFORMS it — for a plan that releases the decomposition to be worked, ' +
    'but for a merge it merges the pull request and for a reply it posts the comment, and neither can be ' +
    'undone. "reject" performs nothing. A plan also has two verdicts about the ticket rather than about the ' +
    'plan: "close_ticket" and "hold_ticket". Read it with proposal_read first.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'The proposal id, from attention_read or proposal_read.' },
      verdict: {
        type: 'string',
        enum: ['accept', 'reject', 'close_ticket', 'hold_ticket'],
        description:
          '"accept" performs the act. "reject" refuses it — for a plan that sends the goal back to a planner. ' +
          '"close_ticket" closes the ticket with your note posted on it as the reason; "hold_ticket" takes the ' +
          'watch tag off so nothing works it. The last two are for a plan only, and are for when the *ticket* ' +
          'is the problem rather than the plan.',
      },
      note: {
        type: 'string',
        description: 'The reason, recorded with the verdict. Required for "close_ticket" — it is posted on the ticket.',
      },
      acknowledged: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Caveat ids from proposal_read, for a plan that raises them. A plan is not released until every one ' +
          'is named. Acknowledge them because the operator has read them, not to clear the gate.',
      },
    },
    required: ['id', 'verdict'],
  },
  handler: async (args) => {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    if (!id) return toolError('id required — take it from attention_read.');
    const verdict = args.verdict;
    if (verdict !== 'accept' && verdict !== 'reject' && verdict !== 'close_ticket' && verdict !== 'hold_ticket')
      return toolError('verdict must be "accept", "reject", "close_ticket" or "hold_ticket".');
    const note = typeof args.note === 'string' && args.note.trim() ? args.note.trim() : undefined;

    // Read before the transition, so the reply can say which kind was performed and
    // a wrong-kind verdict is refused rather than settled into an effect that
    // cannot run.
    const standing = deps.store.getProposal(id);
    if (!standing) return toolError(`No proposal "${id}". Call attention_read for what is actually pending.`);
    if (standing.status !== 'pending')
      return toolError(
        `Proposal ${id} is already ${standing.status}${standing.note ? ` — "${standing.note}"` : ''}. ` +
          'Somebody has decided it; nothing more is needed on it.',
      );
    const kind = standing.kind;
    const desk = deps.proposals();

    if (verdict === 'close_ticket' || verdict === 'hold_ticket') {
      if (kind !== 'plan')
        return toolError(
          'These two verdicts are about the ticket rather than the plan, and only a plan proposal has a ticket ' +
            `to back out of — this one is a "${kind}". Accept it or reject it.`,
        );
      if (verdict === 'close_ticket' && note === undefined)
        return toolError(
          'note is required to close a ticket — it is posted on the ticket as the reason. A ticket closed for ' +
            'reasons nobody can read is what this refuses.',
        );
      const result = await desk.backOut(id, verdict === 'close_ticket' ? 'close' : 'hold', note);
      if (!result) return toolError('The proposal was decided by something else just now. Nothing was changed.');
      return toolJson({
        id,
        verdict,
        detail: result.detail,
        means:
          verdict === 'close_ticket'
            ? 'the ticket is closed with your note posted on it, and the watch tag is off. Nothing was built.'
            : 'the watch tag is off so nothing works it, and the ticket is left open. Nothing was built.',
      });
    }

    if (verdict === 'reject') {
      const result = desk.reject(id, note);
      if (!result) return toolError('The proposal was decided by something else just now. Nothing was changed.');
      return toolJson({
        id,
        verdict,
        kind,
        detail: result.detail,
        means:
          kind === 'plan'
            ? 'nothing was sent, and the goal goes back to a planner for a fresh decomposition. If the ticket ' +
              'itself is the problem, that is close_ticket or hold_ticket instead.'
            : 'nothing was sent, and the rule that proposed it will not ask again.',
      });
    }

    const acknowledged = Array.isArray(args.acknowledged) ? (args.acknowledged as string[]) : [];
    const accepted = await desk.accept(id, note, acknowledged);
    if (!accepted) return toolError('The proposal was decided by something else just now. Nothing was changed.');
    if ('unacknowledged' in accepted)
      return toolJson({
        id,
        verdict: 'refused',
        // Not an `isError`: the caller did nothing wrong and the next step is exact,
        // which is what the ids are for.
        reason: `This plan raises ${accepted.unacknowledged.length} thing(s) that must be acknowledged before it can be approved.`,
        unacknowledged: accepted.unacknowledged.map((c) => ({ id: c.id, label: c.label, detail: c.detail })),
        next:
          'Put these to the operator in their own words, and pass their ids in `acknowledged` once they have ' +
          'read them. They are the planner saying what it is least sure about, so acknowledging one nobody read ' +
          'is the whole of what this gate exists to stop.',
      });
    return toolJson({
      id,
      verdict: 'accept',
      kind,
      outcome: accepted.outcome,
      detail: accepted.detail,
      means: ACCEPT_MEANS[kind] ?? 'the act was performed as recorded.',
    });
  },
});

export const recoveryDecide: DesktopToolFactory = (deps) => ({
  description:
    'Decide what happens to a run a crash or a restart orphaned: "restore" re-opens the agent in its existing ' +
    'session and worktree, "requeue" throws the run away and puts the work back for a fresh agent, "remove" ' +
    'drops it entirely. Orphaned runs hold the harness back from queueing new work, so an inbox with one in ' +
    'it is a fleet doing less than it could.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description:
          'The task id from attention_read — the task, not the agent: the unit of recovery is the work, and an ' +
          'agent is one thing that may or may not have been attached to it.',
      },
      verdict: { type: 'string', enum: ['restore', 'requeue', 'remove'] },
    },
    required: ['taskId', 'verdict'],
  },
  handler: (args) => {
    const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
    if (!taskId) return toolError('taskId required — take it from attention_read.');
    if (typeof args.verdict !== 'string' || !isRecoveryVerdict(args.verdict))
      return toolError('verdict must be "restore", "requeue" or "remove".');
    const result = deps.recovery().decide(taskId, args.verdict);
    // The desk's refusals are the operator-facing ones — "not restorable", and why
    // — so they are handed back verbatim rather than reworded into a generic
    // failure that says nothing about which of the three verdicts is still open.
    if (!result.ok) return toolError(result.error);
    return toolJson({
      taskId,
      verdict: args.verdict,
      detail: result.outcome.detail,
      // The job a `requeue` filed, so a session can say where the work went rather
      // than that it went somewhere.
      requeuedAs: result.outcome.job?.id ?? null,
      means:
        args.verdict === 'restore'
          ? 'the agent is running again in the worktree it left, and it keeps whatever it had already done.'
          : args.verdict === 'requeue'
            ? 'the run is gone and the work is back in the queue for a fresh agent, which starts from nothing.'
            : 'the work is dropped. Nothing will pick it up again unless it comes back through the world.',
    });
  },
});
