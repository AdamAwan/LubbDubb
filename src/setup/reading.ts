import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '../config.js';
import type { ConfigChange } from '../configApply.js';
import type { PromptTemplates } from '../dispatcher/promptTemplates.js';
import { RETIRED_TOOL_NAMES } from '../mcp/names.js';
import type { Store } from '../store/store.js';
import { isWatched, watchLabelFor } from '../watchLabels.js';
import { credentialVar } from './remote.js';
import type { SetupProbes } from './probes.js';

/**
 * A check's answer, and deliberately four-valued.
 *
 * `unknown` is not a shade of `bad`, and a reader must not fold it into one: a
 * credential that could not be asked and a credential that answered "no" are
 * different news, and only the second is about the operator's configuration. The
 * three-valued reach verdict in `src/environments/` is the same discipline, for
 * the same reason — a surface that states the wrong one of these says something
 * untrue in the operator's own words.
 */
export type SetupVerdict = 'ok' | 'warn' | 'bad' | 'unknown';

/**
 * The one-click version of a `remedy`, and the reason a check carries a value
 * rather than a sentence about a value.
 *
 * A remedy that is only prose is a remedy the operator retypes somewhere else,
 * and every one of these checks names something that is already silent — so the
 * gap between reading the sentence and acting on it is where the whole surface
 * used to be lost. Three kinds, and which one a check gets is the whole of what
 * the harness is honestly able to do about it:
 *
 * - `config` — the fix *is* config leaves, so the harness applies them itself
 *   through `POST /api/config`. The same single writer the config page uses: a
 *   second one here would be a second opinion about what a save means.
 * - `goto` — the fix is a decision only a person makes (which ticket to tag), so
 *   this lands them on the surface that already exists.
 * - `shell` — the fix is outside the harness entirely, and is **copied, never
 *   run**. These are exactly the credential and billing checks; a button that
 *   executed a shell string on the operator's behalf would put arbitrary
 *   execution behind the most sensitive reading the cockpit draws.
 *
 * → `docs/spec/26-setup.md#the-fixes`
 */
export type SetupFix =
  | {
      kind: 'config';
      /** The button's words, naming the value it would write. */
      label: string;
      /**
       * Config **leaf** paths to their values, exactly as the config page's own
       * save takes them. Never a nested object: `POST /api/config` validates every
       * key against `CONFIG_FIELDS`, which holds leaves only, so an `integrations`
       * here is refused with the operator's fix sitting one field away from
       * working. `test/setupWrites.test.ts` holds every key here against that
       * registry.
       */
      set: Record<string, unknown>;
      /**
       * Whether the value is a fact or a guess, which decides the control the
       * cockpit draws: a `confirmed` value gets a one-click button, an `assumed`
       * one gets the value in an editable field first. A check whose value could
       * not be resolved at all offers no `config` fix — it degrades to `goto`.
       */
      confidence: 'confirmed' | 'assumed';
      /** The key to open on the config page when the operator would rather look first. */
      group: string;
    }
  /**
   * Open the surface where the decision is made.
   *
   * `prompts` is the config page's Prompts tab rather than a destination of its
   * own: a fix that landed an operator on the values page to answer a question
   * about a prompt override would be the failure this whole surface was rebuilt
   * around — a row that opens the wrong screen is worse than no row.
   */
  | { kind: 'goto'; label: string; to: 'config' | 'tickets' | 'prompts'; group?: string }
  /**
   * Open the confirm sheet — a repository, everything it implies, and the diff.
   *
   * Its own kind rather than a `config` fix with several keys, because what a
   * repository implies is a table and a file, not a value on a button. It is also
   * the only fix whose *input* can be wrong in a way the harness cannot see:
   * `repoRoot` defaults to `process.cwd()`, so on a default start it proposes the
   * harness's own checkout. → `docs/spec/26-setup.md#two-repositories`
   */
  | { kind: 'sheet'; label: string }
  | {
      kind: 'shell';
      label: string;
      /** Copied to the clipboard. Never executed — see above. */
      command: string;
      /** Why the harness cannot do this one itself, in the operator's terms. */
      why: string;
    };

