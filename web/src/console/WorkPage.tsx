import { useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { ListenItem, OpenPullRequest } from '../types.js';
import type { NeedRow } from '../view/needsYou.js';
import { buildGoalTrack } from '../view/goalStages.js';
import { plural } from '../view/plural.js';
import {
  byFeature,
  goalInChat,
  goalsOfWork,
  holdsOf,
  inChat,
  inFlight,
  laterStages,
  NO_GOAL,
  prReading,
  strayPrs,
  workParts,
  type FeatureGroup,
  type GoalWork,
  type Hold,
} from '../view/workPage.js';
import { BareButton } from '../components/button.js';
import { ControlButton } from '../components/controls.js';
import { Icon } from '../components/icons.js';
import { InstructionModal } from '../components/InstructionModal.js';
import { Ref, refLabel } from '../components/refs.js';
import { Track } from '../components/track.js';
import { fmtUsd } from '../components/util.js';
import { AskCard } from './askCard.js';
import { agentLamp } from './fleetRows.js';
import { ClaudeButton, ListenerStatus, SentLine } from './NeedsYouPage.js';
import { PICKUP_WORD } from './Overview.js';
import { PrCards } from './PrCards.js';

// → docs/spec/17-cockpit.md#the-work-tab

interface Props {
  view: CockpitView;
  actions: CockpitActions;
}

/** A pull request's chat control: the mark where it is already in the chat, the button where it waits on the operator. */
type Talk = (pr: OpenPullRequest) => ReactNode;

export function WorkPage({ view, actions }: Props): JSX.Element {
  const all = goalsOfWork(view);
  const current = all.filter(inFlight);
  const later = all.filter((w) => !inFlight(w));
  const features = byFeature(current);
  const headed = features.some((f) => f.number !== null);
  return (
    <div className="cn-wk cn-plainrefs">
      <header className="cn-ny-head">
        <h2>Work</h2>
        <span className="cn-ny-counts">
          {plural(current.filter((g) => g.ref !== NO_GOAL).length, 'goal')} in flight · ⚡ puts one first in the queue
        </span>
        <ListenerStatus asks={view.needsYou} listener={view.state.listener} folder={view.state.config.desktopFolder} />
      </header>
      {features.map((feature) => (
        <Feature key={feature.number ?? NO_GOAL} feature={feature} headed={headed} view={view} actions={actions} />
      ))}
      {later.length > 0 && <NotInFlight goals={later} view={view} actions={actions} />}
    </div>
  );
}

function Feature({ feature, headed, view, actions }: Props & { feature: FeatureGroup; headed: boolean }): JSX.Element {
  const { number } = feature;
  const folded = number !== null && view.collapsedFeatures.has(number);
  return (
    <section className="cn-wk-feature">
      {headed && (
        <FoldHead
          title={feature.title ?? 'No feature'}
          count={feature.goals.length}
          folded={folded}
          onToggle={number === null ? null : () => actions.collapseFeature(number, !folded)}
        />
      )}
      {!folded && feature.goals.map((work) => <GoalRow key={work.ref} work={work} view={view} actions={actions} />)}
    </section>
  );
}

function NotInFlight({ goals, view, actions }: Props & { goals: readonly GoalWork[] }): JSX.Element {
  const open = view.workLater;
  return (
    <section className="cn-wk-feature">
      <FoldHead
        title="Not in flight — appraising, queued or delivered"
        count={goals.length}
        folded={!open}
        onToggle={() => actions.setWork({ workLater: !open })}
      />
      {open && goals.map((work) => <GoalRow key={work.ref} work={work} view={view} actions={actions} />)}
    </section>
  );
}

function FoldHead({
  title,
  count,
  folded,
  onToggle,
}: {
  title: string;
  count: number;
  folded: boolean;
  onToggle: (() => void) | null;
}): JSX.Element {
  const body = (
    <>
      {onToggle !== null && <span aria-hidden="true">{folded ? '▸' : '▾'}</span>}
      <b>{title}</b>
      <em>{plural(count, 'goal')}</em>
    </>
  );
  if (onToggle === null) return <div className="cn-wk-fhead">{body}</div>;
  return (
    <BareButton
      usage={folded ? 'work.expand' : 'work.close'}
      className="cn-wk-fhead"
      onClick={onToggle}
      aria-expanded={!folded}
    >
      {body}
    </BareButton>
  );
}

function GoalRow({ work, view, actions }: Props & { work: GoalWork }): JSX.Element {
  const open = view.workRow === work.ref;
  const priority = work.issue?.priority != null;
  const planned = work.page !== null && work.page.parts.length > 0;
  const holds = holdsOf(work, view).filter((h) => !open || (h.tone === 'hold' && !h.part));
  const talk: Talk = (pr) => <PrTalk pr={pr} open={open} view={view} actions={actions} />;
  return (
    <div className={`cn-wk-row${priority ? ' cn-wk-priority' : ''}${open ? ' cn-wk-open' : ''}`}>
      <RowHead work={work} open={open} view={view} actions={actions} />
      {open && work.asks.length > 0 && <NeedsYou asks={work.asks} view={view} actions={actions} />}
      {open && planned && work.page !== null ? (
        <>
          <PartsLine work={work} talk={talk} />
          <PrsLine prs={strayPrs(work.page, work.prs)} talk={talk} />
        </>
      ) : (
        <PrsLine prs={work.prs} talk={talk} />
      )}
      <HeldLine holds={holds} />
      {open && <LaterLine work={work} />}
      {open && !planned && work.prs.length > 0 && (
        <div className="cn-wk-inset">
          <PrCards cards={work.prs.map((pr) => ({ pr, goal: false }))} view={view} actions={actions} />
        </div>
      )}
    </div>
  );
}

function RowHead({ work, open, view, actions }: Props & { work: GoalWork; open: boolean }): JSX.Element {
  const { issue } = work;
  const track = work.page === null ? null : buildGoalTrack(work.page.parts);
  return (
    <div className="cn-wk-line">
      <BareButton
        usage={open ? 'work.close' : 'work.expand'}
        className="cn-wk-fold"
        onClick={() => actions.setWork({ workRow: open ? null : work.ref })}
        aria-expanded={open}
        title={open ? 'Fold' : 'Show what it needs, its parts and what comes later'}
      >
        {open ? '▾' : '▸'}
      </BareButton>
      <RowTitle work={work} actions={actions} />
      {issue !== undefined && (
        <span className="cn-wk-stage">{PICKUP_WORD[issue.pickup.status] ?? issue.pickup.status}</span>
      )}
      {track !== null && track.total > 0 && (
        <span className="cn-wk-meta">
          <Track track={track} />
          {track.merged}/{track.total}
        </span>
      )}
      {work.agents[0] !== undefined && (
        <span className="cn-wk-meta" title={work.agents.map((a) => view.taskFor(a)?.title ?? a.id).join('\n')}>
          <i className={`cn-lamp ${agentLamp(work.agents[0], view)}`} />
          {work.agents.length}
        </span>
      )}
      {goalInChat(view, work) && (
        <span className="cn-wk-chat" title="Something of this goal's is in your Claude chat">
          <Icon name="chat" /> in Claude
        </span>
      )}
      {issue?.spend != null && <span className="cn-wk-meta">{fmtUsd(issue.spend.costUsd)}</span>}
      {issue !== undefined && <Steer issue={issue} open={open} actions={actions} />}
    </div>
  );
}

function RowTitle({ work, actions }: { work: GoalWork; actions: CockpitActions }): JSX.Element {
  if (work.ref === NO_GOAL) return <b className="cn-wk-title">No goal</b>;
  return (
    <>
      <BareButton
        usage={{ counted: 'goal.view' }}
        className="cn-wk-title"
        onClick={() => actions.selectGoal(work.ref)}
        title="Open the full goal page"
      >
        {work.issue?.title ?? refLabel(work.ref)}
      </BareButton>
      <span className="cn-refs">
        <Ref to={work.ref} />
      </span>
    </>
  );
}

function Steer({
  issue,
  open,
  actions,
}: {
  issue: NonNullable<GoalWork['issue']>;
  open: boolean;
  actions: CockpitActions;
}): JSX.Element {
  const [instructing, setInstructing] = useState(false);
  const priority = issue.priority !== null;
  return (
    <>
      {open && (
        <ControlButton
          icon="pen"
          usage="goal.expand"
          onClick={() => setInstructing(true)}
          title="Say what you want done next — your words go to the next agent on this goal"
        >
          Instruct
        </ControlButton>
      )}
      <ControlButton
        icon="bolt"
        tone={priority ? 'on' : undefined}
        usage={priority ? 'priority.undo' : 'priority.create'}
        onClick={() => void actions.setGoalPriority(issue.number, !priority)}
        title={priority ? 'Prioritised — click to hand the queue back' : 'Work this goal first'}
      >
        {priority ? 'Priority' : ''}
      </ControlButton>
      {instructing && (
        <InstructionModal
          issueNumber={issue.number}
          issueTitle={issue.title}
          onSubmit={(text) => actions.addInstruction(issue.number, text)}
          onClose={() => setInstructing(false)}
        />
      )}
    </>
  );
}

function PrTalk({ pr, open, view, actions }: Props & { pr: OpenPullRequest; open: boolean }): JSX.Element | null {
  const item: ListenItem = { kind: 'pr', number: pr.number };
  if (inChat(view, item))
    return (
      <span className="cn-wk-chat" title="In your Claude chat">
        <Icon name="chat" />
      </span>
    );
  if (!open || pr.attention.status !== 'you') return null;
  return <ClaudeButton item={item} view={view} actions={actions} compact />;
}

function Facts({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="cn-wk-facts">
      <span className="cn-wk-label">{label}</span>
      <span className="cn-wk-items">{children}</span>
    </div>
  );
}

function PrsLine({ prs, talk }: { prs: readonly OpenPullRequest[]; talk: Talk }): JSX.Element | null {
  if (prs.length === 0) return null;
  return (
    <Facts label="PRs">
      {prs.map((pr) => {
        const reading = prReading(pr);
        return (
          <span key={pr.number} className={`cn-wk-item cn-wk-${reading.tone}`}>
            <Ref to={`pr:${pr.number}`} /> {reading.text}
            {talk(pr)}
          </span>
        );
      })}
    </Facts>
  );
}

function PartsLine({ work, talk }: { work: GoalWork; talk: Talk }): JSX.Element | null {
  if (work.page === null) return null;
  return (
    <Facts label="Parts">
      {workParts(work.page, work.prs).map(({ part, pr, mark, tone }, i) => (
        <span key={part.id} className={`cn-wk-item cn-wk-part cn-wk-${tone}`}>
          {i > 0 && <i className="cn-wk-arrow">→</i>}
          {mark !== '' && <b>{mark}</b>}
          {part.seq} {part.slug}
          {part.prNumber !== null && <Ref to={`pr:${part.prNumber}`} />}
          {pr !== undefined && <span>{prReading(pr).text}</span>}
          {pr !== undefined && talk(pr)}
          {part.status === 'blocked' && part.blockedReason !== null && <span>: {part.blockedReason}</span>}
        </span>
      ))}
    </Facts>
  );
}

function HeldLine({ holds }: { holds: readonly Hold[] }): JSX.Element | null {
  if (holds.length === 0) return null;
  return (
    <Facts label="Held">
      {holds.map((h) => (
        <span key={h.text} className={`cn-wk-item cn-wk-${h.tone}`}>
          {h.text}
        </span>
      ))}
    </Facts>
  );
}

function LaterLine({ work }: { work: GoalWork }): JSX.Element | null {
  const stages = work.page === null ? [] : laterStages(work.page);
  if (stages.length === 0) return null;
  return (
    <Facts label="Later">
      {stages.map(({ name, stage }) => (
        <span key={name} className="cn-wk-item">
          {name}: {stage.reading}
        </span>
      ))}
    </Facts>
  );
}

function NeedsYou({ asks, view, actions }: Props & { asks: readonly NeedRow[] }): JSX.Element {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const flip = (id: string): void => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
  };
  return (
    <div className="cn-wk-needs">
      {asks.map((row) => {
        const item: ListenItem = { kind: 'ask', id: row.id };
        return (
          <div key={row.id}>
            <AskCard
              row={row}
              view={view}
              claude={<ClaudeButton item={item} view={view} actions={actions} />}
              expanded={!folded.has(row.id)}
              onExpand={() => flip(row.id)}
              actions={actions}
              inGoal
            />
            <SentLine item={item} view={view} />
          </div>
        );
      })}
    </div>
  );
}
