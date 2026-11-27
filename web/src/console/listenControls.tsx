import type { JSX, ReactNode } from 'react';
import type { CockpitView } from '../view/viewModel.js';
import type { CockpitActions } from '../cockpit/actions.js';
import type { ListenItem, ListenerView } from '../types.js';
import type { NeedRow } from '../view/needsYou.js';
import { sameItem } from '../view/needsYouPage.js';
import { askOnlyPrompt, listenPrompt, prPrompt } from '../cockpit/desktopLink.js';
import { AsyncButton } from '../components/AsyncButton.js';
import { Button } from '../components/button.js';
import { DesktopLink } from '../components/DesktopLink.js';
import { Icon } from '../components/icons.js';
import { Ref } from '../components/refs.js';
import { relTime } from '../components/util.js';
import { askRef } from './askCard.js';

// → docs/spec/44-needs-you.md#the-claude-button

export function SentLine({ item, view }: { item: ListenItem; view: CockpitView }): JSX.Element | null {
  const at = view.state.listener.sent.find((entry) => sameItem(entry.item, item))?.sentAt;
  return at === undefined ? null : <SentStrip at={at} now={view.now} />;
}

export function ClaudeButton({
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

function OnItem({ item, asks }: { item: ListenItem | null; asks: readonly NeedRow[] }): ReactNode {
  if (item === null) return 'an item';
  if (item.kind === 'pr') return <Ref to={`pr:${item.number}`} />;
  const row = asks.find((r) => r.id === item.id);
  const ref = row === undefined ? null : askRef(row);
  return ref === null ? 'an ask' : <Ref to={ref} />;
}

export function ListenerStatus({
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
