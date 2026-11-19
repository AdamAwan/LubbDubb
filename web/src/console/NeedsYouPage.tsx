import { useMemo, useState, type JSX, type ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { Agent, ListenItem, ListenerView, PrOnYouReason } from '../types.js';
import type { NeedRow } from '../view/needsYou.js';
import { sameItem } from '../view/needsYouPage.js';
import { prsOnYou, PR_REASON_LABEL, type PrOnYou } from '../view/prsOnYou.js';
import { plural } from '../view/plural.js';
import { askOnlyPrompt, listenPrompt, prPrompt } from '../cockpit/desktopLink.js';
import { tabUsage } from '../cockpit/usage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { BareButton, Button, type Destination } from '../components/button.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { Icon } from '../components/icons.js';
import { HeadRow } from '../components/panel.js';
import { Ref } from '../components/refs.js';
import { Tag, type TagTone } from '../components/tag.js';
import { elapsed, relTime } from '../components/util.js';
import { PanelRows, type PanelRowModel } from './PanelRow.js';
import { prRow } from './prRow.js';
import { agentLamp } from './fleetRows.js';
import { openRow } from './queueRailOpens.js';
import {
  configDestination,
  HandledLine,
  holdingLabel,
  KIND_VERB,
  KindTag,
  RailTiers,
  rowClass,
  subjectRef,
  UNNAMED_RUN,
} from './QueueRail.js';

// → docs/spec/44-needs-you.md

const REASON_TONE: Record<PrOnYouReason, TagTone> = {
  review: 'red',
  call: 'amber',
  comments: 'blue',
  assign: 'violet',
  describe: 'grey',
};

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
      <FleetStrip view={view} actions={actions} />
      <div className="cn-ny-cols">
        <AsksColumn view={view} actions={actions} />
        <PrsColumn view={view} actions={actions} prs={prs} />
      </div>
    </div>
  );
}

const STRIP_MAX = 6;

const agentName = (agent: Agent, view: CockpitView): string => view.taskFor(agent)?.title ?? agent.id;

function agentDoing(agent: Agent, view: CockpitView): string {
  if (view.escalationByAgent.has(agent.id)) return 'has an open ask';
  if (view.limitParked.has(agent.id)) return 'out of account limit';
  return agent.status === 'waiting' ? 'waiting' : 'running';
}

