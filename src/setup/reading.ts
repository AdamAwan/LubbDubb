import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '../config.js';
import { configField, suggestedValue } from '../configFields.js';
import type { ConfigChange } from '../configApply.js';
import type { PromptTemplates } from '../dispatcher/promptTemplates.js';
import { RETIRED_TOOL_NAMES } from '../mcp/names.js';
import type { Store } from '../store/store.js';
import { isWatched, watchLabelFor } from '../watchLabels.js';
import { credentialVar } from './remote.js';
import type { SetupProbes } from './probes.js';

/** A check's answer, deliberately four-valued. */
export type SetupVerdict = 'ok' | 'warn' | 'bad' | 'unknown';

/** The one-click version of a `remedy`. → `docs/spec/26-setup.md#the-fixes` */
export type SetupFix =
  | {
      kind: 'config';
      /** The button's words, naming the value it would write. */
      label: string;
      /**
       * Config **leaf** paths to their values, as the config page's save takes them. Never
       * a nested object: `POST /api/config` validates every key against `CONFIG_FIELDS`,
       * which holds leaves only, so a nested one is refused.
       */
      set: Record<string, unknown>;
      /**
       * Whether the value is a fact or a guess: `confirmed` gets a one-click button,
       * `assumed` an editable field first.
       */
      confidence: 'confirmed' | 'assumed';
      /** The key to open on the config page when the operator would rather look first. */
      group: string;
    }
  /** Open the surface where the decision is made. */
  | { kind: 'goto'; label: string; to: 'config' | 'tickets' | 'prompts'; group?: string }
  /**
   * Open the confirm sheet — a repository, everything it implies, and the diff. →
   * `docs/spec/26-setup.md#two-repositories`
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
     * Whether {@link prefill.repoRoot} is LubbDubb's **own** checkout rather than a project
     * it works on. Not an error, but the one case where the proposed value is the harness's
     * own directory, so nothing about it may be stated confidently. →
     * `docs/spec/26-setup.md#two-repositories`
     */
    repoRootIsSelf: boolean;
  };
  checks: readonly SetupCheck[];
}

/**
 * What the harness can say about its own configuration, without being asked. →
 * `docs/spec/26-setup.md#the-checks`
 */
