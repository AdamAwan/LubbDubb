import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { ConfigChange, SetupPayload, SetupResolvePayload } from '../types.js';
import { Button } from './button.js';
import { Tag } from './tag.js';

// → docs/spec/17-cockpit.md

function resolveAfterPause(
  query: { email: string; repoRoot: string },
  onError: (message: string | null) => void,
  onResolved: (next: SetupResolvePayload) => void,
): () => void {
  const timer = setTimeout(() => {
    onError(null);
    void api
      .resolveSetup(query)
      .then(onResolved)
      .catch((err: Error) => onError(err.message));
  }, 400);
  return () => clearTimeout(timer);
}

export function SetupPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [reading, setReading] = useState<SetupPayload | null>(null);
  const [email, setEmail] = useState('');
  const [repoRoot, setRepoRoot] = useState('');
  const [resolved, setResolved] = useState<SetupResolvePayload | null>(null);
  const [preview, setPreview] = useState<{ text: string; changes: readonly ConfigChange[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<readonly ConfigChange[] | null>(null);

  useEffect(() => {
    void api.getSetup().then((next) => {
      setReading(next);
      setEmail(next.prefill.email ?? '');
      setRepoRoot(next.prefill.repoRoot);
    });
  }, []);

  useEffect(() => {
    if (reading === null || repoRoot.trim() === '') return;
    return resolveAfterPause({ email, repoRoot }, setError, (next) => {
      setResolved(next);
      setPreview(null);
    });
  }, [email, repoRoot, reading]);

  if (reading === null) return <div className="cn-empty">Reading the configuration…</div>;

  const withConfig = async (
    step: (edits: { set: SetupResolvePayload['writes']; baseline: string }) => Promise<void>,
  ): Promise<void> => {
    if (resolved === null) return;
    setBusy(true);
    setError(null);
    try {
      const config = await api.getConfig();
      await step({ set: resolved.writes, baseline: config.revision });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const review = (): Promise<void> =>
    withConfig(async (edits) => {
      const next = await api.previewConfig(edits);
      setPreview({ text: next.text, changes: next.changes });
    });

  const write = (): Promise<void> =>
    withConfig(async (edits) => {
      const result = await api.saveConfig(edits);
      setSaved(result.changes);
    });

  if (saved !== null) return <Done changes={saved} onClose={onClose} />;

  return (
    <div className="cn-setup">
      <p className="cn-setup-sub">
        <b>{reading.configFile}</b>
        {reading.configFileExists ? ' · will be edited in place' : ' · will be created'}
      </p>

      <div className="cn-setup-body">
        <SetupFields email={email} onEmail={setEmail} repoRoot={repoRoot} onRepoRoot={setRepoRoot} />
        <SetupNote isSelf={resolved?.repoRootIsSelf === true} />

        {resolved !== null && <Derived resolved={resolved} />}
        {preview !== null && <Preview preview={preview} />}
      </div>

      <SetupFoot
        previewed={preview !== null}
        busy={busy}
        canReview={resolved !== null}
        onClose={onClose}
        onReview={() => void review()}
        onWrite={() => void write()}
      />
      {error !== null && <p className="cn-setup-err">{error}</p>}
    </div>
  );
}

function SetupFields(props: {
  email: string;
  onEmail: (email: string) => void;
  repoRoot: string;
  onRepoRoot: (repoRoot: string) => void;
}): React.JSX.Element {
  const { email, onEmail, repoRoot, onRepoRoot } = props;
  return (
    <div className="cn-setup-ins">
      <label className="cn-setup-field">
        <span className="cn-setup-label">Your email</span>
        <input className="cn-setup-in" value={email} onChange={(e) => onEmail(e.target.value)} />
      </label>
      <label className="cn-setup-field">
        <span className="cn-setup-label">The project the fleet works on</span>
        <input className="cn-setup-in" value={repoRoot} onChange={(e) => onRepoRoot(e.target.value)} />
      </label>
    </div>
  );
}

function SetupNote({ isSelf }: { isSelf: boolean }): React.JSX.Element {
  return (
    <>
      <p className="cn-setup-note">
        Everything below is read off the repository you name — the provider, the target, your login on it, the
        integration branch and your team’s <code>lubbdubb.project.json</code> if they committed one. Nothing is written
        until you have seen the file. Your email is not stored: it resolves to your login, and <b>that</b> is what gets
        written, as <code>userId</code>.
      </p>
      {isSelf && (
        <p className="cn-setup-warnline">
          That is LubbDubb’s <b>own</b> checkout, not a project it works on. Supported — it is how LubbDubb works on
          itself — but it is also what this box starts at on any default start, so point it elsewhere if you meant a
          different project. The harness’s own build is watched separately, from the Build reading.
        </p>
      )}
    </>
  );
}

function SetupFoot(props: {
  previewed: boolean;
  busy: boolean;
  canReview: boolean;
  onClose: () => void;
  onReview: () => void;
  onWrite: () => void;
}): React.JSX.Element {
  const { previewed, busy, canReview, onClose, onReview, onWrite } = props;
  return (
    <div className="cn-setup-foot">
      <Button onClick={onClose}>Cancel</Button>
      <span className="cn-setup-hint">
        {!previewed
          ? 'Nothing is written until you have seen the file.'
          : 'Keys your team’s project file already sets are absent on purpose.'}
      </span>
      {!previewed ? (
        <Button tone="primary" disabled={busy || !canReview} onClick={onReview}>
          {busy ? 'Preparing…' : 'Show me the file'}
        </Button>
      ) : (
        <Button tone="primary" disabled={busy} onClick={onWrite}>
          {busy ? 'Writing…' : 'Write the file'}
        </Button>
      )}
    </div>
  );
}

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

function credentialValue(credential: SetupResolvePayload['credential']): string {
  if (credential.variable === null) return '—';
  if (credential.source === 'az-cli') return 'the az CLI is signed in';
  return `${credential.variable} — ${credential.source === 'env' ? 'present' : 'not set'}`;
}

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
                <Tag tone={change.applied ? 'green' : 'amber'} fill>
                  {change.applied ? 'now' : 'at restart'}
                </Tag>
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
