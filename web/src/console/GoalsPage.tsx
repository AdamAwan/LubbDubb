import { useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, Issue, OpenPullRequest, PlanPart } from '../types.js';
import type { NeedRow } from '../view/needsYou.js';
import { buildGoalPage, type GoalPageView } from '../view/goalPage.js';
import { buildGoalTrack, closeStage, validationStage, watchStage } from '../view/goalStages.js';
import { goalIssue, goalNumber, goalOfOrigin, goalOfPr, standsFor } from '../view/goalRefs.js';
import { plural } from '../view/plural.js';
import { BareButton } from '../components/button.js';
import { ControlButton } from '../components/controls.js';
import { Ref, refLabel } from '../components/refs.js';
import { Track } from '../components/track.js';
import { fmtUsd } from '../components/util.js';
import { InstructionModal } from '../components/InstructionModal.js';
import { AskCard } from './askCard.js';
import { agentLamp } from './fleetRows.js';
import { PrCards } from './PrCards.js';
import { PICKUP_WORD } from './Overview.js';

const NONE = 'none';
const LATER = 'later';

function inFlight(w: GoalWork): boolean {
  if (w.ref === NONE || w.prs.length > 0 || w.agents.length > 0) return true;
  return w.issue !== undefined && CURRENT.has(w.issue.pickup.status);
}
const CURRENT = new Set(['active', 'has_pr', 'planning', 'investigation', 'parked', 'escalated']);