export async function buildSetupReading(deps: {
  config: Config;
  store: Store;
  probes: SetupProbes;
  configFile: string;
  /**
   * What has reached the file and is waiting for a restart — `LiveConfig.pending()`. →
   * {@link awaitingRestart}
   */
  pending: readonly ConfigChange[];
  /**
   * The resolved template book — `system.prompts`. Required rather than defaulted: the
   * default "no overrides" is the one answer that draws no row at all, so a forgetful
   * caller would silently report a clean deployment.
   */
  prompts: PromptTemplates;
}): Promise<SetupReading> {
  const { config, store, probes, configFile, pending, prompts } = deps;
  const configFileExists = existsSync(configFile);
  const onMock = config.integrations.issues === 'fake' && config.integrations.sourceControl === 'fake';
  const install = probes.installRoot();

  // Read against the running config, then restated where the file has already
  // answered — never suppressed: a fault a restart would clear is still a fault now.
  const checks: SetupCheck[] = [];
  const restated = new Set<string>();
  for (const check of [
    pointedCheck(config, onMock, configFileExists, install),
    await credentialCheck(config, probes),
    await identityCheck(config, probes),
    ...fleetChecks(config),
    ...watchChecks(config, store),
    await agentCheck(config, probes),
    billingCheck(probes),
    ...retiredToolChecks(prompts),
  ]) {
    const waiting = awaitingRestart(check, pending);
    checks.push(waiting ?? check);
    if (waiting !== null) for (const path of SETTLED_BY[check.id] ?? []) restated.add(path);
  }
  // Whatever no check above said in its own words. Computed from what was actually
  // restated rather than from {@link SETTLED_BY}, so a pending change to a key whose
  // check is currently `ok` is named here instead of falling between the two.
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
 * Which config leaves would settle each check, so a fault the operator has already answered
 * can be told from one they have not. Deliberately partial: `credential` and `billing` must
 * never appear, since both read the environment, which no config edit can change in a
 * running process. `wiring` is absent because it is settled by tagging a ticket.
 */
const SETTLED_BY: Readonly<Record<string, readonly string[]>> = {
  pointed: ['integrations.issues', 'integrations.sourceControl'],
  identity: ['userId'],
  fleet: ['fleetId'],
  eligibility: ['ownWorkOnly'],
  watch: ['labelPrefix'],
  agent: ['agentMode', 'claudeCommand'],
};

/**
 * The same fault, restated for an operator who has already fixed it in the file —
 * `integrations` and `userId` have no arm in `src/configApply.ts`, so editing them leaves
 * the running config as it was. → `docs/spec/02-configuration.md#liveness` **The verdict is
 * kept, never softened**: a `bad` a restart would clear is still `bad` now. What changes is
 * the words and the offer — `goto` config, where the pending card and its `Apply and
 * restart` button live. Null when nothing pending bears on this check.
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

/** Everything else the file says and this process is not running. */
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
 * Pending changes as one clause, capped: these become the single line a rail row draws, and
 * an uncapped list pushes the remedy off the end of it.
 */
function describeChanges(changes: readonly ConfigChange[]): string {
  const shown = changes.slice(0, 3).map((change) => `${change.path} = ${JSON.stringify(change.to)}`);
  const rest = changes.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

/** Whether this deployment has been pointed at anything real. */
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
 * Whether the selected providers can be read at all. →
 * `docs/spec/26-setup.md#the-credential-check-asks-both-routes`
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
    // Named as the environment's rather than the file's: no secret is a config key,
    // so the file stays safe to paste.
    remedy: unmet.map((route) => route.remedy).join(' '),
    fix: {
      kind: 'shell',
      label: 'Copy',
      command: unmet.map((route) => route.command).join(' && '),
      // Deduped rather than taken from the first: two providers can be unmet for
      // different reasons, and one sentence would stand as a claim about both.
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

/** One provider's routes in, asked in the order {@link resolveAzureAuth} tries them. */
async function credentialRoute(provider: string, probes: SetupProbes): Promise<CredentialRoute> {
  const name = credentialVar(provider)!;
  const value = probes.env(name);
  if (value !== undefined && value !== '') {
    return { met: true, detail: `${name} present`, remedy: '', command: '', why: '' };
  }
  if (provider === 'azure') {
    if (await probes.azSignedIn()) {
      // Said in full rather than as "present": a row claiming a variable is set when
      // it is not costs the operator an hour.
      return { met: true, detail: 'the az CLI is signed in', remedy: '', command: '', why: '' };
    }
    return {
      met: false,
      detail: `${name} is not set and the az CLI is not signed in`,
      // `az login` first: shorter, and it needs no restart — auth is resolved per
      // request, so the fleet picks a fresh sign-in up on its next pulse. A PAT is
      // read from the running process's environment, which nothing here can reach.
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

/** Whether anything says who this harness is. */
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
    // Azure identifies people by UPN, which *is* an email address: a value to
    // propose with nothing corroborating it, so `assumed`.
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
    // Nothing can be asked, so nothing is proposed — never a guess on a button. A
    // wrong `userId` is a fleet that picks nothing up and reports nothing wrong.
    // → `docs/spec/06-issue-pickup.md`
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
 * Whether a deployment that has selected the pool has said who it publishes as. **Nothing
 * while the pool is `fake`**, which is the default. →
 * `docs/spec/28-cross-fleet-pool.md#a-fleet-with-no-name-yet` **`bad`, not `warn`**: a
 * fleet with no name publishes nothing and reads nobody, and the pool panel then draws
 * exactly what a deployment that never opted in draws — this row is the only thing telling
 * the two apart. The offer is `userId@pool.project`, `assumed`, from the same
 * `CONFIG_FIELDS` declaration the config page uses; where either part is missing the row is
 * a `goto` instead.
 */
function fleetChecks(config: Config): SetupCheck[] {
  if (config.integrations.pool === 'fake') return [];
  if (config.fleetId !== undefined && config.fleetId !== '') {
    return [{ id: 'fleet', label: 'Who this fleet is', verdict: 'ok', detail: `fleetId is ${config.fleetId}` }];
  }
  const base: SetupCheck = {
    id: 'fleet',
    label: 'Who this fleet is',
    verdict: 'bad',
    detail: `The pool is on via ${config.integrations.pool} and nothing says who this fleet is, so it publishes nothing and reads nobody.`,
    remedy:
      'Name person and target repo — "alice@acme-api" — so two of one person\'s deployments are distinguishable in the pool. It is never derived.',
    fix: { kind: 'goto', label: 'Open Config', to: 'config', group: 'Integrations' },
  };
  const field = configField('fleetId');
  const offer = field === undefined ? undefined : suggestedValue(field, config);
  if (offer === undefined) return [base];
  return [
    {
      ...base,
      remedy: `${base.remedy} Your userId and the project's name make ${offer} — check it before writing.`,
      fix: {
        kind: 'config',
        label: `Set fleetId to ${offer}`,
        set: { fleetId: offer },
        confidence: 'assumed',
        group: 'Integrations',
      },
    },
  ];
}

/**
 * The two questions the watch tag raises, split by {@link buildSetupReading}'s discrepancy
 * rule: - **`eligibility`** keeps its row forever: tagged work exists and none of it is
 * eligible, because `ownWorkOnly` is on and none of it is yours. Both are skipped before
 * the first cycle, where the honest verdict is `unknown`.
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

  // The discrepancy. An empty `labelsAddedByViewer` on every tagged item is both
  // "somebody else tagged these" and "this provider cannot report authorship" —
  // indistinguishable from here, and the same fix serves both.
  // → `docs/spec/06-issue-pickup.md`
  //
  // Issues only: the ownership gate governs issue pickup, and pull requests are
  // narrowed by author at fetch time instead.
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
 * Whether an operator's own prompt overrides still name a **retired** tool. A withdrawn tool
 * name fails silently — the call comes back as an unknown method with nothing in the logs —
 * so this check is what makes the withdrawal answerable.
 * → `docs/spec/26-setup.md#an-override-that-names-a-retired-tool`
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
  // Named rather than counted: the whole remedy is which file to open and which
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

/** The overrides as one clause, capped for {@link describeChanges}' reason. */
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
 * The one check about money rather than function. Agents inherit the harness's environment,
 * and non-interactive `claude` uses an API key whenever one is present — a stray export
 * moves the whole fleet onto API billing with nothing saying so.
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
