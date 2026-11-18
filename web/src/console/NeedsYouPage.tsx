import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions, ListenItem } from '../cockpit/actions.js';
import type { AppState } from '../types.js';
import type { NeedRow } from '../view/needsYou.js';
import { prsOnYou, PR_REASON_LABEL, type PrReason } from '../view/prsOnYou.js';
import { KIND_TONE } from '../view/askKinds.js';
import { plural } from '../view/plural.js';
import { askOnlyPrompt, LISTEN_PROMPT, prPrompt } from '../cockpit/listenPrompts.js';
import { tabUsage } from '../cockpit/usage.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { BareButton, Button, type Destination } from '../components/button.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { Icon } from '../components/icons.js';
import { HeadRow } from '../components/panel.js';
import { Ref } from '../components/refs.js';
import { Tag, type TagTone } from '../components/tag.js';
import { relTime } from '../components/util.js';
import { PanelRows, type PanelRowModel } from './PanelRow.js';
import { prRow } from './prRow.js';
import { openRow } from './queueRailOpens.js';
import { HandledLine, holdingLabel, KIND_VERB, KindTag, RailTiers } from './QueueRail.js';

// → docs/spec/44-needs-you.md

type Listener = AppState['listener'];

const PR_ORIGIN = /^pr:(\d+)(?::|$)/;

const REASON_TONE: Record<PrReason, TagTone> = {
  review: 'red',
  call: 'amber',
  comments: 'blue',
  reviewer: 'violet',
  description: 'grey',
};

function askRef(row: NeedRow): string | null {
  if (row.goalRef !== null) return row.goalRef;
  const pr = row.prNumber ?? PR_ORIGIN.exec(row.originRef ?? '')?.[1];
  return pr === undefined ? null : `pr:${pr}`;
}

function sameItem(a: ListenItem, b: ListenItem): boolean {
  return a.kind === 'ask' ? b.kind === 'ask' && a.id === b.id : b.kind === 'pr' && a.number === b.number;
}

/** What one page draws per item: its Claude button, and its strip once sent. */
interface Hand {
  claude: (item: ListenItem) => ReactNode;
  sent: (item: ListenItem) => ReactNode;
}

export function NeedsYouPage({ view, actions }: { view: CockpitView; actions: CockpitActions }): JSX.Element {
  const listener = view.state.listener;
  const folder = view.state.config.desktopFolder;
  const prs = prsOnYou(view.state.world.pullRequests);
  const hand: Hand = {
    claude: (item) => <ClaudeButton item={item} listener={listener} folder={folder} actions={actions} />,
    sent: (item) => {
      const at = listener.sent.find((entry) => sameItem(entry.item, item))?.sentAt;
      return at === undefined ? null : <SentStrip at={at} now={view.now} />;
    },
  };
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
        <AsksColumn view={view} actions={actions} hand={hand} />
        <PrsColumn view={view} actions={actions} hand={hand} prs={prs} />
      </div>
    </div>
  );
}

function AsksColumn({ view, actions, hand }: { view: CockpitView; actions: CockpitActions; hand: Hand }): JSX.Element {
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
                    <AskCard row={row} now={view.now} open={askOpen(row, actions)} claude={hand.claude(item)} />
                    {hand.sent(item)}
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
  hand,
  prs,
}: {
  view: CockpitView;
  actions: CockpitActions;
  hand: Hand;
  prs: ReturnType<typeof prsOnYou>;
}): JSX.Element {
  const open = view.state.world.pullRequests.length;
  const rows = prs.map(({ pr, reasons }): PanelRowModel => ({
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
    action: hand.claude({ kind: 'pr', number: pr.number }),
  }));
  return (
    <section className="cn-card cn-ny-col cn-lamp-mark cn-read-marks">
      <h3>
        Pull requests waiting on you{' '}
        <i className="cn-n">
          {prs.length} of {open} open
        </i>
      </h3>
      {prs.length === 0 && <p className="cn-empty">No pull request is waiting on you.</p>}
      {rows.map((row, i) => (
        <div key={row.key} className="cn-ny-item">
          <PanelRows layout="stacked" words="subline" rows={[row]} rail={rows} />
          {hand.sent({ kind: 'pr', number: prs[i]!.pr.number })}
        </div>
      ))}
      {open > 0 && (
        <BareButton
          usage={tabUsage('overview')}
          className="cn-ny-all"
          onClick={() => {
            actions.selectGoal(null);
            actions.openTab('overview');
          }}
        >
          All {plural(open, 'open pull request')} →
        </BareButton>
      )}
    </section>
  );
}

function askOpen(row: NeedRow, actions: CockpitActions): Destination | null {
  const fix = row.check?.fix;
  if (row.check !== undefined) {
    const group = fix?.kind === 'config' || fix?.kind === 'goto' ? fix.group : null;
    return {
      usage: { counted: 'config.view' },
      go: () => actions.openConfig({ configTab: 'values', configGroup: group }),
    };
  }
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
  const cls = ['cn-q', 'cn-ny-ask', `cn-t-${KIND_TONE[row.kind]}`, row.group === 'blocking' ? 'cn-parked' : '']
    .filter((c) => c !== '')
    .join(' ');
  return (
    <div className={cls}>
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
      {row.agentId !== null && <span>{row.agentLabel ?? 'a run with no task on record'}</span>}
      {row.holding > 0 && <span className="cn-hold">{holdingLabel(row.holding)}</span>}
      {row.group === 'blocking' && <span className="cn-blk">Blocking</span>}
    </span>
  );
}

function ClaudeButton({
  item,
  listener,
  folder,
  actions,
}: {
  item: ListenItem;
  listener: Listener;
  folder: string;
  actions: CockpitActions;
}): JSX.Element | null {
  if (listener.state === 'off') {
    if (!folder) return null;
    return (
      <DesktopLink
        usage="goal.open"
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
      usage={{ counted: item.kind === 'ask' ? 'escalation.send' : 'pr.send' }}
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
  listener: Listener;
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
          usage="fleet.open"
          control={false}
          className="cn-ny-claude"
          folder={folder}
          prompt={LISTEN_PROMPT}
          label="Start listen loop"
          ready="in a new chat"
          explain="so the asks and pull requests you send from this page land in it."
        />
      )}
      <Button
        size="small"
        ghost
        usage="config.copy"
        title={`Copy "${LISTEN_PROMPT}" to paste into a Claude chat already open`}
        onClick={() => void navigator.clipboard?.writeText(LISTEN_PROMPT).catch(() => undefined)}
      >
        Copy
      </Button>
    </span>
  );
}