export interface SetupCheck {
  id: string;
  label: string;
  verdict: SetupVerdict;
  /** What was actually observed, in a sentence. Never a restatement of the label. */
  detail: string;
  /** What to do about it, when there is something to do. */
  remedy?: string;
  /** The one-click version, when the harness has one to offer. */
  fix?: SetupFix;
}

export interface SetupReading {
  configFile: string;
  configFileExists: boolean;
  /** What the two questions open with, so nobody types what the machine knows. */
  prefill: {
    email: string | null;
    repoRoot: string;
    /**
     * Whether {@link prefill.repoRoot} is LubbDubb's **own** checkout rather than a
     * project it works on. True is the default-start case and not an error — it is
     * how LubbDubb works on itself — but it is the one case where the proposed
     * value is the harness's own directory, so nothing about it may be stated
     * confidently. → `docs/spec/26-setup.md#two-repositories`
     */
    repoRootIsSelf: boolean;
  };
  checks: readonly SetupCheck[];
}

/**
 * What the harness can say about its own configuration, without being asked
 * anything.
 *
 * **None of this is a gate.** The harness boots and runs on no config at all —
 * a mock agent against a mock tracker — and that is a supported way to use it,
 * not a broken state to stand in front of. So this is a reading, and the cockpit
 * decides how loudly to draw it.
 *
 * The checks outlive the first three minutes on purpose, which is the argument
 * for their being checks rather than wizard steps: `credential` is how an
 * operator finds out on a Tuesday that a token expired, and `eligibility` is how
 * they find out that a filter of their own is hiding every tagged item.
 *
 * **A check earns a row when it names a discrepancy, never a quantity.** "You have
 * no work queued" is a quantity — it is the resting state of a fleet that has
 * cleared its backlog, and a standing row for it is a permanent scold for doing
 * nothing wrong. "There is work and your config hides all of it" is a
 * discrepancy, and it is always a fault. That line is why `watch` is two checks
 * here rather than one. → `docs/spec/26-setup.md#the-checks`
 */
export async function buildSetupReading(deps: {
  config: Config;
  store: Store;
  probes: SetupProbes;
  configFile: string;
  /**
   * What has reached the file and is waiting for a restart —
   * `LiveConfig.pending()`, the same list the config page's own card draws.
   *
   * Required rather than defaulted to `[]`, because the default is the bug: a
   * caller that forgot it would produce a reading that goes on asking for work
   * the operator has already done, which is exactly what this argument exists to
   * end. → {@link awaitingRestart}
   */
  pending: readonly ConfigChange[];
  /**
   * The resolved template book — `system.prompts`, the same one the dispatcher
   * renders from.
   *
   * Required rather than defaulted, for `pending`'s reason exactly: the default
   * would be "no overrides", which is the one answer that draws no row at all —
   * so a caller that forgot it would produce a reading that silently says a
   * deployment names no withdrawn tool when it names four.
   */
  prompts: PromptTemplates;
}): Promise<SetupReading> {
  const { config, store, probes, configFile, pending, prompts } = deps;
  const configFileExists = existsSync(configFile);
  const onMock = config.integrations.issues === 'fake' && config.integrations.sourceControl === 'fake';
  const install = probes.installRoot();

  // Read against the running config, then restated where the file has already
  // answered — never suppressed. A fault a restart would clear is still a fault
  // *now*: the fleet really is inventing its backlog until the process comes back.
  const checks: SetupCheck[] = [];
  const restated = new Set<string>();
  for (const check of [
    pointedCheck(config, onMock, configFileExists, install),
    await credentialCheck(config, probes),
    await identityCheck(config, probes),
    ...watchChecks(config, store),
    await agentCheck(config, probes),
    billingCheck(probes),
    ...retiredToolChecks(prompts),
  ]) {
    const waiting = awaitingRestart(check, pending);
    checks.push(waiting ?? check);
    if (waiting !== null) for (const path of SETTLED_BY[check.id] ?? []) restated.add(path);
  }
  // Whatever no check above said in its own words. Computed from what was
  // actually restated rather than from {@link SETTLED_BY}, so a pending change to
  // a key whose check is currently `ok` — `userId` edited from one login to
  // another — is named here instead of falling between the two.
  const unnamed = pending.filter((change) => !restated.has(change.path));
  if (unnamed.length > 0) checks.push(restartCheck(unnamed));

  return {
    configFile,
    configFileExists,
    prefill: {
      email: await probes.gitEmail(config.repoRoot),
      repoRoot: config.repoRoot,
      repoRootIsSelf: install !== null && resolve(install) === resolve(config.repoRoot),
    },
    checks,
  };
}

