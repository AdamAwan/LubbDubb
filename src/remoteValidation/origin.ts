import { join } from 'node:path';
import { issueOriginId, issueOriginRef } from '../issueOrigins.js';
import { validationGoalDir } from '../validation/resources.js';

// → docs/spec/36-remote-validation.md#the-dispatch--rule-remote-validation

export function remoteValidationOrigin(issueNumber: number, runId: string): string {
  return issueOriginRef('remoteValidation', issueNumber, runId);
}

/**
 * **The narrow kind of fence.** It parses `:validate-remote:` alone, so which run a report concerns
 * is settled *before* the report rather than by it: every other caller — the part agent and the
 * whole-issue agent most of all — is refused **by name**, and the `validation-failed` agent this run
 * may go on to produce is refused structurally, by this parse, exactly as it is refused
 * `validation_report`.
 */
export function remoteValidationOriginParts(originRef: string | null): { issueNumber: number; runId: string } | null {
  const parts = issueOriginId('remoteValidation', originRef);
  return parts === null ? null : { issueNumber: parts.issueNumber, runId: parts.id };
}

/** The lease key the read-only checkout is taken under. It is a key, and no ref is minted for it. */
export function remoteValidationKey(issueNumber: number, runId: string): string {
  return `validate-remote/issue/${issueNumber}/${runId}`;
}

/** Where the runner writes its machine-readable report — the run's own directory, and nowhere else. */
export function remoteValidationRunDir(root: string, originRef: string, runId: string): string {
  return join(validationGoalDir(root, originRef), 'remote', runId);
}

/**
 * The persistent browser profile a run's agent drives, one per environment and never one per run: a
 * sign-in somebody completed once — an identity provider, an MFA prompt, a consent screen — is one
 * every later run against that environment inherits.
 *
 * It is **not** the local validation's profile, and that is the load-bearing half. A persistent
 * profile may be held by one browser at a time, so a remote run sharing the local one would refuse to
 * start whenever a local validation was up; and the account that reaches an acceptance deployment is
 * not the one that reaches somebody's dev machine, so the two would fight over the same cookies
 * besides. → docs/spec/36-remote-validation.md#the-browser-the-run-drives
 */
export function remoteValidationProfileDir(root: string, environment: string): string {
  return join(root, '.browser-profile-remote', environment.replace(/[^A-Za-z0-9._-]+/g, '-'));
}
