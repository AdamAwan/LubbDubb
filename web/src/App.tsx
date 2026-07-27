import { UnauthorizedError } from './api.js';
import { useCockpit } from './cockpit/useCockpit.js';
import { readStoredSkinId, resolveSkin } from './skins/registry.js';

/**
 * What the cockpit shows when the harness refuses its credential. Worth a screen
 * rather than a silent retry: the fix is a URL only the operator's terminal has,
 * so an unexplained "Connecting…" would leave them looking at the browser for a
 * problem whose answer is in the server log.
 */
function LockedOut({ error }: { error: UnauthorizedError }) {
  return (
    <div className="loading locked-out">
      <h1>{error.message}</h1>
      {error.status === 403 ? (
        <p>
          The harness refused this request&apos;s origin. Open the cockpit on <code>localhost</code> or{' '}
          <code>127.0.0.1</code> — a different hostname pointing at this machine is refused on purpose.
        </p>
      ) : (
        <p>
          Open the tokenised link the harness printed at startup — the <code>[lubbdubb] open the cockpit: …</code> line
          in its terminal. The token is stored per browser, so this is a one-off per machine.
        </p>
      )}
      <p className="muted">
        Running <code>npm start</code> again prints the same link; the token is reused across restarts.
      </p>
    </div>
  );
}

/**
 * The cockpit shell, and deliberately nothing more: acquire state, pick a skin,
 * hand the skin a finished view-model. Everything that decides what the operator
 * sees lives in `skins/`; everything that decides what is true lives in
 * `cockpit/` and `view/`.
 *
 * The two screens below stay here rather than moving into a skin because neither
 * has a view-model to draw — a skin cannot render a cockpit whose state never
 * arrived, and a locked-out cockpit must look the same however it was themed.
 */
export function App() {
  const status = useCockpit();

  if (status.kind === 'denied') return <LockedOut error={status.error} />;
  if (status.kind === 'loading') return <div className="loading">Connecting to the cockpit…</div>;

  const { Root } = resolveSkin(readStoredSkinId());
  return <Root view={status.view} actions={status.actions} />;
}
