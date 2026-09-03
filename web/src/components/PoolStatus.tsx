import { useEffect, useState, type JSX } from 'react';
import type { PoolStatePayload } from '../types.js';
import { api } from '../api.js';
import { relTime } from './util.js';

/**
 * This fleet's own side of the cross-fleet pool, drawn on the Knowledge page.
 *
 * It answers three questions and nothing else, because the pool is a **view** here
 * and never a database:
 *
 * - **When did this fleet last publish, and last poll?** *Could not reach the pool*
 *   is never folded into *nobody has published anything* — read as absence, an
 *   outage says in the operator's words that nobody else knows anything.
 * - **Which of its claims did the secret backstop refuse, and why?** A refusal that
 *   is invisible is a claim an operator vouched for that never reaches the pool with
 *   nothing saying why, which reads exactly like a pool that is broken. Refusing is
 *   loud by design, and this is where it is loud.
 * - **Who else is in the pool?** Including the fleets that are *ahead of this build*,
 *   which is a third verdict rather than a quiet absence.
 *
 * It fetches, which is why it is a component under `components/` rather than
 * anything under `console/` — the console may not reach `api.js`, and this is the
 * sanctioned route the tickets tab and the Insights page already take. It fetches
 * once on mount rather than polling: the desk's cadence is the pulse, so a second
 * clock here would mostly redraw an unchanged panel.
 *
 * With no pool configured it draws **nothing at all**. A deployment on the `fake`
 * default and a pool that has never published are different facts, and an empty
 * panel for the first would say something is broken.
 *
 * → `docs/spec/28-cross-fleet-pool.md#in-the-cockpit`
 */
export function PoolStatus({ now }: { now: number }): JSX.Element | null {
  const [payload, setPayload] = useState<PoolStatePayload | null>(null);
  useEffect(() => {
    let live = true;
    api
      .getPool()
      .then((res) => live && setPayload(res))
      // Silent: the pool is an addendum to this page, and a fleet with an
      // unreachable one works exactly as a fleet without one. Failures are recorded
      // server-side through `errors.record` and read in the Errors panel.
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
