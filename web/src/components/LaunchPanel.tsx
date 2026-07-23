import { useState } from 'react';
import { api } from '../api.js';
import type { Job } from '../types.js';
import { SubmitButton, AsyncButton, useAsyncAction } from './AsyncButton.js';
import { relTime } from './util.js';

/**
 * Launch a new job from the cockpit: a free-form prompt the harness turns into an
 * agent. It's queued server-side and drained by the dispatcher ahead of all
 * world-driven work — so it takes the next free slot, or waits in the queue when
 * the fleet is at capacity. Queued jobs are listed with their place in line and a
 * cancel button; once dispatched they graduate into the Fleet.
 */
export function LaunchPanel({ jobs, onChanged }: { jobs: Job[]; onChanged: () => void }) {
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'code' | 'desk'>('code');
  const [open, setOpen] = useState(false);
  const submit = useAsyncAction();

  const queued = jobs.filter((j) => j.status === 'queued');

  const launch = async () => {
    const text = prompt.trim();
    if (!text) return;
    await api.launchJob({ prompt: text, kind });
    setPrompt('');
    onChanged();
  };

  return (
    <div className="launch">
      <div className="launch-head">
        <button className="btn ghost" onClick={() => setOpen((o) => !o)}>
          {open ? '× New job' : '+ New job'}
        </button>
        {queued.length > 0 && (
          <span className="chip small" title="Jobs waiting for a free slot">
            {queued.length} queued
          </span>
        )}
      </div>

      {open && (
        <form
          className="launch-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit.run(launch);
          }}
        >
          <textarea
            className="launch-prompt"
            placeholder="Describe the job — e.g. “Add rate-limiting to the /api/login route and open a PR.”"
            value={prompt}
            rows={3}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter submits, matching the drawer's respond box.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void submit.run(launch);
              }
            }}
          />
          <div className="launch-controls">
            <label className="launch-kind" title="A code job runs in a git worktree; a desk job in a scratch dir">
              <select value={kind} onChange={(e) => setKind(e.target.value as 'code' | 'desk')}>
                <option value="code">code agent</option>
                <option value="desk">desk agent</option>
              </select>
            </label>
            <SubmitButton phase={submit.phase} className="primary">
              Launch
            </SubmitButton>
          </div>
        </form>
      )}

      {queued.length > 0 && (
        <ul className="launch-queue">
          {queued.map((job, i) => (
            <li key={job.id} className="launch-queue-item">
              <span className="launch-pos" title="Position in the queue">
                {i + 1}
              </span>
              <span className="launch-title" title={job.prompt}>
                {job.title}
              </span>
              <span className="chip small">{job.kind}</span>
              <span className="muted launch-age">{relTime(job.createdAt)}</span>
              <AsyncButton
                className="ghost"
                onClick={() => api.cancelJob(job.id).then(onChanged)}
                title="Remove this job from the queue"
              >
                cancel
              </AsyncButton>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
