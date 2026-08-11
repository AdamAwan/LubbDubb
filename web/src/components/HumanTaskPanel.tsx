import type { HumanTask } from '../types.js';
import { HumanTaskActions } from './HumanTaskActions.js';
import { renderMarkdown } from './markdown.js';
import { linkify, refLink, relTime } from './util.js';

/**
 * Work only a person can do — the one panel in the cockpit whose contents are
 * *yours to do*, not the fleet's.
 *
 * It is deliberately not in "Needs you" beside the escalations. An escalation is a
 * question holding one agent open on a socket, answered by typing back into its
 * session; these outlive every agent, survive a restart, and other work can be
 * made to wait on them. Filing the two together would put a thing that costs you
 * ten seconds beside a thing that costs you an afternoon, under one heading that
 * could only be honest about one of them.
 *
 * The two buttons and the rule between them are `HumanTaskActions`, shared with
 * the floor's bench: this component owns the classic card and nothing else.
 */
export function HumanTaskPanel({
  tasks,
  now,
  refUrls,
  onDone,
  onDecline,
}: {
  tasks: HumanTask[];
  now: number;
  refUrls: Record<string, string>;
  onDone: (id: string) => Promise<unknown> | unknown;
  onDecline: (id: string, note: string) => Promise<unknown> | unknown;
}) {
  if (tasks.length === 0) {
    return <p className="empty">Nothing is waiting on you — no agent has asked for anything only a person can do.</p>;
  }
  // Open first, because they are the ones that want doing; then a short settled
  // tail, which is the record of what was asked and how it went — a declined task
  // that vanished on being settled would take your own note with it.
  const open = tasks.filter((t) => t.status === 'open');
  const settled = tasks.filter((t) => t.status !== 'open').slice(0, 5);
  return (
    <div className="human-tasks">
      {[...open, ...settled].map((t) => (
        <HumanTaskCard key={t.id} task={t} now={now} refUrls={refUrls} onDone={onDone} onDecline={onDecline} />
      ))}
    </div>
  );
}

function HumanTaskCard({
  task,
  now,
  refUrls,
  onDone,
  onDecline,
}: {
  task: HumanTask;
  now: number;
  refUrls: Record<string, string>;
  onDone: (id: string) => Promise<unknown> | unknown;
  onDecline: (id: string, note: string) => Promise<unknown> | unknown;
}) {
  const isOpen = task.status === 'open';
  return (
    <div className={`human-task-card${isOpen ? '' : ' resolved'}`}>
      <div className="human-task-head">
        {/* A step of a plan is the one that holds other work up, so it says so
            before anything else — it is the difference between "please do this"
            and "nothing below this can start until you do". */}
        {task.partId && (
          <span
            className="chip small warn"
            title="A plan step: work that depends on it cannot start until this is done"
          >
            plan step
          </span>
        )}
        {task.originRef && <span className="chip small mono">{refLink(task.originRef, refUrls)}</span>}
        {!isOpen && <span className="chip small">{task.status}</span>}
        <span className="muted human-task-time">{relTime(task.createdAt, now)}</span>
      </div>
      <div className="human-task-title">{linkify(task.title, refUrls)}</div>
      {/* Collapsed like a finding's evidence, and markdown for its reason: the
          instructions are what you open once the headline has not told you enough,
          and a URL or a fenced snippet in them should render as one. */}
      {task.detail && (
        <details className="human-task-detail">
          <summary className="muted small">What to do</summary>
          <div className="human-task-detail-body">{renderMarkdown(task.detail)}</div>
        </details>
      )}
      {/* The settlement's own note, shown on the settled card rather than folded
          into the status chip: on a decline it is the whole account of why the
          work below it stopped, and it is what a replanning agent is given. */}
      {!isOpen && task.resolution && <div className="human-task-resolution muted">{task.resolution}</div>}
      <div className="human-task-foot">
        {/* Who is asking, always — it is most of how you judge whether to do it.
            Three cases and no fourth: an agent that hit something it could not do,
            a planner that declared the step up front, or you. */}
        <span className="muted">
          {task.agentId ? (
            <>asked by an agent working {task.originRef ? refLink(task.originRef, refUrls) : 'an untracked task'}</>
          ) : task.partId ? (
            <>planned as a step for a person</>
          ) : (
            <>filed by you</>
          )}
        </span>
        {isOpen && <HumanTaskActions task={task} onDone={onDone} onDecline={onDecline} />}
      </div>
    </div>
  );
}
