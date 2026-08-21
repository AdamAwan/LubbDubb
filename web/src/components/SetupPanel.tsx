import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { ConfigChange, SetupCheck, SetupPayload, SetupResolvePayload, SetupVerdict } from '../types.js';

/**
 * The first-run surface: two questions, what they imply, and the file they write.
 *
 * **It is an offer, never a gate.** The harness boots and runs with no config at
 * all — a mock agent against a mock tracker — and that is a supported posture, so
 * nothing here stands in front of a cockpit that is already working. Every step
 * closes, and the reading in the top bar is what persists.
 *
 * **It writes through `POST /api/config`.** There is no second store and no second
 * writer: what the two answers produce is a set of config keys, handed to the same
 * preview-then-save the config page uses, so the surgical splice that keeps an
 * operator's comments and key order intact is the one that runs here too.
 *
 * The three screens are `useState` rather than `Place` — deliberately, and against
 * the usual rule. A step inside an unsaved edit is not somewhere to send a link:
 * restoring "review" on a reload would restore a review of answers the reload has
 * already dropped. Which is *also* why the panel itself is on `Place`, so the
 * surface is linkable even though its steps are not.
 *
 * → `docs/spec/26-setup.md`
 */
type Step = 'ask' | 'derived' | 'review';

const VERDICT_CHIP: Record<SetupVerdict, string> = {
  ok: 'cn-tag cn-good',
  warn: 'cn-tag cn-warn',
  bad: 'cn-tag cn-bad',
  unknown: 'cn-tag',
};

