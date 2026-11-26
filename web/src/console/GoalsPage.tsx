import { useState, type JSX } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, Issue, OpenPullRequest } from '../types.js';
import type { NeedRow } from '../view/needsYou.js';
import { buildGoalPage } from '../view/goalPage.js';
import { buildGoalTrack } from '../view/goalStages.js';
import { goalIssue, goalNumber, goalOfOrigin, goalOfPr, standsFor } from '../view/goalRefs.js';
import { plural } from '../view/plural.js';
import { BareButton } from '../components/button.js';
import { ControlButton } from '../components/controls.js';
import { Ref, refLabel } from '../components/refs.js';
import { Track } from '../components/track.js';
import { elapsed } from '../components/util.js';
import { AskCard } from './askCard.js';
import { agentLamp } from './fleetRows.js';
import { PrCards } from './PrCards.js';
import { PICKUP_WORD } from './Overview.js';

const NONE = 'none';
const CURRENT = new Set(['active', 'has_pr', 'planning', 'investigation', 'parked', 'escalated']);

interface Hold {
  text: string;
  tone: 'ask' | 'hold';
}

interface GoalWork {
  ref: string;
  issue: Issue | undefined;
  asks: NeedRow[];
  prs: OpenPullRequest[];
  agents: Agent[];
}

interface FeatureGroup {
  key: string;
  title: string | null;
  number: number | null;
  goals: GoalWork[];
}

function bucket(map: Map<string, GoalWork>, view: CockpitView, ref: string | null): GoalWork {
  const key = ref ?? NONE;
  let work = map.get(key);
  if (work === undefined) {
    work = { ref: key, issue: ref === null ? undefined : goalIssue(view.state, ref), asks: [], prs: [], agents: [] };
    map.set(key, work);
  }
  return work;
}

function currentWork(view: CockpitView): GoalWork[] {
  const { state } = view;
  const map = new Map<string, GoalWork>();
  for (const issue of state.world.issues)
    if (CURRENT.has(issue.pickup.status)) bucket(map, view, `issue:${issue.number}`);
  for (const row of view.needsYou) if (row.goalRef !== null) bucket(map, view, row.goalRef).asks.push(row);
  for (const pr of state.world.pullRequests) bucket(map, view, goalOfPr(state, pr.number)).prs.push(pr);
  for (const agent of view.live) {
    const goal = goalOfOrigin(state, standsFor(state, view.taskFor(agent)?.originRef ?? null));
    if (goal !== null) bucket(map, view, goal).agents.push(agent);
  }
  const rank = (w: GoalWork): number =>
    w.issue?.priority != null ? 0 : w.asks.some((a) => a.urgency === 'now') ? 1 : w.asks.length > 0 ? 2 : 3;
  return [...map.values()].sort(
    (a, b) =>
      Number(a.ref === NONE) - Number(b.ref === NONE) ||
      rank(a) - rank(b) ||
      (goalNumber(a.ref) ?? 0) - (goalNumber(b.ref) ?? 0),
  );
}

function byFeature(goals: readonly GoalWork[]): FeatureGroup[] {
  const groups = new Map<string, FeatureGroup>();
  for (const work of goals) {
    const parent = work.issue?.parent ?? null;
    const key = parent === null ? NONE : String(parent.number);
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, title: parent?.title ?? null, number: parent?.number ?? null, goals: [] };
      groups.set(key, group);
    }
    group.goals.push(work);
  }
  return [...groups.values()].sort((a, b) => Number(a.key === NONE) - Number(b.key === NONE));
}

function holdsOf(work: GoalWork, view: CockpitView): Hold[] {
  const { state } = view;
  const holds: Hold[] = work.asks.map((a) => ({ text: a.summary ?? a.title, tone: 'ask' }));
  const prNumbers = new Set(work.prs.map((pr) => pr.number));
  for (const stack of state.stacks) {
    if (!stack.rungs.some((r) => prNumbers.has(r.prNumber))) continue;
    const blocked = state.stackLandings.find((l) => l.ref === stack.ref)?.blockedBy;
    if (blocked != null) holds.push({ text: `stack can’t land: ${blocked}`, tone: 'hold' });
  }
  if (work.ref !== NONE) {
    const page = buildGoalPage(state, work.ref, view.needsYou, null);
    for (const { part } of page?.parts ?? []) {
      if (part.status === 'blocked')
        holds.push({ text: `part “${part.slug}”: ${part.blockedReason ?? 'blocked'}`, tone: 'hold' });
    }
    for (const item of view.upNext) {
      if (item.status === 'dispatching') continue;
      if (goalOfOrigin(state, standsFor(state, item.origin)) !== work.ref) continue;
      const held = item.reason.indexOf('Held: ');
      holds.push({ text: held === -1 ? item.reason : item.reason.slice(held + 6), tone: 'hold' });
    }
  }
  const seen = new Set<string>();
  return holds.filter((h) => !seen.has(h.text) && Boolean(seen.add(h.text)));
}

function prState(pr: OpenPullRequest): { text: string; tone: 'ask' | 'hold' | 'quiet' } {
  if (pr.attention.status === 'you') return { text: 'your call', tone: 'ask' };
  if (pr.ciStatus === 'failing') return { text: 'CI failing', tone: 'hold' };
  return { text: pr.attention.reasons[0] ?? pr.attention.status, tone: 'quiet' };
}

