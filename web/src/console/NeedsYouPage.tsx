import { useMemo, useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, ListenItem, ListenerView } from '../types.js';
import type { NeedRow } from '../view/needsYou.js';
import { sameItem } from '../view/needsYouPage.js';
import { assignedToYou, prsOnYou, type PrOnYou } from '../view/prsOnYou.js';
import { askFamilies, FAMILY_LABEL, type AskFamily, type AskFamilyGroup } from '../view/askFamilies.js';
import { plural } from '../view/plural.js';
import { askOnlyPrompt, listenPrompt, prPrompt } from '../cockpit/desktopLink.js';
import { tabUsage } from '../cockpit/usage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { BareButton, Button, type Destination } from '../components/button.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { Icon } from '../components/icons.js';
import { Ref } from '../components/refs.js';
import { Tag } from '../components/tag.js';
import { FoldToggle } from '../components/collapsible.js';
import { elapsed, relTime } from '../components/util.js';
import { goalPrCards, PrCards } from './PrCards.js';
import { KIND_LABEL, KIND_TONE } from '../view/askKinds.js';
import { goalIssue } from '../view/goalRefs.js';
import { agentLamp } from './fleetRows.js';
import { openRow } from './queueRailOpens.js';
import { configDestination, HandledLine, KIND_VERB, rowClass, subjectRef } from './QueueRail.js';

// → docs/spec/44-needs-you.md

/** Off to the overview, out of any goal opened over it. */
function openOverview(actions: CockpitActions): void {
  actions.selectGoal(null);
  actions.openTab('overview');
}