// → docs/spec/44-needs-you.md#the-fleet-strip
function FleetStrip({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const [open, setOpen] = useState(false);
  const rank = (agent: Agent): number =>
    view.escalationByAgent.has(agent.id) ? 0 : view.limitParked.has(agent.id) || agent.status === 'waiting' ? 1 : 2;
  const sorted = [...view.live].sort((a, b) => rank(a) - rank(b));
  const shown = sorted.slice(0, STRIP_MAX);
  const more = sorted.length - shown.length;
  const toggle = open ? 'Fold the fleet back to one line' : 'Show every agent out, and what each is doing';
  return (
    <div className="cn-ny-fleet">
      <div className="cn-ny-fleet-line">
        <span className="cn-ny-fleet-label">Fleet</span>
        {sorted.length === 0 ? (
          <span className="cn-ny-fleet-idle">no agents out</span>
        ) : (
          !open &&
          shown.map((agent) => {
            const title = agentName(agent, view);
            const age = elapsed(agent.startedAt, null, view.now);
            return (
              <BareButton
                key={agent.id}
                usage={{ counted: 'agent.view' }}
                className="cn-ny-agent"
                onClick={() => actions.select(agent.id)}
                title={`${title} — ${agentDoing(agent, view)}, ${age} — open the agent`}
              >
                <i className={`cn-lamp ${agentLamp(agent, view)}`} />
                <span>{title}</span>
                <em>{age}</em>
              </BareButton>
            );
          })
        )}
        {sorted.length > 0 && (
          <BareButton
            usage={{ counted: 'fleet.view' }}
            className="cn-ny-fleet-more"
            aria-expanded={open}
            onClick={() => setOpen((was) => !was)}
            title={toggle}
            aria-label={toggle}
          >
            {open ? 'less ▴' : more > 0 ? `+${String(more)} ▾` : '▾'}
          </BareButton>
        )}
        <span className="cn-ny-fleet-tail">
          {view.live.length} of {view.state.control.cap} · {view.upNext.length} queued
        </span>
        <BareButton
          usage={tabUsage('overview')}
          className="cn-ny-fleet-open"
          onClick={() => openOverview(actions)}
          title="Open the overview — the fleet, its queue and the cap"
        >
          Overview ›
        </BareButton>
      </div>
      {open && <FleetList agents={sorted} view={view} actions={actions} />}
    </div>
  );
}

function FleetList({
  agents,
  view,
  actions,
}: {
  agents: readonly Agent[];
  view: CockpitView;
  actions: CockpitActions;
}): JSX.Element {
  return (
    <div className="cn-ny-fleet-list">
      {agents.map((agent) => (
        <BareButton
          key={agent.id}
          usage={{ counted: 'agent.view' }}
          className="cn-ny-fleet-row"
          onClick={() => actions.select(agent.id)}
          title="Open the agent"
        >
          <i className={`cn-lamp ${agentLamp(agent, view)}`} />
          <span>{agentName(agent, view)}</span>
          <span className="cn-ny-fleet-doing">{agent.note ?? agentDoing(agent, view)}</span>
          <em>{elapsed(agent.startedAt, null, view.now)}</em>
        </BareButton>
      ))}
    </div>
  );
}

function SentLine({ item, view }: { item: ListenItem; view: CockpitView }): JSX.Element | null {
  const at = view.state.listener.sent.find((entry) => sameItem(entry.item, item))?.sentAt;
  return at === undefined ? null : <SentStrip at={at} now={view.now} />;
}

function AsksColumn({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const asks = view.needsYou;
  return (
    <section className="cn-card cn-ny-col">
      <h3>
        From the orchestrator <i className="cn-n">{asks.length}</i>
      </h3>
      {asks.length === 0 ? (
        <p className="cn-empty">Nothing is waiting on you.</p>
      ) : (
        <div className="cn-ny-list">
          <RailTiers
            rows={asks}
            draw={(tier) =>
              tier.map((row) => {
                const item: ListenItem = { kind: 'ask', id: row.id };
                return (
                  <div key={row.id} className="cn-ny-item">
                    <AskCard
                      row={row}
                      now={view.now}
                      open={askOpen(row, actions)}
                      claude={<ClaudeButton item={item} view={view} actions={actions} />}
                    />
                    <SentLine item={item} view={view} />
                  </div>
                );
              })
            }
          />
        </div>
      )}
      <HandledLine view={view} actions={actions} />
    </section>
  );
}

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
  const drawn = prs.map(({ pr, reasons }) => {
    const item: ListenItem = { kind: 'pr', number: pr.number };
    const row: PanelRowModel = {
      ...prRow(pr, view, actions),
      chips: (
        <span className="cn-ny-chips">
          {reasons.map((reason) => (
            <Tag key={reason} tone={REASON_TONE[reason]}>
              {PR_REASON_LABEL[reason]}
            </Tag>
          ))}
        </span>
      ),
      action: <ClaudeButton item={item} view={view} actions={actions} />,
    };
    return { item, row };
  });
  const rail = drawn.map(({ row }) => row);
  return (
    <section className="cn-card cn-ny-col cn-lamp-mark cn-read-marks">
      <h3>
        Pull requests waiting on you{' '}
        <i className="cn-n">
          {prs.length} of {open} open
        </i>
      </h3>
      {prs.length === 0 && <p className="cn-empty">No pull request is waiting on you.</p>}
      {drawn.map(({ item, row }) => (
        <div key={row.key} className="cn-ny-item">
          <PanelRows layout="stacked" words="subline" rows={[row]} rail={rail} />
          <SentLine item={item} view={view} />
        </div>
      ))}
      {open > 0 && (
        <BareButton usage={tabUsage('overview')} className="cn-ny-all" onClick={() => openOverview(actions)}>
          All {plural(open, 'open pull request')} →
        </BareButton>
      )}
    </section>
  );
}

function askOpen(row: NeedRow, actions: CockpitActions): Destination | null {
  if (row.check !== undefined) return configDestination(row.check, actions);
  return row.opens === null ? null : openRow(row, actions);
}

function AskCard({
  row,
  now,
  open,
  claude,
}: {
  row: NeedRow;
  now: number;
  open: Destination | null;
  claude: ReactNode;
}): JSX.Element {
  const ref = askRef(row);
  const why = row.note ?? row.check?.remedy;
  return (
    <div className={rowClass(row, null, false, 'cn-ny-ask')}>
      <i className="cn-stripe" />
      <div className="cn-qin">
        <div className="cn-qkind">
          <KindTag kind={row.kind} />
          {ref !== null && (
            <span className="cn-refs">
              <Ref to={ref} />
            </span>
          )}
          {row.raisedAt !== '' && <i className="cn-qage">{relTime(row.raisedAt, now)}</i>}
        </div>
        <p className="cn-qtitle">{row.title}</p>
        {why !== undefined && <p className="cn-ny-why">{why}</p>}
        <HeadRow className="cn-ny-askfoot">
          <AskMeta row={row} />
          <span className="cn-ny-acts">
            {claude}
            {open !== null && (
              <Button size="small" usage={open.usage} onClick={open.go}>
                {row.verb ?? KIND_VERB[row.kind]}
              </Button>
            )}
          </span>
        </HeadRow>
      </div>
    </div>
  );
}

function AskMeta({ row }: { row: NeedRow }): JSX.Element {
  return (
    <span className="cn-qmeta">
      {row.agentId !== null && <span>{row.agentLabel ?? UNNAMED_RUN}</span>}
      {row.holding > 0 && <span className="cn-hold">{holdingLabel(row.holding)}</span>}
      {row.group === 'blocking' && <span className="cn-blk">Blocking</span>}
    </span>
  );
}

function ClaudeButton({
  item,
  view,
  actions,
}: {
  item: ListenItem;
  view: CockpitView;
  actions: CockpitActions;
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
          ? 'Hand this to your listening Claude chat — it queues behind the one the chat is on'
          : 'Hand this to your listening Claude chat'
      }
      onClick={() => actions.listenSend(item)}
    >
      <Icon name="chat" />
      Talk it through
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