interface Hold {
  text: string;
  tone: 'ask' | 'hold';
  part?: true;
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
        holds.push({ text: `part “${part.slug}”: ${part.blockedReason ?? 'blocked'}`, tone: 'hold', part: true });
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
  const all = currentWork(view);
  const goals = all.filter((w) => inFlight(w));
  const later = all.filter((w) => !inFlight(w));
  const features = [
    ...byFeature(goals),
    ...(later.length === 0
      ? []
      : [{ key: LATER, title: 'Not in flight — appraising, queued or delivered', number: null, goals: later }]),
  ];
  const headed = features.some((f) => f.key !== NONE);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set([LATER]));
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
  const [instructing, setInstructing] = useState(false);
  const page = work.ref === NONE ? null : buildGoalPage(view.state, work.ref, view.needsYou, null);
  const track = page === null ? null : buildGoalTrack(page.parts);
  const priority = issue?.priority != null;
  const holds = holdsOf(work, view).filter((h) => !open || (h.tone === 'hold' && h.part === undefined));
  const stage = issue === undefined ? null : (PICKUP_WORD[issue.pickup.status] ?? issue.pickup.status);
  const planned = page !== null && page.parts.length > 0;
  return (
    <div className={`cn-gp-row${priority ? ' cn-gp-priority' : ''}${open ? ' cn-gp-open' : ''}`}>
      <div className="cn-gp-line">
        <BareButton
          usage={open ? 'goal.close' : 'goal.expand'}
          className="cn-gp-fold"
          onClick={onToggle}
          aria-expanded={open}
          title={open ? 'Fold' : 'Show what it needs, its parts and what comes later'}
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
              title="Open the full goal page"
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
        {issue?.spend != null && <span className="cn-gp-onit">{fmtUsd(issue.spend.costUsd)}</span>}
        {issue !== undefined && open && (
          <ControlButton
            icon="pen"
            usage="goal.expand"
            onClick={() => setInstructing(true)}
            title="Say what you want done next — your words go to the next agent on this goal"
          >
            Instruct
          </ControlButton>
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
      {open && work.asks.length > 0 && <NeedsYou asks={work.asks} view={view} actions={actions} />}
      {open && planned ? <PartsLine page={page} prs={work.prs} /> : work.prs.length > 0 && <PrsLine prs={work.prs} />}
      {open && planned && <OtherPrs page={page} prs={work.prs} />}
      {holds.length > 0 && (
        <Facts label="Held">
          {holds.map((h, i) => (
            <span key={i} className={`cn-gp-item cn-gp-${h.tone}`}>
              {h.text}
            </span>
          ))}
        </Facts>
      )}
      {open && page !== null && <LaterLine page={page} />}
      {open && !planned && work.prs.length > 0 && (
        <div className="cn-gp-inset">
          <PrCards cards={work.prs.map((pr) => ({ pr, goal: false }))} view={view} actions={actions} />
        </div>
      )}
      {instructing && issue !== undefined && (
        <InstructionModal
          issueNumber={issue.number}
          issueTitle={issue.title}
          onSubmit={(text) => actions.addInstruction(issue.number, text)}
          onClose={() => setInstructing(false)}
        />
      )}
    </div>
  );
}

function Facts({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="cn-gp-facts">
      <span className="cn-gp-label">{label}</span>
      <span className="cn-gp-items">{children}</span>
    </div>
  );
}

function PrsLine({ prs }: { prs: readonly OpenPullRequest[] }): JSX.Element {
  return (
    <Facts label="PRs">
      {prs.map((pr) => {
        const s = prState(pr);
        return (
          <span key={pr.number} className={`cn-gp-item cn-gp-${s.tone}`}>
            <Ref to={`pr:${pr.number}`} /> {s.text}
          </span>
        );
      })}
    </Facts>
  );
}

const PART_MARK: Partial<Record<PlanPart['status'], string>> = {
  merged: '✓',
  concluded: '✓',
  blocked: '⏸',
  dispatched: '▶',
  in_review: '▶',
};

function PartsLine({ page, prs }: { page: GoalPageView; prs: readonly OpenPullRequest[] }): JSX.Element {
  const parts = page.parts
    .map((p) => p.part)
    .filter((p) => p.status !== 'retired')
    .sort((a, b) => a.seq - b.seq);
  return (
    <Facts label="Parts">
      {parts.map((part, i) => {
        const pr = part.prNumber === null ? undefined : prs.find((p) => p.number === part.prNumber);
        const state = pr === undefined ? null : prState(pr);
        const mark = PART_MARK[part.status] ?? (pr !== undefined ? '▶' : '');
        const tone = part.status === 'blocked' ? 'hold' : (state?.tone ?? (mark === '✓' ? 'done' : 'quiet'));
        return (
          <span key={part.id} className={`cn-gp-item cn-gp-part cn-gp-${tone}`}>
            {i > 0 && <i className="cn-gp-arrow">→</i>}
            {mark !== '' && <b>{mark}</b>}
            {part.seq} {part.slug}
            {part.prNumber !== null && <Ref to={`pr:${part.prNumber}`} />}
            {state !== null && <span>{state.text}</span>}
            {part.status === 'blocked' && part.blockedReason !== null && <span>: {part.blockedReason}</span>}
          </span>
        );
      })}
    </Facts>
  );
}

function OtherPrs({ page, prs }: { page: GoalPageView; prs: readonly OpenPullRequest[] }): JSX.Element | null {
  const inPlan = new Set(page.parts.flatMap((p) => (p.part.prNumber === null ? [] : [p.part.prNumber])));
  const others = prs.filter((pr) => !inPlan.has(pr.number));
  return others.length === 0 ? null : <PrsLine prs={others} />;
}

function LaterLine({ page }: { page: GoalPageView }): JSX.Element | null {
  const stages = [
    ['Validate', validationStage(page)],
    ['Close', closeStage(page)],
    ['Watch', watchStage(page)],
  ] as const;
  const live = stages.filter(([, s]) => s.tone !== 'grey');
  if (live.length === 0) return null;
  return (
    <Facts label="Later">
      {live.map(([name, s]) => (
        <span key={name} className="cn-gp-item">
          {name}: {s.reading}
        </span>
      ))}
    </Facts>
  );
}

function NeedsYou({
  asks,
  view,
  actions,
}: {
  asks: readonly NeedRow[];
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const flip = (id: string): void => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
  };
  return (
    <div className="cn-gp-needs">
      {asks.map((row) => (
        <AskCard
          key={row.id}
          row={row}
          view={view}
          claude={null}
          expanded={!folded.has(row.id)}
          onExpand={() => flip(row.id)}
          actions={actions}
          inGoal
        />
      ))}
    </div>
  );
}
