import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { ConfigChange, SetupPayload, SetupResolvePayload } from '../types.js';
import { Button } from './button.js';

/**
 * Point the fleet at a project: one screen, pre-answered, and the file it writes.
 *
 * **It is a confirmation, not a wizard.** The three steps it replaced existed to
 * gather two answers the machine already had — an email `git config` knows and a
 * directory the process was started in — and then to show what they implied on a
 * screen you could only reach by walking forward. Here the answers are prefilled
 * and the derivation sits under them, re-read on every edit, so correcting the
 * email is a keystroke rather than a Back button. The old flow could also count
 * outstanding checks in the top bar and then open on a screen that showed none of
 * them; the checks live on the Needs you rail now, which is where an operator
 * already looks for things that want them.
 *
 * **It writes through `POST /api/config`.** There is no second store and no second
 * writer: what the answers produce is a set of config *leaves*, handed to the same
 * preview-then-save the config page uses, so the surgical splice that keeps an
 * operator's comments and key order intact is the one that runs here too.
 *
 * **Two repositories, and this names one of them.** `repoRoot` is the project the
 * fleet works on; LubbDubb's own checkout is resolved from the running module and
 * is never configurable. They coincide only when the harness is dogfooding — and
 * because `repoRoot` defaults to `process.cwd()`, that is exactly what a default
 * start proposes. `repoRootIsSelf` is why this screen says so out loud.
 *
 * → `docs/spec/26-setup.md`
 */
