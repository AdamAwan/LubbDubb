import { useState, type JSX } from 'react';
import type { AppErrorDetail as Detail } from '../types.js';
import type { ErrorRow } from '../view/appErrors.js';
import { api } from '../api.js';
import { Collapsible } from './collapsible.js';

// → docs/spec/39-app-errors.md#in-the-cockpit

type Loaded = Detail | 'loading' | 'failed';

export function AppErrorDetailFold({ row }: { row: ErrorRow }): JSX.Element | null {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  if (!row.hasDetail && row.frames.length === 0) return null;
  const onToggle = (open: boolean): void => {
    if (!open || !row.hasDetail || (loaded !== null && loaded !== 'failed')) return;
    setLoaded('loading');
    api.getAppErrorDetail(row.environment, row.fingerprint).then(setLoaded, () => setLoaded('failed'));
  };
  return (
    <Collapsible subject="app-error" className="ae-detail" title="Error and stack" onToggle={onToggle}>
      <DetailBody frames={row.frames} loaded={row.hasDetail ? loaded : { message: null, stack: null }} />
    </Collapsible>
  );
}

/** @public the seam the body is rendered through in `test/appErrorsCockpit.test.ts` */
export function DetailBody({ frames, loaded }: { frames: string[]; loaded: Loaded | null }): JSX.Element {
  if (loaded === null || loaded === 'loading') return <p className="ae-note">Reading…</p>;
  if (loaded === 'failed') return <p className="ae-warn">The message and stack could not be read.</p>;
  const trace = loaded.stack ?? (frames.length > 0 ? frames.join('\n') : null);
  return (
    <>
      {loaded.message !== null && <p className="ae-message">{loaded.message}</p>}
      {loaded.stack === null && (
        <p className="ae-note">
          {trace === null ? 'No stack reported.' : 'No stack reported — the top in-app frames:'}
        </p>
      )}
      {trace !== null && <pre className="ae-stack">{trace}</pre>}
    </>
  );
}