/**
 * Which config leaves would settle each check, so a fault the operator has
 * already answered can be told from one they have not.
 *
 * **The keys a check itself reads, and nothing that merely rides along with
 * them.** The confirm sheet writes `repoRoot`, `defaultBranch` and the provider
 * target in the same save as `integrations`, and it is tempting to hang all of
 * them off `pointed` — but then a pending `defaultBranch` alone would have
 * `pointed` announce that the file has already answered it, which is a sentence
 * about a key the check never looked at. Those land in {@link restartCheck}
 * instead, which claims nothing about what they fix.
 *
 * Keyed by check id and deliberately partial. `credential` and `billing` are not
 * here and must not be: both read the *environment*, which no edit to
 * `lubbdubb.config.json` can put into a running process — a row claiming to
 * settle one would be the reading telling an operator their expired token is
 * fixed. `wiring` is absent for the same shape of reason: it is settled by
 * tagging a ticket, not by a key.
 *
 * A path that names no configurable leaf simply never matches, since `pending`
 * only ever carries `CONFIG_FIELDS` paths (`src/configApply.ts`).
 */
const SETTLED_BY: Readonly<Record<string, readonly string[]>> = {
  pointed: ['integrations.issues', 'integrations.sourceControl'],
  identity: ['userId'],
  eligibility: ['ownWorkOnly'],
  watch: ['labelPrefix'],
  agent: ['agentMode', 'claudeCommand'],
};

/**
 * The same fault, restated for an operator who has already fixed it in the file.
 *
 * This is the gap the whole argument exists to close. `integrations` and `userId`
 * have no arm in `src/configApply.ts`, so editing them lands in the file and
 * leaves the running config exactly as it was (→ `docs/spec/02-configuration.md#liveness`) — and the reading
 * is built
 * from the running config, so it went on saying "point it at a project" to
 * somebody looking at a file that already did. Both surfaces were telling the
 * truth and the operator had no way to see it: the config page's pending card is
 * the only thing that said a restart was owed, and it is a page you have to
 * already suspect something to open.
 *
 * **The verdict is kept, never softened.** A `bad` that a restart would clear is
 * still `bad` now — the fleet is on the fake provider until the process comes
 * back, inventing a backlog that reads exactly like a real one. What changes is
 * the words and the offer: `goto` config, where the pending card and its
 * `Apply and restart` button already live, rather than a fix that would write a
 * value the file is holding.
 *
 * Null when nothing pending bears on this check, which the caller reads as "leave
 * it alone".
 */
function awaitingRestart(check: SetupCheck, pending: readonly ConfigChange[]): SetupCheck | null {
  if (check.verdict === 'ok' || check.verdict === 'unknown') return null;
  const paths = SETTLED_BY[check.id] ?? [];
  const settled = pending.filter((change) => paths.includes(change.path));
  if (settled.length === 0) return null;
  return {
    id: check.id,
    label: check.label,
    verdict: check.verdict,
    detail: `${check.detail} The file already says ${describeChanges(settled)}.`,
    remedy: 'That change is in the file and this process is still running what it booted with. Restart to take it up.',
    fix: { kind: 'goto', label: 'Review and restart', to: 'config' },
  };
}

/**
 * Everything else the file says and this process is not running.
 *
 * `warn` rather than `bad`, and the split is the one the verdicts already make:
 * the harness works, it is simply not working on what the operator last wrote.
 * The checks above are `bad` on their own merits — a fake backlog, an unsigned
 * ticket — and a restart is what clears them; this one names a discrepancy with
 * no fault of its own behind it.
 *
 * It is a discrepancy and not a quantity, which is what earns it a standing row
 * under {@link buildSetupReading}'s rule: it cannot fire on a harness whose file
 * and process agree, and it clears the moment they do. Nothing has to remember it
 * was shown — `LiveConfig.pending()` is recomputed against the running config on
 * every apply, so putting a key back to what the harness is running takes the row
 * away by itself.
 */