export function SetupPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [reading, setReading] = useState<SetupPayload | null>(null);
  const [email, setEmail] = useState('');
  const [repoRoot, setRepoRoot] = useState('');
  const [resolved, setResolved] = useState<SetupResolvePayload | null>(null);
  const [preview, setPreview] = useState<{ text: string; changes: readonly ConfigChange[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<readonly ConfigChange[] | null>(null);

  // The prefills are read once, on open. Re-reading them after an answer would
  // overwrite what the operator has typed with what the machine guessed.
  useEffect(() => {
    void api.getSetup().then((next) => {
      setReading(next);
      setEmail(next.prefill.email ?? '');
      setRepoRoot(next.prefill.repoRoot);
    });
  }, []);

  // Every edit re-reads, which is the whole of what makes this one screen rather
  // than three: the table below is a *reading* of the two fields, so a wrong email
  // is corrected in place instead of walked back to. Debounced because each read
  // shells out to git and may ask the credential who you are.
  useEffect(() => {
    if (reading === null || repoRoot.trim() === '') return;
    const timer = setTimeout(() => {
      setError(null);
      void api
        .resolveSetup({ email, repoRoot })
        .then((next) => {
          setResolved(next);
          setPreview(null);
        })
        .catch((err: Error) => setError(err.message));
    }, 400);
    return () => clearTimeout(timer);
  }, [email, repoRoot, reading]);

  if (reading === null) return <div className="cn-empty">Reading the configuration…</div>;

  const review = async (): Promise<void> => {
    if (resolved === null) return;
    setBusy(true);
    setError(null);
    try {
      // The bytes come from the server's own splice rather than being built here:
      // a second one in the browser would be free to disagree with the one that
      // writes, and the diff is the whole point of showing it.
      const config = await api.getConfig();
      const next = await api.previewConfig({ set: resolved.writes, baseline: config.revision });
      setPreview({ text: next.text, changes: next.changes });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const write = async (): Promise<void> => {
    if (resolved === null) return;
    setBusy(true);
    setError(null);
    try {
      const config = await api.getConfig();
      const result = await api.saveConfig({ set: resolved.writes, baseline: config.revision });
      setSaved(result.changes);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (saved !== null) return <Done changes={saved} onClose={onClose} />;

  return (
    <div className="cn-setup">
      <p className="cn-setup-sub">
        <b>{reading.configFile}</b>
        {reading.configFileExists ? ' · will be edited in place' : ' · will be created'}
      </p>

      <div className="cn-setup-body">
        <div className="cn-setup-ins">
          <label className="cn-setup-field">
            <span className="cn-setup-label">Your email</span>
            <input className="cn-setup-in" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="cn-setup-field">
            <span className="cn-setup-label">The project the fleet works on</span>
            <input className="cn-setup-in" value={repoRoot} onChange={(e) => setRepoRoot(e.target.value)} />
          </label>
        </div>
        <p className="cn-setup-note">
          Everything below is read off the repository you name — the provider, the target, your login on it, the
          integration branch and your team’s <code>lubbdubb.project.json</code> if they committed one. Nothing is
          written until you have seen the file. Your email is not stored: it resolves to your login, and <b>that</b> is
          what gets written, as <code>userId</code>.
        </p>
        {resolved?.repoRootIsSelf === true && (
          <p className="cn-setup-warnline">
            That is LubbDubb’s <b>own</b> checkout, not a project it works on. Supported — it is how LubbDubb works on
            itself — but it is also what this box starts at on any default start, so point it elsewhere if you meant a
            different project. The harness’s own build is watched separately, from the Build reading.
          </p>
        )}

        {resolved !== null && <Derived resolved={resolved} />}
        {preview !== null && <Preview preview={preview} />}
      </div>

      <div className="cn-setup-foot">
        <Button onClick={onClose}>Cancel</Button>
        <span className="cn-setup-hint">
          {preview === null
            ? 'Nothing is written until you have seen the file.'
            : 'Keys your team’s project file already sets are absent on purpose.'}
        </span>
        {preview === null ? (
          <Button tone="primary" disabled={busy || resolved === null} onClick={() => void review()}>
            {busy ? 'Preparing…' : 'Show me the file'}
          </Button>
        ) : (
          <Button tone="primary" disabled={busy} onClick={() => void write()}>
            {busy ? 'Writing…' : 'Write the file'}
          </Button>
        )}
      </div>
      {error !== null && <p className="cn-setup-err">{error}</p>}
    </div>
  );
}

/** What the two answers imply, and where each reading came from. */
function Derived({ resolved }: { resolved: SetupResolvePayload }): React.JSX.Element {
  return (
    <table className="cn-setup-tbl">
      <thead>
        <tr>
          <th>What</th>
          <th>Value</th>
          <th>From</th>
        </tr>
      </thead>
      <tbody>
        <Row
          what="Project"
          value={resolved.isRepo ? resolved.repoRoot : `${resolved.repoRoot} — not a git worktree`}
          from={resolved.originUrl ?? 'no origin remote'}
          bad={!resolved.isRepo}
        />
        <Row
          what="Provider"
          value={resolved.target === null ? 'could not be read' : resolved.target.provider}
          from={resolved.target === null ? 'the origin URL names no provider this harness speaks' : 'the origin remote'}
          bad={resolved.target === null}
        />
        <Row
          what="Target"
          value={resolved.target === null ? '—' : resolved.target.parts.join(' / ')}
          from="the same remote"
          bad={resolved.target === null}
        />
        <Row
          what="You"
          value={resolved.identity.userId ?? 'unresolved'}
          from={resolved.identity.why}
          bad={resolved.identity.confidence === 'unknown'}
        />
        <Row
          what="Credential"
          value={credentialValue(resolved.credential)}
          from="the environment, or the signed-in az CLI; never a config key"
          bad={resolved.credential.variable !== null && !resolved.credential.present}
        />
        <Row
          what="Integration branch"
          value={
            resolved.defaultBranch === null
              ? '—'
              : `${resolved.defaultBranch.name}${resolved.defaultBranch.commit ? ` at ${resolved.defaultBranch.commit.slice(0, 7)}` : ' — resolves to nothing'}`
          }
          from="the clone’s recorded remote head"
          bad={resolved.defaultBranch?.commit === null}
        />
        <Row
          what="Your team"
          value={
            resolved.project.file === null
              ? 'no project file in that repository'
              : `${resolved.project.keys.length} key(s)`
          }
          from={resolved.project.file ?? 'nothing to fold in'}
        />
        <Row
          what="Watch tag"
          value={resolved.watch.label}
          from={resolved.watch.fromProject ? 'your team’s prefix' : 'the default prefix'}
        />
        <Row what="Agents" value="stream, one at a time" from="a starting posture — raise it in Config" />
      </tbody>
    </table>
  );
}

/**
 * The credential row's words, which name the route rather than the variable.
 *
 * A signed-in `az` CLI is a whole way into Azure with no variable set anywhere, so
 * "AZURE_DEVOPS_PAT — present" would be a sentence the operator can check and find
 * false. → `docs/spec/26-setup.md#the-credential-check-asks-both-routes`
 */
function credentialValue(credential: SetupResolvePayload['credential']): string {
  if (credential.variable === null) return '—';
  if (credential.source === 'az-cli') return 'the az CLI is signed in';
  return `${credential.variable} — ${credential.source === 'env' ? 'present' : 'not set'}`;
}

/** The exact bytes, and when each key takes effect. */
function Preview({ preview }: { preview: { text: string; changes: readonly ConfigChange[] } }): React.JSX.Element {
  return (
    <>
      <pre className="cn-setup-pre">{preview.text}</pre>
      <table className="cn-setup-tbl">
        <thead>
          <tr>
            <th>Key</th>
            <th>Takes effect</th>
          </tr>
        </thead>
        <tbody>
          {preview.changes.map((change) => (
            <tr key={change.path}>
              <td className="cn-setup-val">{change.path}</td>
              <td>
                <span className={change.applied ? 'cn-tag cn-good' : 'cn-tag cn-warn'}>
                  {change.applied ? 'now' : 'at restart'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Row(props: { what: string; value: string; from: string; bad?: boolean }): React.JSX.Element {
  return (
    <tr>
      <td>{props.what}</td>
      <td className={props.bad === true ? 'cn-setup-val cn-bad' : 'cn-setup-val'}>{props.value}</td>
      <td className="cn-setup-from">{props.from}</td>
    </tr>
  );
}

function Done(props: { changes: readonly ConfigChange[]; onClose: () => void }): React.JSX.Element {
  const waiting = props.changes.filter((change) => !change.applied);
  return (
    <div className="cn-setup">
      <p className="cn-setup-note">
        Written. {props.changes.length} key(s) saved
        {waiting.length > 0 && `, ${waiting.length} of them waiting for a restart`}. Anything still outstanding is a row
        on Needs you.
      </p>
      <div className="cn-setup-foot">
        <span className="cn-setup-hint">Restart the harness to bring the rest in.</span>
        <Button tone="primary" onClick={props.onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}
