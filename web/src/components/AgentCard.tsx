import type { Agent, Task } from '../types.js';
import { statusDot, elapsed } from './util.js';
import { ConfirmButton } from './ConfirmButton.js';

export function AgentCard({
  agent,
  task,
  now,
  lastLine,
  onOpen,
  onKill,
  past,
}: {
  agent: Agent;
  task: Task | null;
  now: number;
  lastLine?: string;
  onOpen: () => void;
  onKill?: () => void;
  past?: boolean;
}) {
  const active = agent.status === 'running' || agent.status === 'starting';
  return (
    <div className={`card agent ${agent.status} ${past ? 'past' : ''}`}>
      <div className="card-head" onClick={onOpen}>
        {statusDot(agent.status)}
        <span className="card-title">{task?.title ?? agent.taskId}</span>
        <span className="chip small">{task?.kind ?? '—'}</span>
      </div>
      <div className="card-meta">
        <span className={`badge ${agent.status}`}>
          {active && <span className="spinner" aria-hidden />}
          {agent.status}
        </span>
        {task?.branch && <span className="mono">{task.branch}</span>}
        <span className="muted mono-time">{elapsed(agent.startedAt, agent.endedAt, now)}</span>
      </div>
      {agent.waitingReason && <div className="waiting-reason">⏳ {agent.waitingReason}</div>}
      {active && lastLine && <div className="last-line mono">{lastLine}</div>}
      <div className="card-actions">
        <button className="btn" onClick={onOpen}>
          Open
        </button>
        {onKill && agent.status !== 'done' && (
          <ConfirmButton label="Kill" confirmLabel="Confirm kill" onConfirm={onKill} />
        )}
      </div>
    </div>
  );
}
