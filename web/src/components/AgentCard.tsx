import type { Agent, Task } from '../types.js';
import { statusDot, relTime } from './util.js';

export function AgentCard({
  agent,
  task,
  onOpen,
  onKill,
  past,
}: {
  agent: Agent;
  task: Task | null;
  onOpen: () => void;
  onKill?: () => void;
  past?: boolean;
}) {
  return (
    <div className={`card agent ${agent.status} ${past ? 'past' : ''}`}>
      <div className="card-head" onClick={onOpen}>
        {statusDot(agent.status)}
        <span className="card-title">{task?.title ?? agent.taskId}</span>
        <span className="chip small">{task?.kind ?? '—'}</span>
      </div>
      <div className="card-meta">
        <span className={`badge ${agent.status}`}>{agent.status}</span>
        {task?.branch && <span className="mono">{task.branch}</span>}
        <span className="muted">{relTime(agent.startedAt)}</span>
      </div>
      {agent.waitingReason && <div className="waiting-reason">⏳ {agent.waitingReason}</div>}
      <div className="card-actions">
        <button className="btn" onClick={onOpen}>
          Open
        </button>
        {onKill && agent.status !== 'done' && (
          <button className="btn danger" onClick={onKill}>
            Kill
          </button>
        )}
      </div>
    </div>
  );
}
