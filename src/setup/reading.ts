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

// → docs/spec/26-setup.md

export type SetupVerdict = 'ok' | 'warn' | 'bad' | 'unknown';

export type SetupFix =
  | {
      kind: 'config';
      label: string;
      set: Record<string, unknown>;
      confidence: 'confirmed' | 'assumed';
      group: string;
    }
  | { kind: 'goto'; label: string; to: 'config' | 'tickets' | 'prompts'; group?: string }
  | { kind: 'sheet'; label: string }
  | {
      kind: 'shell';
      label: string;
      command: string;
      why: string;
    };

export interface SetupCheck {
  id: string;
  label: string;
  verdict: SetupVerdict;
  detail: string;
  remedy?: string;
  fix?: SetupFix;
}

export interface SetupReading {
  configFile: string;
  configFileExists: boolean;
  prefill: {
    email: string | null;
    repoRoot: string;
    repoRootIsSelf: boolean;
  };
  checks: readonly SetupCheck[];
}

export async function buildSetupReading(deps: {
  config: Config;
  store: Store;
  probes: SetupProbes;
  configFile: string;
  pending: readonly ConfigChange[];
  prompts: PromptTemplates;
}): Promise<SetupReading> {
  const { config, store, probes, configFile, pending, prompts } = deps;
  const configFileExists = existsSync(configFile);
  const onMock = config.integrations.issues === 'fake' && config.integrations.sourceControl === 'fake';
  const install = probes.installRoot();

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

const SETTLED_BY: Readonly<Record<string, readonly string[]>> = {
  pointed: ['integrations.issues', 'integrations.sourceControl'],
  identity: ['userId'],
  fleet: ['fleetId'],
  eligibility: ['ownWorkOnly'],
  watch: ['labelPrefix'],
  agent: ['agentMode', 'claudeCommand'],
};

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

function describeChanges(changes: readonly ConfigChange[]): string {
  const shown = changes.slice(0, 3).map((change) => `${change.path} = ${JSON.stringify(change.to)}`);
  const rest = changes.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

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
    remedy: unmet.map((route) => route.remedy).join(' '),
    fix: {
      kind: 'shell',
      label: 'Copy',
      command: unmet.map((route) => route.command).join(' && '),
      why: [...new Set(unmet.map((route) => route.why))].join(' '),
    },
  };
}

interface CredentialRoute {
  met: boolean;
  detail: string;
  remedy: string;
  command: string;
  why: string;
}

async function credentialRoute(provider: string, probes: SetupProbes): Promise<CredentialRoute> {
  const name = credentialVar(provider)!;
  const value = probes.env(name);
  if (value !== undefined && value !== '') {
    return { met: true, detail: `${name} present`, remedy: '', command: '', why: '' };
  }
  if (provider === 'azure') {
    if (await probes.azSignedIn()) {
      return { met: true, detail: 'the az CLI is signed in', remedy: '', command: '', why: '' };
    }
    return {
      met: false,
      detail: `${name} is not set and the az CLI is not signed in`,
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
  const world = store.world.getWorldBaseline();
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

  if (store.floor.listIssueRuns().length > 0) return [];
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