export function GoalsPage({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const goals = currentWork(view);
  const features = byFeature(goals);
  const headed = features.some((f) => f.key !== NONE);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const toggle = (key: string): void => {
    const next = new Set(folded);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setFolded(next);
  };
  return (
    <div className="cn-gp cn-plainrefs">
      <header className="cn-ny-head">
        <h2>Work</h2>
        <span className="cn-ny-counts">
          {plural(goals.filter((g) => g.ref !== NONE).length, 'goal')} in flight · ⚡ pins one to the top of the queue
        </span>
      </header>
      {features.map((feature) => (
        <section key={feature.key} className="cn-gp-feature">
          {headed && (
            <BareButton
              usage={{ counted: 'feature.view' }}
              className="cn-gp-fhead"
              onClick={() => toggle(feature.key)}
              aria-expanded={!folded.has(feature.key)}
            >
              <span>{folded.has(feature.key) ? '▸' : '▾'}</span>
              <b>{feature.title ?? 'No feature'}</b>
              <em>{plural(feature.goals.length, 'goal')}</em>
            </BareButton>
          )}
          {!folded.has(feature.key) &&
            feature.goals.map((work) => (
              <GoalRow
                key={work.ref}
                work={work}
                view={view}
                actions={actions}
                open={open === work.ref}
                onToggle={() => setOpen(open === work.ref ? null : work.ref)}
              />
            ))}
        </section>
      ))}
    </div>
  );
}

function GoalRow({
  work,
  view,
  actions,
  open,
  onToggle,
}: {
  work: GoalWork;
  view: CockpitView;
  actions: CockpitActions;
  open: boolean;
  onToggle: () => void;
}): JSX.Element {
  const { issue } = work;
  const page = work.ref === NONE ? null : buildGoalPage(view.state, work.ref, view.needsYou, null);
  const track = page === null ? null : buildGoalTrack(page.parts);
  const priority = issue?.priority != null;
  const holds = holdsOf(work, view);
  const stage = issue === undefined ? null : (PICKUP_WORD[issue.pickup.status] ?? issue.pickup.status);
  return (
    <div className={`cn-gp-row${priority ? ' cn-gp-priority' : ''}${open ? ' cn-gp-open' : ''}`}>
      <div className="cn-gp-line">
        <BareButton
          usage={open ? 'goal.close' : 'goal.expand'}
          className="cn-gp-fold"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? 'Fold' : 'Show its asks and pull requests here'}
        >
          {open ? '▾' : '▸'}
        </BareButton>
        {work.ref === NONE ? (
          <b className="cn-gp-title">No goal</b>
        ) : (
          <>
            <BareButton
              usage={{ counted: 'goal.view' }}
              className="cn-gp-title"
              onClick={() => actions.selectGoal(work.ref)}
              title="Open the goal page"
            >
              {issue?.title ?? refLabel(work.ref)}
            </BareButton>
            <span className="cn-refs">
              <Ref to={work.ref} />
            </span>
          </>
        )}
        {stage !== null && <span className="cn-gp-stage">{stage}</span>}
        {track !== null && track.total > 0 && (
          <span className="cn-gp-track">
            <Track track={track} />
            {track.merged}/{track.total}
          </span>
        )}
        {work.agents.length > 0 && (
          <span className="cn-gp-onit" title={work.agents.map((a) => view.taskFor(a)?.title ?? a.id).join('\n')}>
            <i className={`cn-lamp ${agentLamp(work.agents[0]!, view)}`} />
            {work.agents.length}
          </span>
        )}
        {issue !== undefined && (
          <ControlButton
            icon="bolt"
            tone={priority ? 'on' : undefined}
            usage={priority ? 'priority.undo' : 'priority.create'}
            onClick={() => void actions.setGoalPriority(issue.number, !priority)}
            title={priority ? 'Prioritised — click to hand the queue back' : 'Work this goal first'}
          >
            {priority ? 'Priority' : ''}
          </ControlButton>
        )}
      </div>
      {work.prs.length > 0 && (
        <div className="cn-gp-facts">
          <span className="cn-gp-label">PRs</span>
          <span className="cn-gp-items">
            {work.prs.map((pr) => {
              const s = prState(pr);
              return (
                <span key={pr.number} className={`cn-gp-item cn-gp-${s.tone}`}>
                  <Ref to={`pr:${pr.number}`} /> {s.text}
                </span>
              );
            })}
          </span>
        </div>
      )}
      {holds.length > 0 && (
        <div className="cn-gp-facts">
          <span className="cn-gp-label">Held</span>
          <span className="cn-gp-items">
            {holds.map((h, i) => (
              <span key={i} className={`cn-gp-item cn-gp-${h.tone}`}>
                {h.text}
              </span>
            ))}
          </span>
        </div>
      )}
      {open && <GoalDetail work={work} view={view} actions={actions} />}
    </div>
  );
}

function GoalDetail({
  work,
  view,
  actions,
}: {
  work: GoalWork;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
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
  );
}
