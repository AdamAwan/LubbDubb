import { api } from '../api.js';

/**
 * Live fleet controls in the topbar: nudge the concurrency cap up/down and
 * pause/resume dispatch. Both fire POST /api/control; the resulting
 * `control:changed` broadcast (handled in App) flows the new state back, so this
 * component stays stateless and always renders the server's truth.
 */
export function FleetControl({ live, cap, paused }: { live: number; cap: number; paused: boolean }) {
  const setCap = (next: number): void => {
    if (next < 0) return;
    void api.setControl({ cap: next });
  };
  return (
    <div className={`fleet-control ${paused ? 'paused' : ''}`}>
      <span className="fc-label">cap</span>
      <button className="btn ghost fc-step" onClick={() => setCap(cap - 1)} disabled={cap <= 0} title="Lower the cap">
        −
      </button>
      <span className="fc-count" title={`${live} of ${cap} slots in use`}>
        {live}/{cap}
      </span>
      <button className="btn ghost fc-step" onClick={() => setCap(cap + 1)} title="Raise the cap">
        +
      </button>
      <button
        className={`btn ${paused ? 'primary' : 'ghost'}`}
        onClick={() => void api.setControl({ paused: !paused })}
        title={paused ? 'Resume dispatch' : 'Pause new dispatch (live agents keep running)'}
      >
        {paused ? '▶ Resume' : '⏸ Pause'}
      </button>
    </div>
  );
}