export function SetupPanel({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [reading, setReading] = useState<SetupPayload | null>(null);
  const [step, setStep] = useState<Step>('ask');
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

  if (reading === null) return <div className="cn-empty">Reading the configuration…</div>;

  const resolve = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.resolveSetup({ email, repoRoot });
      setResolved(next);
      setStep('derived');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const review = async (): Promise<void> => {
    if (resolved === null) return;
    setBusy(true);
    setError(null);
    try {
      // The bytes come from the server's own splice rather than being built here:
      // a second one in the browser would be free to disagree with the one that
      // writes, and the diff is the whole point of the step.
      const config = await api.getConfig();
      const next = await api.previewConfig({ set: resolved.writes, baseline: config.revision });
      setPreview({ text: next.text, changes: next.changes });
      setStep('review');
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
      setReading(await api.getSetup());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="cn-setup">
      {saved !== null ? (
        <Done changes={saved} reading={reading} onClose={onClose} />
      ) : (
        <>
          {step === 'ask' && (
            <Ask
              reading={reading}
              email={email}
              repoRoot={repoRoot}
              busy={busy}
              onEmail={setEmail}
              onRepoRoot={setRepoRoot}
              onNext={() => void resolve()}
            />
          )}
          {step === 'derived' && resolved !== null && (
            <Derived
              resolved={resolved}
              checks={reading.checks}
              busy={busy}
              onBack={() => setStep('ask')}
              onNext={() => void review()}
            />
          )}
          {step === 'review' && resolved !== null && preview !== null && (
            <Review
              preview={preview}
              file={reading.configFile}
              exists={reading.configFileExists}
              busy={busy}
              onBack={() => setStep('derived')}
              onWrite={() => void write()}
            />
          )}
        </>
      )}
      {error !== null && <p className="cn-setup-err">{error}</p>}
    </div>
  );
}

function Ask(props: {
  reading: SetupPayload;
  email: string;
  repoRoot: string;
  busy: boolean;
  onEmail: (value: string) => void;
  onRepoRoot: (value: string) => void;
  onNext: () => void;
}): React.JSX.Element {
  const { reading, email, repoRoot, busy } = props;
  return (
    <>
      <p className="cn-setup-sub">
        <b>{reading.configFile}</b>
        {reading.configFileExists ? ' · read at boot' : ' · does not exist yet'}
      </p>
      <p className="cn-setup-note">
        Two questions. Everything else — the provider, the target repository, your login on it, the integration branch,
        and your team’s shared <code>lubbdubb.project.json</code> if they committed one — is read off the repository you
        name. Nothing is written until you have seen the file.
      </p>
      <div className="cn-setup-body">
        <label className="cn-setup-field">
          <span className="cn-setup-label">Your email</span>
          <input className="cn-setup-in" value={email} onChange={(e) => props.onEmail(e.target.value)} />
          <span className="cn-setup-why">
            Prefilled from <code>git config user.email</code>. It is not stored: it resolves to your login on whichever
            provider the repository uses, and <b>that</b> is what gets written, as <code>userId</code>.
          </span>
        </label>
        <label className="cn-setup-field">
          <span className="cn-setup-label">Project location</span>
          <input className="cn-setup-in" value={repoRoot} onChange={(e) => props.onRepoRoot(e.target.value)} />
          <span className="cn-setup-why">
            The repository the fleet works on — worktrees are cut from it, and <code>.lubbdubb/</code> lives inside it.
            It starts at the directory the harness was launched from, which is the harness’s own checkout on a default
            start.
          </span>
        </label>
      </div>
      <div className="cn-setup-foot">
        <span className="cn-setup-hint">Nothing here is required — the harness is already running.</span>
        <button className="cn-btn cn-primary" disabled={busy || repoRoot.trim() === ''} onClick={props.onNext}>
          {busy ? 'Reading…' : 'Continue'}
        </button>
      </div>
    </>
  );
}

function Derived(props: {
  resolved: SetupResolvePayload;
  checks: readonly SetupCheck[];
  busy: boolean;
  onBack: () => void;
  onNext: () => void;
}): React.JSX.Element {
  const { resolved, checks, busy } = props;
  const outstanding = checks.filter((check) => check.verdict !== 'ok');
  return (
    <>
      <p className="cn-setup-note">
        All of this came off the repository you named. Change anything you disagree with in Config afterwards — the
        useful part of this screen is what it could not resolve, and the checks below it.
      </p>
      <div className="cn-setup-body">
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
              what="Repository"
              value={resolved.isRepo ? resolved.repoRoot : `${resolved.repoRoot} — not a git worktree`}
              from={resolved.originUrl ?? 'no origin remote'}
              bad={!resolved.isRepo}
            />
            <Row
              what="Provider"
              value={resolved.target === null ? 'could not be read' : resolved.target.provider}
              from={
                resolved.target === null ? 'the origin URL names no provider this harness speaks' : 'the origin remote'
              }
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
              value={
                resolved.credential.variable === null
                  ? '—'
                  : `${resolved.credential.variable} — ${resolved.credential.present ? 'present' : 'not set'}`
              }
              from="the environment; never a config key"
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
            <Row what="Agents" value="stream, one at a time" from="Setup’s starting posture — raise it in Config" />
          </tbody>
        </table>

        {outstanding.length > 0 && (
          <div className="cn-setup-checks">
            <h4>What would stop it silently</h4>
            {outstanding.map((check) => (
              <div key={check.id} className={`cn-setup-check cn-${check.verdict}`}>
                <span className={VERDICT_CHIP[check.verdict]}>{check.label}</span>
                <span>
                  {check.detail}
                  {check.remedy !== undefined && <i className="cn-setup-remedy"> {check.remedy}</i>}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="cn-setup-foot">
        <button className="cn-btn" onClick={props.onBack}>
          Back
        </button>
        <span className="cn-setup-hint">
          None of these blocks you. Each stays on the Setup reading until it clears.
        </span>
        <button className="cn-btn cn-primary" disabled={busy} onClick={props.onNext}>
          {busy ? 'Preparing…' : 'Review the file'}
        </button>
      </div>
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

function Review(props: {
  preview: { text: string; changes: readonly ConfigChange[] };
  file: string;
  exists: boolean;
  busy: boolean;
  onBack: () => void;
  onWrite: () => void;
}): React.JSX.Element {
  const { preview, busy } = props;
  return (
    <>
      <p className="cn-setup-sub">
        <b>{props.file}</b>
        {props.exists ? ' · will be edited in place' : ' · will be created'}
      </p>
      <p className="cn-setup-note">
        These are the exact bytes. Keys your team’s project file already sets are absent on purpose — copying one here
        would freeze it at today’s value, and the next commit that changed it would not reach you.
      </p>
      <div className="cn-setup-body">
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
      </div>
      <div className="cn-setup-foot">
        <button className="cn-btn" onClick={props.onBack}>
          Back
        </button>
        <span className="cn-setup-hint">A restart brings the rest in.</span>
        <button className="cn-btn cn-primary" disabled={busy} onClick={props.onWrite}>
          {busy ? 'Writing…' : 'Write the file'}
        </button>
      </div>
    </>
  );
}

function Done(props: {
  changes: readonly ConfigChange[];
  reading: SetupPayload;
  onClose: () => void;
}): React.JSX.Element {
  const waiting = props.changes.filter((change) => !change.applied);
  return (
    <>
      <p className="cn-setup-note">
        Written. {props.changes.length} key(s) saved
        {waiting.length > 0 && `, ${waiting.length} of them waiting for a restart`}.
        {props.reading.outstanding > 0 && ' The Setup reading stays in the bar while anything is outstanding.'}
      </p>
      <div className="cn-setup-body">
        {props.reading.checks.map((check) => (
          <div key={check.id} className={`cn-setup-check cn-${check.verdict}`}>
            <span className={VERDICT_CHIP[check.verdict]}>{check.label}</span>
            <span>
              {check.detail}
              {check.remedy !== undefined && check.verdict !== 'ok' && (
                <i className="cn-setup-remedy"> {check.remedy}</i>
              )}
            </span>
          </div>
        ))}
      </div>
      <div className="cn-setup-foot">
        <span className="cn-setup-hint">Restart the harness to bring the rest in.</span>
        <button className="cn-btn cn-primary" onClick={props.onClose}>
          Done
        </button>
      </div>
    </>
  );
}
