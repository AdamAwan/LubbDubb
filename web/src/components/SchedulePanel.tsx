import { useState } from 'react';
import { api } from '../api.js';
import type { JobSchedule } from '../types.js';
import { AsyncButton, SubmitButton, useAsyncAction } from './AsyncButton.js';
import { ConfirmButton } from './ConfirmButton.js';
import { relTime } from './util.js';
import { Button } from './button.js';

/**
 * A clock face, drawn inline beside the brief sheet for the same reason that
 * one is: this panel is shared, and a presentation layer's icon set is not. It is
 * `currentColor` — a recurrence is not a *kind* of thing the way a brief is,
 * it is the same brief on a timer.
 */
function ClockMark() {
  return (
    <svg className="launch-mark" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
      <path d="M8 4.6V8l2.4 1.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

/** A few recurrences worth having in front of somebody who has not written cron in a while. */
const EXAMPLES = [
  { cron: '0 9 * * 1-5', label: 'weekdays at 09:00' },
  { cron: '0 3 * * *', label: 'every night at 03:00' },
  { cron: '0 9 * * 1', label: 'Mondays at 09:00' },
  { cron: '0 */4 * * *', label: 'every 4 hours' },
];

/**
 * When the next firing lands, in the same register as {@link relTime} — which
 * clamps a future instant to "0s ago" and so cannot say this. Both halves of the
 * panel are about a time that has not happened yet, which is exactly what the rest
 * of the cockpit never has to render.
 */
function untilTime(iso: string, now: number = Date.now()): string {
  const secs = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  if (secs < 60) return `in ${secs}s`;
  if (secs < 3600) return `in ${Math.round(secs / 60)}m`;
  if (secs < 86_400) return `in ${Math.round(secs / 3600)}h`;
  return `in ${Math.round(secs / 86_400)}d`;
}

/**
 * Recurring briefs: the prompts an operator wants queued on a clock rather
 * than by hand.
 *
 * It sits under the launch composer because it is the same act with a `when`
 * attached, and every control on it bottoms out in the same place: a firing writes
 * the identical `jobs` row the composer above writes, so nothing here can put an
 * agent on the fleet that "+ New brief" could not.
 *
 * What the rows show is the two things a standing intention is judged on — when it
 * next runs, and when it last did. A schedule that has never fired and a schedule
 * that fired last night look different at a glance, which is the whole reason the
 * panel lists them rather than leaving them in the database.
 */
export function SchedulePanel({ schedules, onChanged }: { schedules: JobSchedule[]; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [cron, setCron] = useState('0 9 * * 1-5');
  const [prompt, setPrompt] = useState('');
  const [kind, setKind] = useState<'code' | 'desk'>('code');
  // The server's refusal, in its own words. The cron parser names the field and
  // what that field accepts, which is the only thing that helps somebody who has
  // just mistyped an expression — a second wording here would be a worse one.
  const [error, setError] = useState<string | null>(null);
  const submit = useAsyncAction();

  const create = async () => {
    const text = prompt.trim();
    if (!text) return;
    try {
      await api.createSchedule({ cron: cron.trim(), prompt: text, kind });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the schedule');
      // Rethrown so the button flashes, and the form is kept for a retry — the
      // composer's rule, and the same reason: a rejected cron expression is one
      // character away from a good one.
      throw err;
    }
    setPrompt('');
    setError(null);
    onChanged();
  };

  return (
    <div className="launch sched">
      <div className="launch-head">
        <Button ghost onClick={() => setOpen((o) => !o)}>
          <ClockMark />
          {open ? '× New schedule' : '+ New schedule'}
        </Button>
        {schedules.length > 0 && (
          <span className="chip small" title="Recurrences that queue a brief on a clock">
            {schedules.filter((s) => s.enabled).length} running
          </span>
        )}
      </div>

      {open && (
        <form
          className="launch-form"
          onSubmit={(e) => {
            e.preventDefault();
            void submit.run(create);
          }}
        >
          <div className="sched-cron">
            <input
              className="sched-cron-input"
              value={cron}
              spellCheck={false}
              aria-label="cron expression"
              placeholder="minute hour day-of-month month day-of-week"
              onChange={(e) => setCron(e.target.value)}
            />
            <span className="muted sched-tz" title="Cron fields are read in the timezone the harness process runs in">
              local time
            </span>
          </div>
          <ul className="sched-examples">
            {EXAMPLES.map((example) => (
              <li key={example.cron}>
                <Button ghost size="small" onClick={() => setCron(example.cron)}>
                  <code>{example.cron}</code> {example.label}
                </Button>
              </li>
            ))}
          </ul>
          <textarea
            className="launch-prompt"
            placeholder="Describe what should run — e.g. “Review the open PRs for anything stale and comment on each.”"
            value={prompt}
            rows={3}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter submits, matching the brief composer above.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                e.preventDefault();
                void submit.run(create);
              }
            }}
          />
          {error && (
            <p className="launch-error" role="alert">
              {error}
            </p>
          )}
          <div className="launch-controls">
            <label className="launch-kind" title="A code job runs in a git worktree; a desk job in a scratch dir">
              <select value={kind} onChange={(e) => setKind(e.target.value as 'code' | 'desk')}>
                <option value="code">code agent</option>
                <option value="desk">desk agent</option>
              </select>
            </label>
            <SubmitButton phase={submit.phase} tone="primary">
              Save schedule
            </SubmitButton>
          </div>
        </form>
      )}

      {schedules.length > 0 && (
        <ul className="launch-queue">
          {schedules.map((schedule) => (
            <li key={schedule.id} className={`launch-queue-item${schedule.enabled ? '' : ' sched-off'}`}>
              <code className="sched-expr" title="Read in the harness's own timezone">
                {schedule.cron}
              </code>
              <span className="launch-title" title={schedule.prompt}>
                {schedule.title}
              </span>
              <span className="chip small">{schedule.kind}</span>
              {/* The two things a standing intention is judged on. A disabled one
                  says so instead of showing a next run it does not have. */}
              <span className="muted launch-age" title={schedule.nextRunAt ?? 'not scheduled'}>
                {!schedule.enabled ? 'paused' : schedule.nextRunAt ? untilTime(schedule.nextRunAt) : 'never'}
              </span>
              <span className="muted launch-age" title="When it last queued a job">
                {schedule.lastFiredAt ? `ran ${relTime(schedule.lastFiredAt)}` : 'never run'}
              </span>
              <AsyncButton
                ghost
                onClick={() => api.runSchedule(schedule.id).then(onChanged)}
                title="Queue this schedule's job now, without moving its next run"
              >
                run now
              </AsyncButton>
              <AsyncButton
                ghost
                onClick={() => api.updateSchedule(schedule.id, { enabled: !schedule.enabled }).then(onChanged)}
                title={schedule.enabled ? 'Stop firing, keep the recurrence' : 'Start firing again from now'}
              >
                {schedule.enabled ? 'pause' : 'resume'}
              </AsyncButton>
              <ConfirmButton
                ghost
                size="small"
                label="delete"
                confirmLabel="delete?"
                title="Forget this recurrence — the jobs it already queued are untouched"
                onConfirm={() => api.deleteSchedule(schedule.id).then(onChanged)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
