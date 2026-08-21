import { existsSync } from 'node:fs';
import type { Config } from '../config.js';
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

export interface SetupCheck {
  id: string;
  label: string;
  verdict: SetupVerdict;
  /** What was actually observed, in a sentence. Never a restatement of the label. */
  detail: string;
  /** What to do about it, when there is something to do. */
  remedy?: string;
}

export interface SetupReading {
  /**
   * Whether this deployment has been pointed anywhere — the config file exists
   * *and* something other than the shipped mock is selected.
   *
   * Not the same question as "is everything green": a harness pointed at a real
   * repository with an expired token is pointed, and needs the checks below
   * rather than the two questions again.
   */
  pointed: boolean;
  configFile: string;
  configFileExists: boolean;
  /** What the two questions open with, so nobody types what the machine knows. */
  prefill: { email: string | null; repoRoot: string };
  checks: readonly SetupCheck[];
  /** How many checks are not `ok`. What the top bar's reading counts, and it hides at zero. */
  outstanding: number;
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
 * operator finds out on a Tuesday that a token expired, and `watch` is how they
 * find out that a repository nobody has tagged anything in will keep the fleet
 * idle and report nothing wrong.
 */
export async function buildSetupReading(deps: {
  config: Config;
  store: Store;
  probes: SetupProbes;
  configFile: string;
}): Promise<SetupReading> {
  const { config, store, probes, configFile } = deps;
  const configFileExists = existsSync(configFile);
  const onMock = config.integrations.issues === 'fake' && config.integrations.sourceControl === 'fake';

  const checks: SetupCheck[] = [
    pointedCheck(config, onMock, configFileExists),
    credentialCheck(config, probes),
    identityCheck(config),
    watchCheck(config, store),
    await agentCheck(config, probes),
    billingCheck(probes),
  ];

  return {
    pointed: configFileExists && !onMock,
    configFile,
    configFileExists,
    prefill: {
      email: await probes.gitEmail(config.repoRoot),
      repoRoot: config.repoRoot,
    },
    checks,
    outstanding: checks.filter((check) => check.verdict !== 'ok').length,
  };
}

function pointedCheck(config: Config, onMock: boolean, fileExists: boolean): SetupCheck {
  if (onMock) {
    return {
      id: 'pointed',
      label: 'Pointed at real work',
      verdict: 'warn',
      detail: fileExists
        ? 'Both capabilities are still the built-in fake provider — the world on the Overview is invented.'
        : 'No config file at all, so this is the shipped mock: a fake tracker and a fake agent.',
      remedy: 'Answer the two questions and Setup will write the file.',
    };
  }
  return {
    id: 'pointed',
    label: 'Pointed at real work',
    verdict: 'ok',
    detail: `issues via ${config.integrations.issues}, source control via ${config.integrations.sourceControl}`,
  };
}

function credentialCheck(config: Config, probes: SetupProbes): SetupCheck {
  // Asked of whichever provider is actually selected, and of both when they
  // differ — a deployment reading issues from one and pull requests from another
  // needs both credentials, and checking only one would pass while half the world
  // stayed unreadable.
  const variables = [
    ...new Set([credentialVar(config.integrations.issues), credentialVar(config.integrations.sourceControl)]),
  ].filter((name): name is string => name !== null);

  if (variables.length === 0) {
    return {
      id: 'credential',
      label: 'Credential',
      verdict: 'ok',
      detail: 'the fake provider needs none',
    };
  }
  const missing = variables.filter((name) => {
    const value = probes.env(name);
    return value === undefined || value === '';
  });
  if (missing.length === 0) {
    return { id: 'credential', label: 'Credential', verdict: 'ok', detail: `${variables.join(', ')} present` };
  }
  return {
    id: 'credential',
    label: 'Credential',
    verdict: 'bad',
    detail: `${missing.join(' and ')} not set in this process — the provider cannot be read at all.`,
    // Named as the environment's rather than the file's, because that is the
    // whole reason no secret is a config key: the file stays safe to paste.
    remedy: `Export ${missing.join(' and ')} in the shell that starts the harness, then restart.`,
  };
}

function identityCheck(config: Config): SetupCheck {
  if (config.userId !== undefined && config.userId !== '') {
    return { id: 'identity', label: 'Who you are', verdict: 'ok', detail: `userId is ${config.userId}` };
  }
  return {
    id: 'identity',
    label: 'Who you are',
    verdict: 'warn',
    detail:
      'userId is unset, so all three ownership gates are off: any tagger counts, filed tickets go unassigned, and every open pull request is surfaced.',
    remedy: 'Setup resolves it from your email against the provider.',
  };
}

/**
 * Whether anything at all has opted in.
 *
 * The quietest failure the harness has: everything is opt-in, so a repository
 * nobody has tagged leaves the fleet pulsing, deciding correctly that there is
 * nothing to do, and looking exactly like a fleet that is broken.
 */
function watchCheck(config: Config, store: Store): SetupCheck {
  const label = watchLabelFor(config.labelPrefix);
  if (config.labelPrefix === '') {
    return {
      id: 'watch',
      label: 'Something to work',
      verdict: 'warn',
      detail: 'labelPrefix is empty, so the gate is off entirely and every open item is worked.',
      remedy: 'Set a prefix unless you meant the whole backlog.',
    };
  }
  const world = store.getWorldBaseline();
  if (world === null) {
    return {
      id: 'watch',
      label: 'Something to work',
      verdict: 'unknown',
      detail: 'no cycle has read the world yet, so there is nothing to count.',
    };
  }
  const watched =
    world.issues.filter((issue) => isWatched(issue.labels, label)).length +
    world.pullRequests.filter((pr) => isWatched(pr.labels, label)).length;
  if (watched > 0) {
    return { id: 'watch', label: 'Something to work', verdict: 'ok', detail: `${watched} item(s) carry ${label}` };
  }
  const open = world.issues.length + world.pullRequests.length;
  return {
    id: 'watch',
    label: 'Something to work',
    verdict: 'warn',
    detail: `none of the ${open} open item(s) carries ${label}, so nothing is eligible and the fleet will correctly do nothing.`,
    remedy: `Tag something from the Tickets tab, or create ${label} on the tracker.`,
  };
}

async function agentCheck(config: Config, probes: SetupProbes): Promise<SetupCheck> {
  if (config.agentMode === 'raw') {
    return {
      id: 'agent',
      label: 'Agent runtime',
      verdict: 'warn',
      detail: 'agentMode is raw, the mock — a dispatch writes a transcript and never calls a model.',
      remedy: 'Set agentMode to stream.',
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
  };
}
