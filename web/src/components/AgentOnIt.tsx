import type { JSX } from 'react';
import type { CockpitActions } from '../cockpit/actions.js';
import { Icon } from './icons.js';

// → docs/spec/17-cockpit.md

export function AgentOnIt({
  agentId,
  note,
  holding = false,
  actions,
}: {
  agentId: string;
  note?: string | null;
  holding?: boolean;
  actions: CockpitActions;
}): JSX.Element {
  const said =
    note ??
    (holding
      ? 'An agent is holding for an answer — open its transcript'
      : 'An agent is working this — open its transcript');
  return (
    <button
      type="button"
      className={holding ? 'cn-onit cn-onit-hold' : 'cn-onit'}
      onClick={() => actions.select(agentId)}
      title={said}
      aria-label={`${holding ? 'Agent holding' : 'Agent on it'} — ${said}`}
    >
      <i className="cn-onit-dot">
        <Icon name={holding ? 'pause' : 'play'} size={11} />
      </i>
    </button>
  );
}
