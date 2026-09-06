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
import { Tag, type TagTone } from '../components/tag.js';

// → docs/spec/17-cockpit.md

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

const STATE_TONE: Record<string, TagTone | undefined> = { merged: 'green', closed: undefined, open: 'blue' };

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
        <Tag tone={STATE_TONE[state]} fill={STATE_TONE[state] !== undefined}>
          {state}
        </Tag>
        <CiMark pr={pr} />
        {/* The same mark the row carries, from the same record — the card in the
            rail is where its findings are read. */}
        <ReviewMark review={pr.review} now={view.now} />
        {pr.approved === true && (
          <Tag tone="green" fill>
            approved
          </Tag>
        )}
        {pr.mergeableState !== undefined && pr.mergeableState !== 'unknown' && (
          <Tag tone={pr.mergeableState === 'clean' ? 'green' : 'amber'} fill>
            {pr.mergeableState}
          </Tag>
        )}
        {page.waiting > 0 && (
          <Tag tone="amber" fill>
            {page.waiting} thread{page.waiting === 1 ? '' : 's'} on us
          </Tag>
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

function isOpenPr(pr: PullRequest): pr is OpenPullRequest {
  return pr.attention !== undefined && pr.health !== undefined && pr.ciVerdict !== undefined;
}

const THREAD_TONE: Record<PrThreadState, TagTone> = {
  reopened: 'amber',
  open: 'amber',
  answered: 'blue',
  resolved: 'green',
};

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
        <Tag tone={THREAD_TONE[thread.state]} fill title={THREAD_SAID[thread.state]}>
          {thread.state}
        </Tag>
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

function Message({ message, view }: { message: PrThreadMessage; view: CockpitView }): JSX.Element {
  return (
    <div className={`cn-thmsg ${message.ours ? 'cn-thours' : ''}`}>
      <span className="cn-thwho">
        {message.author}
        {message.ours && (
          <Tag tone="violet" fill>
            fleet
          </Tag>
        )}
      </span>
      <div className="cn-thtext">{renderMarkdown(message.body, view.state.refUrls)}</div>
    </div>
  );
}

const CHECK_TONE: Record<string, TagTone | undefined> = { dispatch: 'red', escalate: 'amber', ignored: undefined };

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
              <Tag tone={CHECK_TONE[row.kind]} fill={CHECK_TONE[row.kind] !== undefined}>
                {row.kind}
              </Tag>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

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