function restartCheck(pending: readonly ConfigChange[]): SetupCheck {
  return {
    id: 'restart',
    label: 'Waiting for a restart',
    verdict: 'warn',
    detail: `${describeChanges(pending)} — in the file, and not in this process.`,
    remedy: 'Restart the harness to run on what the file says.',
    fix: { kind: 'goto', label: 'Review and restart', to: 'config' },
  };
}

/**
 * Pending changes as one clause, capped.
 *
 * The cap is not tidiness: these become the single line a rail row draws, and a
 * hand-edited file can change thirty keys at once. An uncapped list would push
 * the remedy — the only actionable part — off the end of a row nobody can read.
 */
function describeChanges(changes: readonly ConfigChange[]): string {
  const shown = changes.slice(0, 3).map((change) => `${change.path} = ${JSON.stringify(change.to)}`);
  const rest = changes.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/**
 * Whether this deployment has been pointed at anything real.
 *
 * The fix writes more than one key, so it is `goto`-shaped here and the cockpit
 * opens the confirm sheet for it: what a repository implies is a table and a diff,
 * not a value on a button. What this check *does* carry is which directory the
 * sheet will open on, and whether that directory is the harness's own.
 */
function pointedCheck(config: Config, onMock: boolean, fileExists: boolean, install: string | null): SetupCheck {
  if (onMock) {
    return {
      id: 'pointed',
      label: 'Pointed at real work',
      verdict: 'bad',
      detail: fileExists
        ? 'Both capabilities are still the built-in fake provider — the backlog on the Overview is invented, not yours.'
        : 'No config file at all, so this is the shipped mock: a fake tracker and a fake agent.',
      remedy:
        install !== null && resolve(install) === resolve(config.repoRoot)
          ? `Name the project the fleet should work on. It currently proposes ${config.repoRoot}, which is LubbDubb's own checkout.`
          : 'Name the project the fleet should work on.',
      fix: { kind: 'sheet', label: 'Point it at a project' },
    };
  }
  return {
    id: 'pointed',
    label: 'Pointed at real work',
    verdict: 'ok',
    detail: `issues via ${config.integrations.issues}, source control via ${config.integrations.sourceControl}`,
  };
}

/**
 * Whether the selected providers can be read at all.
 *
 * Asked of whichever provider is actually selected, and of both when they differ —
 * a deployment reading issues from one and pull requests from another needs both,
 * and checking only one would pass while half the world stayed unreadable.
 *
 * **A provider is asked for every route it has, not for its variable.** Azure has
 * two: `resolveAzureAuth` prefers `AZURE_DEVOPS_PAT` and falls back to the
 * logged-in `az` CLI, so an operator who has run `az login` and set nothing reads
 * the whole world — and the reading that named only the variable told them, in a
 * `bad` row on the surface that exists to be believed, that their working harness
 * could not be read at all. A route this check does not know about is the same bug
 * again, pointed the other way: it would call a fault what is just a second way in.
 * → `docs/spec/26-setup.md#the-credential-check-asks-both-routes`
 */
async function credentialCheck(config: Config, probes: SetupProbes): Promise<SetupCheck> {
  const providers = [...new Set([config.integrations.issues, config.integrations.sourceControl])].filter(
    (provider) => credentialVar(provider) !== null,
  );

  if (providers.length === 0) {
    return {
      id: 'credential',
      label: 'Credential',
      verdict: 'ok',
      detail: 'the fake provider needs none',
    };
  }

  const routes = await Promise.all(providers.map((provider) => credentialRoute(provider, probes)));
  const unmet = routes.filter((route) => !route.met);
  if (unmet.length === 0) {
    return { id: 'credential', label: 'Credential', verdict: 'ok', detail: routes.map((r) => r.detail).join(', ') };
  }
  return {
    id: 'credential',
    label: 'Credential',
    verdict: 'bad',
    detail: `${unmet.map((route) => route.detail).join('; ')} — the provider cannot be read at all.`,
    // Named as the environment's rather than the file's, because that is the
    // whole reason no secret is a config key: the file stays safe to paste.
    remedy: unmet.map((route) => route.remedy).join(' '),
    fix: {
      kind: 'shell',
      label: 'Copy',
      command: unmet.map((route) => route.command).join(' && '),
      // Deduped rather than taken from the first: two providers can be unmet for
      // different reasons, and a sentence explaining one of them stands as a claim
      // about both.
      why: [...new Set(unmet.map((route) => route.why))].join(' '),
    },
  };
}

/** What a check row says about one provider: whether it can be authenticated, and how. */
interface CredentialRoute {
  met: boolean;
  detail: string;
  remedy: string;
  command: string;
  /** Why the harness cannot do this one itself — a `shell` fix is copied, never run. */
  why: string;
}

/**
 * One provider's routes in, asked in the order {@link resolveAzureAuth} tries them.
 *
 * The `az` route is asked **only** when the variable is unset, because it costs a
 * subprocess and the PAT wins anyway — asking it first would spend an `az` spawn on
 * every cockpit mount of a deployment that never uses the CLI.
 */
async function credentialRoute(provider: string, probes: SetupProbes): Promise<CredentialRoute> {
  const name = credentialVar(provider)!;
  const value = probes.env(name);
  if (value !== undefined && value !== '') {
    return { met: true, detail: `${name} present`, remedy: '', command: '', why: '' };
  }
  if (provider === 'azure') {
    if (await probes.azSignedIn()) {
      // Said in full rather than as "present": the operator has no such variable
      // set, and a row claiming they do is the next hour of their life.
      return { met: true, detail: 'the az CLI is signed in', remedy: '', command: '', why: '' };
    }
    return {
      met: false,
      detail: `${name} is not set and the az CLI is not signed in`,
      // `az login` first: it is the shorter path, and it needs no restart — auth is
      // resolved per request, so the fleet picks a fresh sign-in up on its next pulse.
      // A PAT is read once at request time too, but only from the environment of the
      // running process, which is the one thing nothing here can reach.
      remedy: `Run \`az login\`, or export ${name} in the shell that starts the harness and restart.`,
      command: 'az login',
      why: 'Signing in opens a browser and asks you a question, which is not a thing the harness can answer on your behalf — and the other route is a secret, which is never a config key.',
    };
  }
  return {
    met: false,
    detail: `${name} is not set`,
    remedy: `Export ${name} in the shell that starts the harness, then restart.`,
    command: `export ${name}=…`,
    why: 'Nothing here can reach the environment of a process that is already running — and no secret is ever a config key, which is what keeps the file safe to paste.',
  };
}

/**
 * Whether anything says who this harness is.
 *
 * `bad` rather than `warn`, and unconditionally: identity is what the harness
 * signs its own work with, so a deployment without one files tickets into nobody's
 * queue and opens branches nothing can attribute. That is true whatever
 * `ownWorkOnly` says — the filtering half of the split is the *next* check's
 * business, not this one's.
 *
 * No `config` fix is offered from here, because this reading has not been given an
 * email to resolve a login from and a guess would be exactly the wrong thing to put
 * on a confident button: the local part of an address is a plausible GitHub login
 * and is right often enough to be dangerous. `POST /api/setup/resolve` is what
 * turns an address into a login, and the cockpit asks it before drawing a value.
 */
async function identityCheck(config: Config, probes: SetupProbes): Promise<SetupCheck> {
  if (config.userId !== undefined && config.userId !== '') {
    return { id: 'identity', label: 'Who you are', verdict: 'ok', detail: `userId is ${config.userId}` };
  }
  const base: SetupCheck = {
    id: 'identity',
    label: 'Who you are',
    verdict: 'bad',
    detail:
      'Nothing says who this harness is. Tickets it files go unassigned, and its branches are not named as yours.',
    remedy: 'It resolves from the credential, or from your email on a provider that identifies you by one.',
    fix: { kind: 'goto', label: 'Open Config', to: 'config', group: 'Integrations' },
  };

  const provider =
    config.integrations.issues === 'fake' ? config.integrations.sourceControl : config.integrations.issues;
  if (provider === 'azure') {
    // Azure identifies people by UPN, which *is* an email address — so there is a
    // value to propose and nothing corroborating it. `assumed`, and the cockpit
    // therefore puts it in a field before it puts it in the file.
    const email = await probes.gitEmail(config.repoRoot);
    if (email === null || email === '') return base;
    return {
      ...base,
      remedy: 'Azure DevOps identifies you by the address itself, so nothing was asked. Check it before writing.',
      fix: {
        kind: 'config',
        label: `Set userId to ${email}`,
        set: { userId: email },
        confidence: 'assumed',
        group: 'Integrations',
      },
    };
  }
  if (provider !== 'github' || config.github === undefined) return base;
  const token = probes.env('GITHUB_TOKEN');
  if (token === undefined || token === '') {
    // Nothing can be asked, so nothing is proposed — never a guess on a button.
    // The local part of an address is a plausible GitHub login and is right often
    // enough to be dangerous: a wrong `userId` is a fleet that picks nothing up
    // and reports nothing wrong. → `docs/spec/06-issue-pickup.md`
    return { ...base, remedy: 'GITHUB_TOKEN is not set, so nothing can be asked who you are.' };
  }
  const login = await probes.viewerLogin(
    { provider: 'github', parts: [config.github.owner, config.github.repo], url: '' },
    token,
  );
  if (login === null) return { ...base, remedy: 'The credential did not answer, so nothing could be resolved.' };
  return {
    ...base,
    remedy: `GITHUB_TOKEN authenticates as ${login}.`,
    fix: {
      kind: 'config',
      label: `Set userId to ${login}`,
      set: { userId: login },
      confidence: 'confirmed',
      group: 'Integrations',
    },
  };
}

/**
 * The two questions the watch tag actually raises, and they are not one question.
 *
 * The old single check fired whenever no open item carried the tag — which is the
 * resting state of a healthy fleet that has cleared its backlog, so it settled into
 * a permanent scold. Split by {@link buildSetupReading}'s discrepancy rule:
 *
 * - **`eligibility`** is a discrepancy and keeps its row forever. Tagged work
 *   exists and none of it is eligible, because `ownWorkOnly` is on and none of it
 *   is yours. The tracker and the config disagree, the fleet sits still, and
 *   nothing anywhere says so. It cannot fire on an empty backlog: it needs tagged
 *   items to exist before it has anything to compare.
 * - **`wiring`** is the first-hour question — *has this ever picked anything up* —
 *   and is gated on `issue_runs` being empty, the durable record of every goal this
 *   harness has ever had a run at. One pickup and it is gone permanently. Not a
 *   flag: a flag is a second opinion about a thing the database already states, and
 *   the one that could disagree with reality is the one that would be wrong.
 *
 * Both are skipped entirely before the first cycle, where the honest verdict is
 * `unknown` — there is no world to count yet, and "nothing is watched" would be a
 * claim about a reading nobody has taken.
 */
function watchChecks(config: Config, store: Store): SetupCheck[] {
  const label = watchLabelFor(config.labelPrefix);
  if (config.labelPrefix === '') {
    return [
      {
        id: 'watch',
        label: 'Something to work',
        verdict: 'warn',
        detail: 'labelPrefix is empty, so the gate is off entirely and every open item is worked.',
        remedy: 'Set a prefix unless you meant the whole backlog.',
        fix: {
          kind: 'config',
          label: 'Restore the default prefix',
          set: { labelPrefix: 'lubbdubb' },
          confidence: 'assumed',
          group: 'Integrations',
        },
      },
    ];
  }
  const world = store.getWorldBaseline();
  if (world === null) {
    return [
      {
        id: 'watch',
        label: 'Something to work',
        verdict: 'unknown',
        detail: 'no cycle has read the world yet, so there is nothing to count.',
      },
    ];
  }

  const taggedIssues = world.issues.filter((issue) => isWatched(issue.labels, label));
  const tagged = taggedIssues.length + world.pullRequests.filter((pr) => isWatched(pr.labels, label)).length;
  const gated = config.ownWorkOnly && config.userId !== undefined && config.userId !== '';

  // The discrepancy. `labelsAddedByViewer` is what the gate reads, so an empty one
  // on every tagged item is both "somebody else tagged these" and "this provider
  // cannot report authorship at all" — indistinguishable from here, and the same
  // fix serves both. → `docs/spec/06-issue-pickup.md`
  // Issues only: it is issue *pickup* the ownership gate governs, and it is the
  // issues provider that resolves `labelsAddedByViewer`. Pull requests are narrowed
  // by author at fetch time instead, so one arriving at all is already the
  // operator's — there is no second opinion here to have about it.
  if (gated && taggedIssues.length > 0) {
    const mine = taggedIssues.filter((issue) => isWatched(issue.labelsAddedByViewer ?? [], label)).length;
    if (mine === 0) {
      return [
        {
          id: 'eligibility',
          label: 'Something to work',
          verdict: 'warn',
          detail: `${taggedIssues.length} open issue(s) carry ${label} and none of them were tagged by you. ownWorkOnly is on, so nothing is eligible.`,
          remedy: `Tag one yourself, or work anyone's tags.`,
          fix: {
            kind: 'config',
            label: `Work anyone's tags`,
            set: { ownWorkOnly: false },
            confidence: 'confirmed',
            group: 'Integrations',
          },
        },
      ];
    }
  }

  if (tagged > 0) return [];

  // The first-hour question, and the only check here that expires on evidence
  // rather than on being fixed.
  if (store.listIssueRuns().length > 0) return [];
  const open = world.issues.length + world.pullRequests.length;
  return [
    {
      id: 'wiring',
      label: 'Something to work',
      verdict: 'warn',
      detail: `This harness has never picked anything up, and none of the ${open} open item(s) carries ${label}.`,
      remedy: `Tag one thing to see the loop run. This says nothing once it has.`,
      fix: { kind: 'goto', label: 'Open Tickets', to: 'tickets' },
    },
  ];
}

/**
 * Whether an operator's own prompt overrides still name a **retired** tool.
 *
 * `report_finding`, `knowledge_propose`, `knowledge_notice` and
 * `knowledge_contradict` are gone: `raise` is the one door now, and advertising
 * six ways to file one observation is the taxonomy the intake removed
 * ([27](27-knowledge.md)).
 *
 * They spent a release registered-but-named-nowhere rather than deleted, for one
 * reason — an operator's override written before the intake may still name one,
 * and a withdrawn tool name fails *silently*: the call comes back as an unknown
 * method with nothing in the logs, on exactly the deployments that customised
 * most. Unlike a `PromptId`, whose removal turns a deployment into a harness that
 * will not boot and says so.
 *
 * **This check is what let the withdrawal be taken.** It turns "we cannot know
 * who still names these" into a reading an operator can act on; the names
 * outliving their implementations (`RETIRED_TOOL_NAMES`) is what keeps it
 * answerable, and what keeps the call itself answered rather than lost.
 *
 * **`bad`, since the withdrawal.** While the four were still registered this was
 * a `warn`: nothing was broken, and the deployment was one withdrawal away from
 * breaking. The withdrawal has happened, so an override naming one now sends
 * every agent it dispatches at a tool that answers only with a refusal — the
 * agent recovers (it is told to say `raise` instead, and the call is recorded so
 * the Insights MCP tab shows it), but a prompt of the operator's own is spending
 * a turn on nothing, every dispatch.
 *
 * **Only the overrides are read, and a deployment with none draws no check at
 * all** rather than an `ok` row about a thing it does not do. The built-ins name
 * none of these by construction (`test/mcpChannel.test.ts` holds that), so
 * scanning them would be scanning the harness's own text for the harness's own
 * mistake. Where there *are* overrides and none names one, the `ok` row is the
 * reading having been taken — the same shape `credential` takes when the variable
 * is present.
 *
 * The names come from `src/mcp/names.ts`, which is also where the grants come
 * from: two lists that merely agreed today would let a withdrawal reach the
 * grants without reaching this row. → `docs/spec/26-setup.md#an-override-that-names-a-retired-tool`
 */
function retiredToolChecks(prompts: PromptTemplates): SetupCheck[] {
  const overrides = prompts.describe().filter((template) => template.overridden);
  if (overrides.length === 0) return [];
  const naming = overrides
    .map((template) => ({
      id: template.id,
      tools: RETIRED_TOOL_NAMES.filter((tool) => template.template.includes(tool)),
    }))
    .filter((entry) => entry.tools.length > 0);
  if (naming.length === 0) {
    return [
      {
        id: 'prompt-tools',
        label: 'Prompt overrides',
        verdict: 'ok',
        detail: `${overrides.length} override(s), none naming a retired tool`,
      },
    ];
  }
  // Named rather than counted: "3 overrides name withdrawn tools" is a quantity an
  // operator cannot act on, and the whole remedy is which file to open and which
  // word to change in it.
  const named = naming.map((entry) => `${entry.id}.md names ${entry.tools.join(', ')}`);
  return [
    {
      id: 'prompt-tools',
      label: 'Prompt overrides',
      verdict: 'bad',
      detail: `${describeNaming(named)} — retired tools. A call to one is refused, so every dispatch on that prompt spends a turn on nothing.`,
      remedy: 'Say `raise` instead: it takes any observation and the harness works out where it goes.',
      fix: { kind: 'goto', label: 'Open Prompts', to: 'prompts' },
    },
  ];
}

/**
 * The overrides as one clause, capped for {@link describeChanges}' reason: this is
 * the single line a rail row draws, and an operator may have overridden every
 * template in the book.
 */
function describeNaming(named: readonly string[]): string {
  const shown = named.slice(0, 3);
  const rest = named.length - shown.length;
  return rest > 0 ? `${shown.join('; ')} and ${rest} more` : shown.join('; ');
}

async function agentCheck(config: Config, probes: SetupProbes): Promise<SetupCheck> {
  if (config.agentMode === 'raw') {
    return {
      id: 'agent',
      label: 'Agent runtime',
      verdict: 'warn',
      detail: 'agentMode is raw, the mock — a dispatch writes a transcript and never calls a model.',
      remedy: 'Set agentMode to stream.',
      fix: {
        kind: 'config',
        label: 'Set agentMode to stream',
        set: { agentMode: 'stream' },
        confidence: 'confirmed',
        group: 'Agents',
      },
    };
  }
  const version = await probes.agentVersion(config.claudeCommand);
  if (version === null) {
    return {
      id: 'agent',
      label: 'Agent runtime',
      verdict: 'bad',
      detail: `${config.claudeCommand} is not on this harness's PATH, so every dispatch will fail to launch.`,
      remedy: `Install it, or point claudeCommand at it.`,
      fix: {
        kind: 'shell',
        label: 'Copy',
        command: 'npm i -g @anthropic-ai/claude-code',
        why: `Installed elsewhere already? Point claudeCommand at it in Config instead — nothing here can install onto this machine's PATH.`,
      },
    };
  }
  return { id: 'agent', label: 'Agent runtime', verdict: 'ok', detail: `${config.agentMode} · ${version}` };
}

/**
 * The one check here that is about money rather than function, and it is the
 * reason it is a check at all: agents inherit the harness's own environment, and
 * in non-interactive mode the CLI uses an API key whenever one is present with no
 * approval prompt. A stray export therefore moves the whole fleet onto API
 * billing, on every heartbeat, with nothing anywhere saying so.
 */
function billingCheck(probes: SetupProbes): SetupCheck {
  const key = probes.env('ANTHROPIC_API_KEY');
  if (key === undefined || key === '') {
    return { id: 'billing', label: 'Model billing', verdict: 'ok', detail: 'no ANTHROPIC_API_KEY in the environment' };
  }
  return {
    id: 'billing',
    label: 'Model billing',
    verdict: 'bad',
    detail:
      'ANTHROPIC_API_KEY is set, and agents inherit it — in non-interactive mode the CLI uses the key whenever it is present, with no prompt, so every agent bills the API rather than the login.',
    remedy: 'Unset it in the shell that starts the harness unless that is what you meant.',
    fix: {
      kind: 'shell',
      label: 'Copy',
      command: 'unset ANTHROPIC_API_KEY',
      why: 'Run it in the shell that starts the harness, then restart. Nothing here can reach the environment of a process that is already running.',
    },
  };
}
