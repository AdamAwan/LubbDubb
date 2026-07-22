import { api } from '../api.js';
import { AsyncButton } from './AsyncButton.js';

/**
 * Live fleet controls in the topbar: nudge the concurrency cap up/down and
 * pause/resume dispatch. Both fire POST /api/control; the resulting
 * `control:changed` broadcast (handled in App) flows the new state back, so this
 * component stays stateless and always renders the server's truth. Each button
 * shows a spinner while its POST is in flight so the nudge registers visibly.
 */
export function FleetControl({ live, cap, paused }: { live: number; cap: number; paused: boolean }) {
  const setCap = (next: number): Promise<unknown> | void => {
    if (next < 0) return;
    return api.setControl({ cap: next });
  };
  const spinner = <span className="spinner" aria-hidden />;
  return (
    <div className={`fleet-control ${paused ? 'paused' : ''}`}>
      <span className="fc-label">cap</span>
      <AsyncButton
        className="ghost fc-step"
        onClick={() => setCap(cap - 1)}
        disabled={cap <= 0}
        title="Lower the cap"
        pendingLabel={spinner}
      >
        −
      </AsyncButton>
      <span className="fc-count" title={`${live} of ${cap} slots in use`}>
        {live}/{cap}
      </span>
      <AsyncButton
        className="ghost fc-step"
        onClick={() => setCap(cap + 1)}
        title="Raise the cap"
        pendingLabel={spinner}
      >
        +
      </AsyncButton>
      <AsyncButton
        className={paused ? 'primary' : 'ghost'}
        onClick={() => api.setControl({ paused: !paused })}
        title={paused ? 'Resume dispatch' : 'Pause new dispatch (live agents keep running)'}
      >
        {paused ? '▶ Resume' : '⏸ Pause'}
      </AsyncButton>
    </div>
  );
}
