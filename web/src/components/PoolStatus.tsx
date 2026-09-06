import { useEffect, useState, type JSX } from 'react';
import type { PoolStatePayload } from '../types.js';
import { api } from '../api.js';
import { relTime } from './util.js';

// → docs/spec/17-cockpit.md

export function PoolStatus({ now }: { now: number }): JSX.Element | null {
  const [payload, setPayload] = useState<PoolStatePayload | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getPool()
      .then((res) => live && setPayload(res))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  const status = payload?.status ?? null;
  if (status === null) return null;

  return (
    <section className="pool-status">
      <h3>
        The pool <span className="pool-fleet-p">{status.fleetId}</span>
      </h3>
      <p className="pool-note">
        {status.project} · via <code>{status.transportId}</code>
        {status.canRead ? null : ' · publish-only: this fleet contributes and reads nothing'}
      </p>
      <dl className="pool-status-facts">
        <div>
          <dt>Digest published</dt>
          <dd>{status.digest.publishedAt === null ? 'not yet' : relTime(status.digest.publishedAt, now)}</dd>
        </div>
        <div>
          <dt>Last polled</dt>
          {/* Stale is said out loud, never drawn as an empty mirror. */}
          <dd>{status.polledAt === null ? 'never — the pool has not been read yet' : relTime(status.polledAt, now)}</dd>
        </div>
      </dl>

      {payload === null || payload.fleets.length === 0 ? null : (
        <div className="pool-fleets">
          {payload.fleets.map((fleet) => (
            <span key={fleet.fleetId} className={fleet.ahead ? 'pool-fleet ahead' : 'pool-fleet'}>
              {/* No `<Ref/>`: a pooled fleet has no ref to draw, and its name is text. */}
              <strong>{fleet.fleetId}</strong>
              <span className="pool-fleet-at">
                {fleet.ahead
                  ? 'ahead of this build'
                  : fleet.digestAt === null
                    ? 'no digest yet'
                    : relTime(fleet.digestAt, now)}
              </span>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
