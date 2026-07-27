import type { JSX } from 'react';
import type { Escalation, Proposal } from '../../../types.js';
import { relTime } from '../../../components/util.js';
import { Icon, type IconName } from './Sprite.js';

/**
 * The hazard strip: every open alert, one line each, above everything else.
 *
 * It is a *summary*, not an inbox — answering still happens on the shared
 * escalation card further down, which owns the refusal rules and the async flow.
 * What this adds is that an alert is visible without scrolling and names which
 * bay it came off, which is the reading the fleet card cannot give you until you
 * have found it.
 */

interface Alert {
  key: string;
  tone: 'crit' | 'warn';
  icon: IconName;
  head: string;
  sub: string;
  agentId: string | null;
}

/** What kind of alert this is, read off the proposal it carries — or its absence. */
function classify(
  e: Escalation,
  proposal: Proposal | undefined,
): { head: string; icon: IconName; tone: 'crit' | 'warn' } {
  if (e.context.permission) {
    return { head: 'Permission requested', icon: 'alert', tone: 'crit' };
  }
  if (proposal?.kind === 'plan') {
    return { head: 'Blueprint unstamped', icon: 'blueprint', tone: 'warn' };
  }
  if (proposal?.kind === 'merge') {
    return { head: 'Launch awaiting your stamp', icon: 'rocket', tone: 'warn' };
  }
  if (proposal) {
    return { head: 'Reply awaiting your stamp', icon: 'inserter', tone: 'warn' };
  }
  return { head: 'Bot idle — awaiting input', icon: 'bot', tone: 'crit' };
}

export function AlertBay({
  escalations,
  proposalFor,
  errorCount,
  now,
  onOpenAgent,
}: {
  escalations: Escalation[];
  proposalFor: ReadonlyMap<string, Proposal>;
  errorCount: number;
  now: number;
  onOpenAgent(agentId: string): void;
}): JSX.Element | null {
  const alerts: Alert[] = escalations.map((e) => {
    const { head, icon, tone } = classify(e, proposalFor.get(e.id));
    const ref = e.context.originRef ?? e.context.taskTitle ?? e.taskId ?? 'no origin';
    return { key: e.id, tone, icon, head, sub: `${ref} · ${relTime(e.createdAt, now)}`, agentId: e.agentId };
  });

  if (errorCount > 0) {
    alerts.push({
      key: 'faults',
      tone: 'warn',
      icon: 'lamp',
      head: `${errorCount} fault${errorCount === 1 ? '' : 's'} recorded`,
      sub: 'see the fault log at the foot of the floor',
      agentId: null,
    });
  }

  if (alerts.length === 0) return null;

  return (
    <div className="fx-alerts fx-bev">
      {alerts.map((a) => (
        <button
          key={a.key}
          type="button"
          className={`fx-alert fx-sunk ${a.tone}`}
          disabled={!a.agentId}
          onClick={() => a.agentId && onOpenAgent(a.agentId)}
          title={a.agentId ? 'Open the bay transcript' : undefined}
        >
          <Icon name={a.icon} className="lg" />
          <span className="txt">
            <span className="fx-alert-hd">{a.head}</span>
            <span className="fx-alert-sd">{a.sub}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