export function NeedsYouPage({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const listener = view.state.listener;
  const folder = view.state.config.desktopFolder;
  const pullRequests = view.state.world.pullRequests;
  const prs = useMemo(() => prsOnYou(pullRequests), [pullRequests]);
  return (
    <div className="cn-ny">
      <header className="cn-ny-head">
        <h2>Needs you</h2>
        <span className="cn-ny-counts">
          {plural(view.needsYou.length, 'ask')} · {plural(prs.length, 'pull request')}
        </span>
        <ListenerStatus asks={view.needsYou} listener={listener} folder={folder} />
      </header>
      <div className="cn-ny-cols">
        <AsksColumn view={view} actions={actions} />
        <PrsColumn view={view} actions={actions} prs={prs} />
        <FleetPanel view={view} actions={actions} />
      </div>
    </div>
  );
}

const agentName = (agent: Agent, view: CockpitView): string => view.taskFor(agent)?.title ?? agent.id;

function agentState(agent: Agent, view: CockpitView): { word: string; tone: 'red' | 'amber' } | null {
  if (view.escalationByAgent.has(agent.id)) return { word: 'question', tone: 'red' };
  if (view.limitParked.has(agent.id)) return { word: 'limit', tone: 'amber' };
  if (agent.status === 'waiting') return { word: 'waiting', tone: 'amber' };
  return null;
}

// → docs/spec/44-needs-you.md#the-fleet-panel
function FleetPanel({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const rank = (agent: Agent): number =>
    view.escalationByAgent.has(agent.id) ? 0 : view.limitParked.has(agent.id) || agent.status === 'waiting' ? 1 : 2;
  const sorted = [...view.live].sort((a, b) => rank(a) - rank(b));
  const cap = view.state.control.cap;
  const fill = cap > 0 ? Math.min(100, Math.round((view.live.length / cap) * 100)) : 0;
  return (
    <aside className="cn-card cn-ny-col cn-ny-fleet">
      <div className="cn-ny-fleet-sum">
        <span>
          <b>{view.live.length}</b> of {cap} out
        </span>
        <span>{view.upNext.length} queued</span>
      </div>
      <div className="cn-ny-fleet-cap" aria-hidden="true">
        <i style={{ width: `${String(fill)}%` }} />
      </div>
      <div className="cn-ny-scroll">
        {sorted.length === 0 ? (
          <p className="cn-empty">No agents out.</p>
        ) : (
          sorted.map((agent) => {
            const title = agentName(agent, view);
            const state = agentState(agent, view);
            const note = agent.note ?? (state === null ? 'running' : null);
            return (
              <BareButton
                key={agent.id}
                usage={{ counted: 'agent.view' }}
                className={state?.tone === 'red' ? 'cn-ny-agent cn-ny-agent-ask' : 'cn-ny-agent'}
                onClick={() => actions.select(agent.id)}
                title={`${title} — open the agent`}
              >
                <i className={`cn-lamp ${agentLamp(agent, view)}`} />
                <span className="cn-ny-agent-name">{title}</span>
                <em>{elapsed(agent.startedAt, null, view.now)}</em>
                <span className="cn-ny-agent-doing">
                  {state !== null && <Tag tone={state.tone}>{state.word}</Tag>}
                  {note !== null && <span>{note}</span>}
                </span>
              </BareButton>
            );
          })
        )}
      </div>
      <div className="cn-ny-fleet-foot">
        <BareButton
          usage={tabUsage('overview')}
          className="cn-ny-fleet-open"
          onClick={() => openOverview(actions)}
          title="Open the overview — the fleet, its queue and the cap"
        >
          Overview ›
        </BareButton>
      </div>
    </aside>
  );
}

function SentLine({ item, view }: { item: ListenItem; view: CockpitView }): JSX.Element | null {
  const at = view.state.listener.sent.find((entry) => sameItem(entry.item, item))?.sentAt;
  return at === undefined ? null : <SentStrip at={at} now={view.now} />;
}

function AsksColumn({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const asks = view.needsYou;
  const groups = askFamilies(asks);
  const [pressed, setPressed] = useState<ReadonlyMap<AskFamily, boolean>>(() => new Map());
  const isOpen = (group: AskFamilyGroup): boolean =>
    pressed.get(group.family) ?? group.rows.some((row) => row.urgency !== 'later');
  const setOpen = (family: AskFamily, open: boolean): void => setPressed((was) => new Map(was).set(family, open));
  const jump = (family: AskFamily): void => {
    setOpen(family, true);
    document.getElementById(`cn-ny-family-${family}`)?.scrollIntoView({ block: 'start' });
  };
  return (
    <section className="cn-card cn-ny-col">
      <h3>
        From the orchestrator <i className="cn-n">{asks.length}</i>
      </h3>
      {groups.length > 1 && <FamilyChips groups={groups} onJump={jump} />}
      <div className="cn-ny-scroll">
        {asks.length === 0 ? (
          <p className="cn-empty">Nothing is waiting on you.</p>
        ) : (
          groups.map((group) => (
            <AskFamilyFold
              key={group.family}
              group={group}
              open={isOpen(group)}
              onToggle={(open) => setOpen(group.family, open)}
              view={view}
              actions={actions}
            />
          ))
        )}
        <HandledLine view={view} actions={actions} />
      </div>
    </section>
  );
}

// → docs/spec/44-needs-you.md#from-the-orchestrator
function FamilyChips({
  groups,
  onJump,
}: {
  groups: readonly AskFamilyGroup[];
  onJump: (family: AskFamily) => void;
}): JSX.Element {
  return (
    <nav className="cn-ny-chiprow" aria-label="Ask groups">
      {groups.map((group) => (
        <BareButton
          key={group.family}
          usage="escalation.expand"
          className="cn-ny-chip"
          onClick={() => onJump(group.family)}
          title={`Go to ${FAMILY_LABEL[group.family]}${group.now > 0 ? ` — ${String(group.now)} to answer now` : ''}`}
        >
          <span>{FAMILY_LABEL[group.family]}</span>
          <b>{group.rows.length}</b>
          {group.now > 0 && <i className="cn-ny-nowdot" aria-label={`${String(group.now)} to answer now`} />}
        </BareButton>
      ))}
    </nav>
  );
}

function AskFamilyFold({
  group,
  open,
  onToggle,
  view,
  actions,
}: {
  group: AskFamilyGroup;
  open: boolean;
  onToggle: (open: boolean) => void;
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="cn-ny-family" id={`cn-ny-family-${group.family}`}>
      <div className="cn-ny-family-head">
        <FoldToggle
          subject="escalation"
          open={open}
          onToggle={onToggle}
          hint={false}
          label={
            <>
              {FAMILY_LABEL[group.family]} <i className="cn-n">{group.rows.length}</i>
            </>
          }
        />
        {group.now > 0 && <span className="cn-ny-family-now">{group.now} now</span>}
      </div>
      {open && (
        <div className="cn-ny-list">
          {group.rows.map((row) => {
            const item: ListenItem = { kind: 'ask', id: row.id };
            return (
              <div key={row.id} className="cn-ny-item">
                <AskCard
                  row={row}
                  view={view}
                  open={askOpen(row, actions)}
                  claude={<ClaudeButton item={item} view={view} actions={actions} />}
                />
                <SentLine item={item} view={view} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// → docs/spec/44-needs-you.md#pull-requests-waiting-on-you
function PrsColumn({
  view,
  actions,
  prs,
}: {
  view: CockpitView;
  actions: CockpitActions;
  prs: readonly PrOnYou[];
}): JSX.Element {
  const open = view.state.world.pullRequests.length;
  const assigned: PrOnYou[] = [];
  const own: PrOnYou[] = [];
  for (const row of prs) (assignedToYou(row.pr) ? assigned : own).push(row);
  return (
    <div className="cn-ny-prcol">
      <PrBox
        title="Assigned to you"
        empty="Nobody has asked you to review anything."
        prs={assigned}
        view={view}
        actions={actions}
      />
      <PrBox
        title="Your pull requests"
        empty="None of yours or the fleet’s is waiting on you."
        prs={own}
        view={view}
        actions={actions}
        tail={
          open > 0 && (
            <BareButton usage={tabUsage('overview')} className="cn-ny-all" onClick={() => openOverview(actions)}>
              All {open} open →
            </BareButton>
          )
        }
      />
    </div>
  );
}

function PrBox({
  title,
  empty,
  prs,
  view,
  actions,
  tail,
}: {
  title: string;
  empty: string;
  prs: readonly PrOnYou[];
  view: CockpitView;
  actions: CockpitActions;
  tail?: ReactNode;
}): JSX.Element {
  const cards = goalPrCards(
    prs.map(({ pr }) => pr),
    view,
  ).map((card) => {
    const item: ListenItem = { kind: 'pr', number: card.pr.number };
    return {
      ...card,
      action: <ClaudeButton item={item} view={view} actions={actions} compact />,
      below: <SentLine item={item} view={view} />,
    };
  });
  return (
    <section
      className={prs.length === 0 ? 'cn-card cn-ny-col cn-ny-prbox cn-ny-prbox-empty' : 'cn-card cn-ny-col cn-ny-prbox'}
    >
      <h3>
        {title} <i className="cn-n">{prs.length}</i>
        {tail}
      </h3>
      <div className="cn-ny-scroll">
        {prs.length === 0 ? (
          <p className="cn-empty">{empty}</p>
        ) : (
          <PrCards cards={cards} view={view} actions={actions} ghosts />
        )}
      </div>
    </section>
  );
}

function askOpen(row: NeedRow, actions: CockpitActions): Destination | null {
  if (row.check !== undefined) return configDestination(row.check, actions);
  return row.opens === null ? null : openRow(row, actions);
}

/** The ask card's three parts: what it is about, the ask, and a note only where it adds something. */
function askWords(row: NeedRow, view: CockpitView): { about: string | null; ask: string; why?: string } {
  const goal = row.goalRef === null ? undefined : goalIssue(view.state, row.goalRef);
  const about = goal?.title ?? row.agentLabel;
  const ask = row.summary ?? row.title;
  const note = row.note ?? row.check?.remedy;
  return note === undefined || (about !== null && note.includes(about)) ? { about, ask } : { about, ask, why: note };
}

// → docs/spec/44-needs-you.md#the-ask-card
function AskCard({
  row,
  view,
  open,
  claude,
}: {
  row: NeedRow;
  view: CockpitView;
  open: Destination | null;
  claude: ReactNode;
}): JSX.Element {
  const ref = askRef(row);
  const { about, ask, why } = askWords(row, view);
  return (
    <div className={rowClass(row, null, false, 'cn-ny-ask cn-plainrefs')}>
      <i className="cn-stripe" />
      <div className="cn-qin">
        <AskTop row={row} now={view.now} />
        <p className="cn-ny-about">
          <span>{about ?? ask}</span>
          {ref !== null && (
            <span className="cn-refs">
              <Ref to={ref} />
            </span>
          )}
        </p>
        {about !== null && <p className="cn-ny-body">{ask}</p>}
        {why !== undefined && <p className="cn-ny-why">{why}</p>}
        <span className="cn-ny-acts">
          {claude}
          {open !== null && (
            <Button size="small" usage={open.usage} onClick={open.go}>
              {row.verb ?? KIND_VERB[row.kind]}
            </Button>
          )}
        </span>
      </div>
    </div>
  );
}

function AskTop({ row, now }: { row: NeedRow; now: number }): JSX.Element {
  return (
    <div className="cn-ny-asktop">
      <span className={`cn-ny-kind cn-ink-${KIND_TONE[row.kind]}`}>{KIND_LABEL[row.kind]}</span>
      {row.raisedAt !== '' && <i className="cn-qage">{relTime(row.raisedAt, now)}</i>}
      {row.urgency === 'now' && (
        <i className="cn-ny-nowdot" title="Answer now — the fleet is stopped on this" aria-label="Answer now" />
      )}
    </div>
  );
}

function ClaudeButton({
  item,
  view,
  actions,
  compact = false,
}: {
  item: ListenItem;
  view: CockpitView;
  actions: CockpitActions;
  compact?: boolean;
}): JSX.Element | null {
  const { listener, config } = view.state;
  const folder = config.desktopFolder;
  if (listener.state === 'off') {
    if (!folder) return null;
    return (
      <DesktopLink
        usage="listen.open"
        control={false}
        className="cn-ny-claude"
        folder={folder}
        prompt={item.kind === 'ask' ? askOnlyPrompt(item.id) : prPrompt(item.number)}
        label="Open in Claude"
        ready="in a new chat"
        explain="to talk this one through."
      />
    );
  }
  return (
    <AsyncButton
      size="small"
      className="cn-ny-claude"
      usage="listen.send"
      title={
        listener.state === 'busy'
          ? 'Talk it through — hand this to your listening Claude chat; it queues behind the one the chat is on'
          : 'Talk it through — hand this to your listening Claude chat'
      }
      aria-label={compact ? 'Talk it through' : undefined}
      onClick={() => actions.listenSend(item)}
    >
      <Icon name="chat" />
      {compact ? null : 'Talk it through'}
    </AsyncButton>
  );
}

function SentStrip({ at, now }: { at: string; now: number }): JSX.Element {
  return (
    <div className="cn-ny-sent">
      <Icon name="chat" />
      In your Claude chat · sent {relTime(at, now)}
    </div>
  );
}

function askRef(row: NeedRow): string | null {
  return subjectRef(row) ?? (row.prNumber === undefined || row.prNumber === null ? null : `pr:${row.prNumber}`);
}

function OnItem({ item, asks }: { item: ListenItem | null; asks: readonly NeedRow[] }): ReactNode {
  if (item === null) return 'an item';
  if (item.kind === 'pr') return <Ref to={`pr:${item.number}`} />;
  const row = asks.find((r) => r.id === item.id);
  const ref = row === undefined ? null : askRef(row);
  return ref === null ? 'an ask' : <Ref to={ref} />;
}

function ListenerStatus({
  asks,
  listener,
  folder,
}: {
  asks: readonly NeedRow[];
  listener: ListenerView;
  folder: string;
}): JSX.Element {
  if (listener.state !== 'off') {
    return (
      <span className="cn-ny-status">
        <span className="cn-ny-listen cn-ny-on">
          {listener.state === 'listening' ? (
            'Claude is listening'
          ) : (
            <>
              Claude is on <OnItem item={listener.on} asks={asks} />
              {listener.queued > 0 && <> · {listener.queued} queued</>}
            </>
          )}
        </span>
      </span>
    );
  }
  return (
    <span className="cn-ny-status">
      <span className="cn-ny-listen cn-ny-off">No Claude chat listening</span>
      {folder && (
        <DesktopLink
          usage="listen.open"
          control={false}
          className="cn-ny-claude"
          folder={folder}
          prompt={listenPrompt()}
          label="Start listen loop"
          ready="in a new chat"
          explain="so the asks and pull requests you send from this page land in it."
        />
      )}
      <Button
        size="small"
        ghost
        usage="listen.copy"
        title={`Copy "${listenPrompt()}" to paste into a Claude chat already open`}
        onClick={() => void navigator.clipboard?.writeText(listenPrompt()).catch(() => undefined)}
      >
        Copy
      </Button>
    </span>
  );
}
