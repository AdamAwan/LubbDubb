import { join } from 'node:path';
import { validationGoalDir } from '../validation/resources.js';

/**
 * The strings that tie a local validation together: the two origins it dispatches
 * on, the lease key its checkout is taken under, and where its screenshots land.
 *
 * Pure, and shared by the rules that dispatch (`src/dispatcher/rules/localValidation.ts`,
 * `localValidationFix.ts`) and the tools that answer (`src/mcp/tools/localValidationReport.ts`
 * and the two beside it) — the two ends of one dispatch, and the pair most able to
 * drift, since one *writes* the origin string the other *parses*. `src/validation/fleet.ts`
 * is the same module one feature over.
 */

/**
 * `issue:<n>:validate-local:<validationId>` — one origin per validation, never one
 * per goal.
 *
 * Per row for `validateOrigin`'s reason exactly: the origin is what the cooldown and
 * the attempt cap are keyed on, so a shared `issue:<n>:validate-local` would let a
 * validation that can never be dispatched spend the budget of the next one the
 * operator asks for. And the operator *will* ask again — this is a button, not a
 * standing signal, so the budgets have to be per press.
 */
export function localValidationOrigin(issueNumber: number, id: string): string {
  return `issue:${issueNumber}:validate-local:${id}`;
}

/**
 * The goal and validation a local-validation origin names, or null for a ref that
 * is not one.
 *
 * **The fix origin is not one of them**, and that is structural rather than tidy:
 * `local_validation_report` resolves which row it is reporting on through this
 * function, so an agent dispatched to *fix* a failed validation cannot record a
 * reading saying the validation actually passed. It is `validationReportTarget`'s
 * arrangement against `validation-failed`, argument for argument — refused by the
 * parse rather than by a sentence in a prompt.
 */
export function localValidationOriginParts(originRef: string | null): { issueNumber: number; id: string } | null {
  const match = /^issue:(\d+):validate-local:([A-Za-z0-9-]+)$/.exec(originRef ?? '');
  if (!match) return null;
  return { issueNumber: Number(match[1]), id: match[2] as string };
}

/**
 * `issue:<n>:validate-local-fix:<validationId>` — the agent sent to fix what a
 * validation found.
 *
 * Its own word in the origin, and its own budget: a validation that took two goes to
 * dispatch must not leave its fix with none, and a fix that cannot settle must not
 * eat the attempts of the next validation. `validation-failed`'s split against
 * `validate-check`, for its reasons.
 */
export function localValidationFixOrigin(issueNumber: number, id: string): string {
  return `issue:${issueNumber}:validate-local-fix:${id}`;
}

/** The goal and validation a fix origin names, or null. */
export function localValidationFixOriginParts(originRef: string | null): { issueNumber: number; id: string } | null {
  const match = /^issue:(\d+):validate-local-fix:([A-Za-z0-9-]+)$/.exec(originRef ?? '');
  if (!match) return null;
  return { issueNumber: Number(match[1]), id: match[2] as string };
}

/**
 * `validate-local/issue/<n>/<validationId>` — a **lease key**, never a ref.
 *
 * The validator reads a checkout and writes nothing to it, so it takes a read-only
 * slot and no branch is minted ([09](../../docs/spec/09-execution.md#the-read-only-checkout)):
 * a ref cut here would outlive every validation ever run, since `reapableBranches`
 * only ever deletes the branch of a merged pull request. Its own namespace for
 * `validate/issue/<n>/<checkId>`'s hard reason — git stores refs as files, so
 * nothing bare is ever cut — and the id is on the key so two validations of one goal
 * could never share a directory.
 */
export function localValidationKey(issueNumber: number, id: string): string {
  return `validate-local/issue/${issueNumber}/${id}`;
}

/**
 * Where this validation's screenshots land: a directory of its own under the goal's
 * validation directory.
 *
 * Under `validationRoot` rather than beside the checkout, for the reason that root
 * exists at all ([20](../../docs/spec/20-validation.md#resources)): it is outside
 * every worktree, so the files survive the reap that removes the agent that took
 * them and can never be committed onto a branch. Per validation rather than per
 * goal, so a second run of the same goal does not draw the first one's pictures.
 */
export function localValidationOutputDir(root: string, originRef: string, id: string): string {
  return join(validationGoalDir(root, originRef), 'local', id);
}

/**
 * Where the browser keeps its profile — one directory for the deployment, not one
 * per validation.
 *
 * One, because a profile is what makes a login survive: an operator who signs the
 * browser in once should not be asked again by the next validation, and a persistent
 * profile is the only thing Playwright offers that outlives a server process. One is
 * also all that is safe — a persistent profile may only be used by one browser at a
 * time — and one is all that is ever needed, because there is one dev environment
 * and therefore one validation running at a time.
 *
 * Under `validationRoot` beside the goals rather than inside one: it belongs to the
 * machine, not to any goal, and a leading dot keeps it out of the way of the
 * `issue-<n>` directories.
 */
export function localValidationProfileDir(root: string): string {
  return join(root, '.browser-profile');
}
