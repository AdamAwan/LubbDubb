import { useEffect, useState } from 'react';
import { api } from '../api.js';
import type { CiPolicyDescription, CiRuleDescription, PolicyKindDescription } from '../types.js';

/**
 * What the harness does about a red pull request, check by check.
 *
 * `ci.checks` was only ever readable by opening `lubbdubb.config.json` on the
 * host — and even then the file does not say what it means: a rule that omits
 * `onFailure` **ignores** the check, and a check no rule claims **dispatches**.
 * A mis-scoped glob was therefore invisible until a PR behaved oddly (#244).
 *
 * **Every effective value is computed on the server** (`describeCiPolicy`), not
 * here. The cockpit re-deriving `onFailure ?? 'ignore'` would be a second copy of
 * a default `classifyCiFailures` owns, free to drift with nothing to catch it —
 * so this component renders the payload and asserts nothing of its own about it.
 *
 * **Read-only**, for the running config's reason: there is no config-write path
 * in the harness, and a route whose honest answer to "when does this take effect"
 * is "at the next restart" is worse than not offering one. Editing stays an edit
 * to `lubbdubb.config.json` and a restart.
 */
export function CiPolicyTab() {
  const [policy, setPolicy] = useState<CiPolicyDescription | null>(null);

  useEffect(() => {
    let live = true;
    void api.getCiPolicy().then((p) => {
      if (live) setPolicy(p.policy);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!policy) return <div className="muted">Loading…</div>;

  return (
    <>
      <p className="muted settings-hint">
        What the harness does about <em>which</em> check, and in <em>which state</em>. Ordered — the first rule whose
        glob matches the check <em>and</em> whose states include the state it is in wins. Read-only: edit{' '}
        <code>ci.checks</code> in <code>lubbdubb.config.json</code> and restart to change one.
      </p>

      {policy.rules.length === 0 ? (
        <p className="empty">
          No <code>ci.checks</code> rules are configured, so every failing check takes the unmatched routing below — the
          harness dispatches a code agent at each one.
        </p>
      ) : (
        <table className="settings-table ci-rules">
          <thead>
            <tr>
              <th>#</th>
              <th>Check name matches</th>
              <th>In state</th>
              {/* Still labelled by the config key, `onFailure`, rather than by what it
                  now means ("on match"): the column an operator is looking for is the
                  one named after the field they type. */}
              <th>On failure</th>
            </tr>
          </thead>
          <tbody>
            {policy.rules.map((rule, i) => (
              <CiRuleRow key={`${i}-${rule.match}`} index={i} rule={rule} />
            ))}
          </tbody>
        </table>
      )}

      <p className="muted ci-unmatched">
        A failing check that matches <strong>no rule above</strong>: <ActionChip action={policy.unmatched} />. That is
        deliberate — a CI job added next week is fixed by the harness rather than silently parking every red PR forever.
        A check in any <em>other</em> state that matches no rule does nothing at all: watching one is opt-in, per rule,
        through <code>states</code>.
      </p>

      {policy.policyKinds && (
        <div className="settings-section">
          <span className="pm-section-label">Branch policies surfaced as checks</span>
          <p className="muted settings-hint">
            Azure DevOps branch-policy evaluations reach <code>ci.checks</code> only in the modes below.{' '}
            <code>check</code> is an ordinary check a rule can claim; <code>advisory</code> is visible but can never
            dispatch or escalate; <code>off</code> is not emitted at all. Set them under{' '}
            <code>azureDevOps.policyChecks</code>.
          </p>
          <table className="settings-table">
            <tbody>
              {policy.policyKinds.map((kind) => (
                <PolicyKindRow key={kind.kind} kind={kind} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function CiRuleRow({ index, rule }: { index: number; rule: CiRuleDescription }) {
  return (
    <tr>
      <td className="ci-order">{index + 1}</td>
      <td className="settings-value">
        <code>{rule.match}</code>
      </td>
      <td className="settings-value">
        {rule.states.map((state) => (
          <span key={state} className={`chip small ${state === 'pending' ? 'warn' : ''}`}>
            {state}
          </span>
        ))}
        {/* The same reason `inherited` is shipped: a rule that names no states
            watches failing alone, and one that names `pending` has *stopped*
            claiming the check when it goes red — neither is legible from the file. */}
        {rule.statesInherited ? (
          <span className="muted"> — inherited; the rule sets no states</span>
        ) : (
          !rule.states.includes('failing') && (
            <span className="muted"> — a failure of this check falls through to a later rule</span>
          )
        )}
      </td>
      <td className="settings-value">
        <ActionChip action={rule.onFailure} />
        {/* The whole reason the server ships `inherited`: an operator reading the
            file sees no `onFailure` and has no way to know the omission means
            "leave it alone" rather than "fall through to the default dispatch". */}
        {rule.inherited && <span className="muted"> — inherited; the rule sets no onFailure</span>}
        {rule.urgent && <span className="chip warn ci-urgent">urgent</span>}
        {rule.guidance !== null && <p className="muted ci-guidance">{rule.guidance}</p>}
      </td>
    </tr>
  );
}

function PolicyKindRow({ kind }: { kind: PolicyKindDescription }) {
  return (
    <tr className={kind.isDefault ? '' : 'chosen'}>
      <td className="settings-key">{kind.kind}</td>
      <td className="settings-value">
        {kind.mode}
        {kind.isDefault && <span className="muted"> — default</span>}
      </td>
    </tr>
  );
}

/** One of the three routings, coloured by how much of a hold it puts on the PR. */
function ActionChip({ action }: { action: CiRuleDescription['onFailure'] }) {
  const tone = action === 'dispatch' ? 'ok' : action === 'escalate' ? 'warn' : '';
  return <span className={`chip small ${tone}`}>{action}</span>;
}
