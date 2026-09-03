import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import type { CockpitView } from '../view/viewModel.js';
import type { PrPageView } from '../view/prPage.js';
import type { OpenPullRequest, PrReviewThread, PrThreadMessage, PrThreadState, PullRequest } from '../types.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { CONTROL_CLASS } from '../components/controls.js';
import { ReviewPackControl } from '../components/ReviewPackControl.js';
import { CiMark } from '../components/CiMark.js';
import { ReviewDetail, ReviewMark } from '../components/ReviewMark.js';
import { PrLink, Ref } from '../components/refs.js';
import { renderMarkdown } from '../components/markdown.js';
import { relTime } from '../components/util.js';
import { CourtChip } from './GoalPage.js';
import { HeadRow } from '../components/panel.js';

/**
 * One pull request, in full — the page the review-pack control used to sit on a
 * row because there was nowhere else to put it.
 *
 * What it is *for* is the review: which threads are still on the fleet, which are
 * with the reviewer, which are finished, and the one control that moves a thread
 * between those — the reopen. Everything else on the page is context for that
 * question, and every reading of it is quoted from the server rather than re-made
 * here: `attention`, `health` and `ciVerdict` are the harness's own three
 * verdicts, and a client-side second opinion about a merge is the drift that
 * outlives the change that introduces it.
 * → `docs/spec/17-cockpit.md#the-pull-request-page`
 */
export function PrPage({
  page,
  view,
  actions,
}: {
  page: PrPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="cn-goal">
      <Masthead page={page} view={view} actions={actions} />
      <div className="cn-gcols">
        <Threads page={page} view={view} actions={actions} />
        <div className="cn-gcol">
          <Review page={page} view={view} />
          <Checks pr={page.pr} />
          <Merge page={page} />
          <Work page={page} view={view} actions={actions} />
        </div>
      </div>
    </div>
  );
}

/** The chip a pull request's own state takes. A closed one is spent; a merged one landed. */
const STATE_TONE: Record<string, string> = { merged: 'cn-ok', closed: 'cn-mute', open: 'cn-info' };

