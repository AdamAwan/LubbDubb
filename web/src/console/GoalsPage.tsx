import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, OpenPullRequest } from '../types.js';
import type { NeedRow } from '../view/needsYou.js';
import { buildGoalPage } from '../view/goalPage.js';
import { buildGoalTrack } from '../view/goalStages.js';
import { goalIssue, goalNumber, goalOfOrigin, goalOfPr, standsFor } from '../view/goalRefs.js';
import { plural } from '../view/plural.js';
import { BareButton } from '../components/button.js';
import { ControlButton } from '../components/controls.js';
import { Ref, refLabel } from '../components/refs.js';
import { Tag } from '../components/tag.js';
import { Track } from '../components/track.js';
import { elapsed } from '../components/util.js';
import { AskCard } from './askCard.js';
import { agentLamp } from './fleetRows.js';
import { PrCards } from './PrCards.js';

const NONE = 'none';

interface GoalWork {
  ref: string;
  asks: NeedRow[];
  prs: OpenPullRequest[];
  agents: Agent[];
}

function bucket(map: Map<string, GoalWork>, ref: string | null): GoalWork {
  const key = ref ?? NONE;
  let work = map.get(key);
  if (work === undefined) {
    work = { ref: key, asks: [], prs: [], agents: [] };
    map.set(key, work);
  }
  return work;
}

function goalsOfWork(view: CockpitView): GoalWork[] {
  const { state } = view;
  const map = new Map<string, GoalWork>();
  for (const row of view.needsYou) bucket(map, row.goalRef).asks.push(row);
  for (const pr of state.world.pullRequests) bucket(map, goalOfPr(state, pr.number)).prs.push(pr);
  for (const agent of view.live) {
    const origin = standsFor(state, view.taskFor(agent)?.originRef ?? null);
    bucket(map, goalOfOrigin(state, origin)).agents.push(agent);
  }
  const prioritised = (w: GoalWork): boolean => goalIssue(state, w.ref)?.priority != null;
  const urgent = (w: GoalWork): number => w.asks.filter((a) => a.urgency === 'now').length;
  return [...map.values()].sort(
    (a, b) =>
      Number(a.ref === NONE) - Number(b.ref === NONE) ||
      Number(prioritised(b)) - Number(prioritised(a)) ||
      urgent(b) - urgent(a) ||
      b.asks.length + b.prs.length - (a.asks.length + a.prs.length) ||
      (goalNumber(a.ref) ?? 0) - (goalNumber(b.ref) ?? 0),
  );
}

export function GoalsPage({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const goals = goalsOfWork(view);
  return (
    <div className="cn-gp">
      <header className="cn-ny-head">
        <h2>By goal</h2>
        <span className="cn-ny-counts">
          {plural(goals.filter((g) => g.ref !== NONE).length, 'goal')} with something open · pick one and push it
          through
        </span>
      </header>
      <div className="cn-gp-list">
        {goals.map((work) => (
          <GoalBlock key={work.ref} work={work} view={view} actions={actions} />
        ))}
      </div>
    </div>
  );
}

function GoalBlock({
  work,
  view,
  actions,
}: {
  work: GoalWork;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  const issue = work.ref === NONE ? undefined : goalIssue(view.state, work.ref);
  const page = work.ref === NONE ? null : buildGoalPage(view.state, work.ref, view.needsYou, null);
  const track = page === null ? null : buildGoalTrack(page.parts);
  const urgent = work.asks.filter((a) => a.urgency === 'now').length;
  const priority = issue?.priority != null;
  return (
    <section className={priority ? 'cn-card cn-gp-goal cn-gp-priority' : 'cn-card cn-gp-goal'}>
      <div className="cn-gp-head">
        {work.ref === NONE ? (
          <h3>No goal</h3>
        ) : (
          <>
            <BareButton
              usage={{ counted: 'goal.view' }}
              className="cn-gp-title"
              onClick={() => actions.selectGoal(work.ref)}
              title="Open the goal"
            >
              {issue?.title ?? refLabel(work.ref)}
            </BareButton>
            <span className="cn-refs">
              <Ref to={work.ref} />
            </span>
          </>
        )}
        <span className="cn-gp-counts">
          {urgent > 0 && <Tag tone="red">{plural(urgent, 'blocking ask')}</Tag>}
          <span>{plural(work.asks.length, 'ask')}</span>
          <span>{plural(work.prs.length, 'PR')}</span>
          <span>{plural(work.agents.length, 'agent')}</span>
          {track !== null && track.total > 0 && (
            <span className="cn-gp-track">
              <Track track={track} />
              {track.merged} of {track.total} merged
            </span>
          )}
        </span>
        {issue !== undefined && (
          <ControlButton
            icon="bolt"
            tone={priority ? 'on' : undefined}
            usage={priority ? 'priority.undo' : 'priority.create'}
            onClick={() => void actions.setGoalPriority(issue.number, !priority)}
            title={
              priority
                ? 'This goal takes the next free slots — click to hand the queue back to its natural order'
                : 'Work this goal first: its plan, parts and pull requests take the next free slots'
            }
          >
            {priority ? 'Priority' : 'Prioritise'}
          </ControlButton>
        )}
      </div>
      <div className="cn-gp-cols">
        <div className="cn-gp-col">
          <h4>Asks</h4>
          {work.asks.length === 0 ? (
            <p className="cn-empty">Nothing waiting on you.</p>
          ) : (
            work.asks.map((row) => (
              <AskCard
                key={row.id}
                row={row}
                view={view}
                claude={null}
                expanded={expanded === row.id}
                onExpand={() => setExpanded(expanded === row.id ? null : row.id)}
                actions={actions}
                inGoal
              />
            ))
          )}
          {work.agents.length > 0 && (
            <>
              <h4>On the fleet</h4>
              <div className="cn-gp-agents">
                {work.agents.map((agent) => (
                  <BareButton
                    key={agent.id}
                    usage={{ counted: 'agent.view' }}
                    className="cn-gp-agent"
                    onClick={() => actions.select(agent.id)}
                    title="Open the agent"
                  >
                    <i className={`cn-lamp ${agentLamp(agent, view)}`} />
                    <span>{view.taskFor(agent)?.title ?? agent.id}</span>
                    <em>{elapsed(agent.startedAt, null, view.now)}</em>
                  </BareButton>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="cn-gp-col">
          <h4>Pull requests</h4>
          {work.prs.length === 0 ? (
            <p className="cn-empty">No open pull requests.</p>
          ) : (
            <PrCards cards={work.prs.map((pr) => ({ pr, goal: false }))} view={view} actions={actions} />
          )}
        </div>
      </div>
    </section>
  );
}
