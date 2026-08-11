import type { JSX } from 'react';
import type { HumanTask, PlanPart } from '../../../types.js';
import { HumanTaskActions } from '../../../components/HumanTaskActions.js';
import { renderMarkdown } from '../../../components/markdown.js';
import { refChip, relTime } from '../../../components/util.js';
import { Icon, Lamp } from './Sprite.js';
import { clip } from '../vocabulary.js';

/**
 * The Bench: work a person does by hand, at the top of the floor.
 *
 * It is drawn here rather than by the shared `HumanTaskPanel` because a list of
 * text lines is not a station. Everything else on this floor is a *machine* — a
 * bay, an assembler, a drill — with a lamp, a plate and a caption, and a panel
 * that dropped Classic's cards into a factory card read as a form pasted onto the
 * floor. What is **not** redrawn is the pair of buttons and the rule between
 * them: `HumanTaskActions` is shared, exactly as `BotCard` embeds the wired
 * `EscalationCard`, so the refusal that a decline needs a note has one
 * implementation whichever skin you are looking at.
 *
 * Three things the floor says that the classic card cannot:
 *
 * - **A station is a machine, so it has a lamp.** `warn` while it waits on you,
 *   `off` once it is done, `ghost` for one you declined — drawn but not built,
 *   which is what a declined step is. Never `bad`: red on this floor means one
 *   thing, an agent parked on a question only you can answer, and a task nobody
 *   is blocked on must not borrow it.
 * - **What it is holding.** A plan step's whole point is the work behind it, so
 *   the station counts the siblings that named it and says "3 assemblers
 *   waiting". That is a fact only the floor has the parts to state, and it is the
 *   difference between a chore and the reason the line is short.
 * - **The instructions are open, not folded away.** Classic collapses them
 *   because its column is a list you scan; the bench is a thing you stand at and
 *   work from, and a `<details>` you have to open first is a step between you and
 *   the job.
 */
export function Bench({
  tasks,
  parts,
  now,
  refUrls,
  onDone,
  onDecline,
}: {
  tasks: HumanTask[];
  /** Every plan part, so a step can count what it is holding up. */
  parts: PlanPart[];
  now: number;
  refUrls: Record<string, string>;
  onDone: (id: string) => Promise<unknown> | unknown;
  onDecline: (id: string, note: string) => Promise<unknown> | unknown;
}): JSX.Element {
  // Open first — they are the ones that want doing — then a short settled tail,
  // which is the record of what was asked and how it went.
  const open = tasks.filter((t) => t.status === 'open');
  const settled = tasks.filter((t) => t.status !== 'open').slice(0, 4);
  return (
    <div className="fx-bench">
      {[...open, ...settled].map((task) => (
        <Station
          key={task.id}
          task={task}
          holding={holdingCount(task, parts)}
          now={now}
          refUrls={refUrls}
          onDone={onDone}
          onDecline={onDecline}
        />
      ))}
    </div>
  );
}

/**
 * How many live parts are waiting on this one — the siblings that named its slug.
 *
 * Read off the parts rather than stored, and only for a task that *is* a part: a
 * standalone ask blocks nothing at all, so there is nothing to count and the
 * station says so by drawing no badge rather than by drawing a zero.
 */
function holdingCount(task: HumanTask, parts: PlanPart[]): number {
  if (!task.partId) return 0;
  const step = parts.find((p) => p.id === task.partId);
  if (!step) return 0;
  return parts.filter((p) => p.status !== 'retired' && p.planId === step.planId && p.dependsOn.includes(step.slug))
    .length;
}

function Station({
  task,
  holding,
  now,
  refUrls,
  onDone,
  onDecline,
}: {
  task: HumanTask;
  holding: number;
  now: number;
  refUrls: Record<string, string>;
  onDone: (id: string) => Promise<unknown> | unknown;
  onDecline: (id: string, note: string) => Promise<unknown> | unknown;
}): JSX.Element {
  const isOpen = task.status === 'open';
  const tone = isOpen ? 'warn' : task.status === 'declined' ? 'ghost' : 'off';
  const state = isOpen ? '' : task.status === 'declined' ? ' declined' : ' done';
  return (
    <article className={`fx-station fx-sunk${state}`}>
      <div className="fx-station-top">
        <Lamp tone={tone} />
        {/* A step for a person is `inserter` — the floor's hand — and a plain ask
            is `doc`: something to read and act on, with no machine behind it. */}
        <Icon name={task.partId ? 'inserter' : 'doc'} />
        <h3 className="fx-station-job">{task.title}</h3>
        <span className="fx-ref">
          {task.originRef
            ? (refChip(task.originRef, clip(task.originRef, 26), refUrls, {
                className: 'ext-ref',
                title: task.originRef,
              }) ?? clip(task.originRef, 26))
            : 'no origin'}{' '}
          · {relTime(task.createdAt, now)}
        </span>
      </div>

      <p className="fx-station-state">
        {isOpen ? (
          holding > 0 ? (
            <>
              <b>waiting on you</b> · {holding} {holding === 1 ? 'part' : 'parts'} cannot start until this is done
            </>
          ) : (
            <>
              <b>waiting on you</b> · nothing is held up by it
            </>
          )
        ) : task.status === 'declined' ? (
          <>
            <b>declined</b> · {holding > 0 ? `${holding} part(s) stay stopped — replan or abandon` : 'nothing was held'}
          </>
        ) : (
          <>
            <b>done</b> · {holding > 0 ? 'the work behind it was released' : 'settled'}
          </>
        )}
      </p>

      {/* Open on the floor rather than behind a summary: you are standing at the
          bench to do the thing, and the instructions are the thing. */}
      {isOpen && task.detail && <div className="fx-station-brief">{renderMarkdown(task.detail)}</div>}
      {/* A settlement's note is the whole account of why the work below it
          stopped, and it is what a replanning agent is handed verbatim. */}
      {!isOpen && task.resolution && <p className="fx-say">{task.resolution}</p>}

      <div className="fx-acts">
        <span className="fx-station-who">
          {task.agentId ? 'a bot asked for this' : task.partId ? 'a blueprint called for a person' : 'you filed this'}
        </span>
        {isOpen && <HumanTaskActions task={task} buttonClass="fx-btn" onDone={onDone} onDecline={onDecline} />}
      </div>
    </article>
  );
}