function Masthead({
  page,
  view,
  actions,
}: {
  page: PrPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { pr } = page;
  const state = pr.state ?? (pr.merged ? 'merged' : 'open');
  return (
    <section className={`cn-card cn-prhead ${page.open ? '' : 'cn-spent'}`}>
      <div className="cn-prtitle">
        <span className="cn-prnum">#{pr.number}</span>
        <h2>{pr.title}</h2>
      </div>
      <div className="cn-prbranch">
        {pr.branch}
        {pr.baseBranch !== undefined && <> → {pr.baseBranch}</>}
        {pr.headSha !== undefined && <> · head {pr.headSha.slice(0, 7)}</>}
        {pr.author !== undefined && <> · opened by {pr.author}</>}
      </div>
      <div className="cn-prchips">
        <i className={`cn-chip ${STATE_TONE[state] ?? ''}`}>{state}</i>
        <CiMark pr={pr} />
        {/* The same mark the row carries, from the same record — the card in the
            rail is where its findings are read. */}
        <ReviewMark review={pr.review} now={view.now} />
        {pr.approved === true && <i className="cn-chip cn-ok">approved</i>}
        {pr.mergeableState !== undefined && pr.mergeableState !== 'unknown' && (
          <i className={`cn-chip ${pr.mergeableState === 'clean' ? 'cn-ok' : 'cn-warn'}`}>{pr.mergeableState}</i>
        )}
        {page.waiting > 0 && (
          <i className="cn-chip cn-warn">
            {page.waiting} thread{page.waiting === 1 ? '' : 's'} on us
          </i>
        )}
        {/* Whose court, quoted from the server — only an open pull request has one,
            because nothing is waiting on anybody once it has left the open set. */}
        {page.open && isOpenPr(pr) && <CourtChip pr={pr} now={view.now} />}
        <span className="cn-refs">
          {/* The goal alone: a ref onto *this* pull request now opens this very
              page, and the provider's own is the control below rather than a
              token that looks like a way somewhere else. */}
          {page.goalRef !== null && <Ref to={page.goalRef} />}
        </span>
      </div>
      {/* The pack rides the masthead rather than the rail: it is a reading *of this
          diff*, which is what the masthead is about, and the control reaches its own
          route — which console markup may not, but embedding a component that does
          is not reaching. A closed pull request cannot be asked about; the pack it
          already has stays readable. */}
      <div className="cn-prpack">
        <PrLink number={pr.number} className={CONTROL_CLASS}>
          Open pull request ↗
        </PrLink>
        <ReviewPackControl
          prNumber={pr.number}
          headSha={pr.headSha ?? null}
          canAsk={page.open}
          onOpen={() => actions.viewReviewPack(pr.number)}
        />
      </div>
    </section>
  );
}

/** Whether the server folded this row's three verdicts — true of every open pull request. */
function isOpenPr(pr: PullRequest): pr is OpenPullRequest {
  return pr.attention !== undefined && pr.health !== undefined && pr.ciVerdict !== undefined;
}

/** What each thread state is called on the page, and the tone it carries. */
const THREAD_TONE: Record<PrThreadState, string> = {
  reopened: 'cn-warn',
  open: 'cn-warn',
  answered: 'cn-info',
  resolved: 'cn-ok',
};

/**
 * What each state *means*, on the chip's own title — the sentence that stops an
 * operator having to learn the vocabulary from the counts.
 */
const THREAD_SAID: Record<PrThreadState, string> = {
  reopened: 'You put this back to the fleet — it reads as unanswered and will be picked up again',
  open: 'Nobody from the fleet has answered this yet',
  answered: 'The fleet replied last; this is with the reviewer',
  resolved: 'The reviewer closed this thread',
};

function Threads({
  page,
  view,
  actions,
}: {
  page: PrPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const { threads, counts } = page;
  return (
    <section className="cn-card">
      <h3>
        Review threads
        {threads !== null && (
          <i className="cn-n">
            {threads.length} · {counts.reopened > 0 && `${counts.reopened} reopened · `}
            {counts.open} open · {counts.answered} answered · {counts.resolved} resolved
          </i>
        )}
      </h3>
      {/* Absent and empty are different answers and are said differently. A
          provider that does not report threads leaves the field unset, and drawing
          that as "no threads" would claim nobody has reviewed this — the opposite
          of what is known. → docs/spec/07-pull-requests.md#review-threads */}
      {threads === null ? (
        <p className="cn-empty">This provider does not report review threads, so there is nothing to draw here.</p>
      ) : threads.length === 0 ? (
        <p className="cn-empty">Nobody has left a review comment on this pull request.</p>
      ) : (
        <div className="cn-threads">
          {threads.map((thread) => (
            <Thread key={thread.id} thread={thread} page={page} view={view} actions={actions} />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * One thread: where it hangs, who said what, and where it stands.
 *
 * The reopen is offered on a thread the fleet is **not** already going to answer
 * — an `answered` or `resolved` one — because that is the whole of what it is
 * for: an open thread is already work, and a control that claimed to reopen it
 * would be a button that changes nothing. On a reopened thread the same control
 * takes the ask back, which is the only way out of a mark the operator set by
 * mistake. Both are refused on a pull request that has left the open set: nothing
 * acts on one, so the fleet would never come back to the thread.
 */
function Thread({
  thread,
  page,
  view,
  actions,
}: {
  thread: PrReviewThread;
  page: PrPageView;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const reopened = thread.state === 'reopened';
  const canReopen = page.open && (reopened || thread.state === 'answered' || thread.state === 'resolved');
  return (
    <article className={`cn-thread cn-th-${thread.state}`}>
      <HeadRow className="cn-throw">
        <i className={`cn-chip ${THREAD_TONE[thread.state]}`} title={THREAD_SAID[thread.state]}>
          {thread.state}
        </i>
        {thread.path !== undefined && (
          <span className="cn-thwhere" title={thread.path}>
            {thread.path}
            {thread.line !== undefined && `:${thread.line}`}
          </span>
        )}
        {thread.reopenedAt !== undefined && (
          <span className="cn-sub">reopened {relTime(thread.reopenedAt, view.now)}</span>
        )}
        {canReopen && (
          <AsyncButton
            className={CONTROL_CLASS}
            onClick={() => actions.reopenThread(page.pr.number, thread.id, !reopened)}
            title={
              reopened
                ? 'Take the ask back — the thread goes back to standing as the provider has it'
                : 'Put this back to the fleet: it reads as unanswered, and the next pulse dispatches for it'
            }
          >
            {reopened ? 'Never mind' : 'Reopen'}
          </AsyncButton>
        )}
      </HeadRow>
      <Message message={{ id: thread.id, author: thread.author, body: thread.body, ours: false }} view={view} />
      {/* The replies hang under the comment they answer rather than beside it: a
          flat run of messages made a thread of three read as three threads. */}
      {thread.replies.length > 0 && (
        <div className="cn-threplies">
          {thread.replies.map((reply) => (
            <Message key={reply.id} message={reply} view={view} />
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * One message in a thread. A reply the harness wrote is marked as such — on a
 * single-operator deployment the fleet posts under the operator's own credential,
 * so the name alone cannot say who is talking, and "the fleet already answered
 * this" is the thing the reader most needs to know before reopening it.
 */
function Message({ message, view }: { message: PrThreadMessage; view: CockpitView }): JSX.Element {
  return (
    <div className={`cn-thmsg ${message.ours ? 'cn-thours' : ''}`}>
      <span className="cn-thwho">
        {message.author}
        {message.ours && <span className="cn-thmark">fleet</span>}
      </span>
      <div className="cn-thtext">{renderMarkdown(message.body, view.state.refUrls)}</div>
    </div>
  );
}

/** The tone a check's classification takes — the policy's three categories, and the aggregate. */
const CHECK_TONE: Record<string, string> = { dispatch: 'cn-bad', escalate: 'cn-warn', ignored: 'cn-mute' };

/**
 * The checks behind the aggregate, in the policy's own three categories: what the
 * harness will fix, what it will put to a person, and what it has been told to
 * leave alone. Every name comes off `ciVerdict` — none is written here.
 */
function Checks({ pr }: { pr: PullRequest }): JSX.Element {
  const verdict = pr.ciVerdict;
  const rows = [
    ...(verdict?.dispatch ?? []).map((c) => ({ name: c.name, kind: 'dispatch' })),
    ...(verdict?.escalate ?? []).map((c) => ({ name: c.name, kind: 'escalate' })),
    ...(verdict?.ignored ?? []).map((c) => ({ name: c.name, kind: 'ignored' })),
  ];
  return (
    <section className="cn-card">
      <h3>
        Checks <i className="cn-n">{pr.ciStatus}</i>
      </h3>
      {rows.length === 0 ? (
        // Withheld and unreported are the same silence to a reader and are worded
        // as one: nothing here is a claim that the build is green — the aggregate
        // above it is the only thing that speaks.
        <p className="cn-empty">
          {pr.ciChecksWithheld === true
            ? 'This deployment withholds the per-check detail; the aggregate above is the whole reading.'
            : 'The provider reported no per-check detail for this pull request.'}
        </p>
      ) : (
        <div className="cn-rows">
          {rows.map((row) => (
            <div className="cn-row" key={`${row.kind}:${row.name}`}>
              <span className="cn-grow">
                <b className="cn-name">{row.name}</b>
              </span>
              <i className={`cn-chip ${CHECK_TONE[row.kind] ?? ''}`}>{row.kind}</i>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Why this pull request cannot merge, in the server's own words (`prHealth`), and
 * nothing when it can. A card that said "healthy" on every green pull request
 * would be furniture; the masthead's chips already say the state.
 */
/**
 * What the fleet's reviewer said, in full — the mode, why the triage chose it,
 * and what it found.
 *
 * Nothing at all where the deployment has no fleet review, which is the same
 * silence the mark keeps: a card headed "Fleet review" saying nothing was
 * reviewed is a claim about a feature nobody turned on. The console owns the card
 * around it and the shared component owns what is in it, so the two surfaces that
 * draw this record cannot come to word it differently.
 */
function Review({ page, view }: { page: PrPageView; view: CockpitView }): JSX.Element | null {
  const review = page.pr.review;
  if (review === undefined) return null;
  return (
    <section className="cn-card">
      <h3>
        Fleet review
        {review.mode !== null && <i className="cn-n">{review.mode}</i>}
      </h3>
      <ReviewDetail review={review} now={view.now} />
    </section>
  );
}

function Merge({ page }: { page: PrPageView }): JSX.Element | null {
  const reasons = page.pr.health?.reasons ?? [];
  if (reasons.length === 0) return null;
  return (
    <section className="cn-card">
      <h3>Held up by</h3>
      <div className="cn-rows">
        {reasons.map((reason) => (
          <div className="cn-row" key={reason}>
            <i className="cn-lamp cn-wait" />
            <span className="cn-grow">
              <b className="cn-name">{reason}</b>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Every dispatch onto this branch, newest first — what the fleet has already been
 * asked to do here, which is the context a reopen is decided in. The row is a way
 * into the run, as every row naming an agent is.
 */
function Work({ page, view, actions }: { page: PrPageView; view: CockpitView; actions: CockpitActions }): JSX.Element {
  return (
    <section className="cn-card">
      <h3>
        Work on this branch <i className="cn-n">{page.work.length}</i>
      </h3>
      {page.work.length === 0 ? (
        <p className="cn-empty">No agent has been dispatched onto this branch.</p>
      ) : (
        <div className="cn-rows">
          {page.work.map((task) => (
            <div className="cn-row" key={task.id}>
              <span className="cn-grow">
                <b className="cn-name">{task.title}</b>
                <span className="cn-sub">
                  {task.status} · {relTime(task.updatedAt, view.now)}
                  {task.rule ? ` · ${task.rule}` : ''}
                </span>
              </span>
              {task.agentId !== null && (
                <button type="button" className={CONTROL_CLASS} onClick={() => actions.select(task.agentId)}>
                  Read
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
