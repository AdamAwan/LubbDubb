import { api } from '../api.js';
import { AsyncButton } from './AsyncButton.js';

// → docs/spec/17-cockpit.md

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
        ghost
        className="fc-step"
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
        ghost
        className="fc-step"
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
