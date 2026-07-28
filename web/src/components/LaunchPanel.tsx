import { useState } from 'react';
import { api } from '../api.js';
import type { Job } from '../types.js';
import { SubmitButton, AsyncButton, useAsyncAction } from './AsyncButton.js';
import { relTime } from './util.js';

/**
 * The blueprint plate: a blue sheet with a white grid, drawn inline rather than
 * added to a skin's sprite sheet because this panel is shared and a skin's sprites
 * are not. It is the one glyph in the cockpit that is *not* `currentColor` — a
 * blueprint is blue the way a warning is amber, so the colour is the noun.
 */
function BlueprintMark() {
  return (
    <svg className="launch-bp" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="2" width="14" height="12" rx="1" fill="var(--blue-fill)" stroke="var(--blue)" strokeWidth="1.4" />
      <path d="M5.5 2v12M10.5 2v12M1 6h14M1 10h14" fill="none" stroke="var(--blue)" strokeWidth="0.8" opacity=".7" />
    </svg>
  );
}

/**
 * Stamp a new blueprint from the cockpit: a free-form prompt the harness turns
 * into an agent. It's queued server-side and drained by the dispatcher ahead of
 * all world-driven work — so it takes the next free slot, or waits in the queue
 * when the fleet is at capacity. Queued blueprints are listed with their place in
 * line and a cancel button; once dispatched they graduate into the Fleet.
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
          <BlueprintMark />
          {open ? '× New blueprint' : '+ New blueprint'}
        </button>
        {queued.length > 0 && (
          <span className="chip small" title="Blueprints waiting for a free slot">
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
                title="Remove this blueprint from the queue"
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
