import { resolve as resolvePath } from 'node:path';
import { projectConfigFilePath, projectConfigLayer, type Config } from '../config/config.js';
import { watchLabelFor } from '../watchLabels.js';
import { credentialVar, parseRemote, type RemoteTarget } from './remote.js';
import type { SetupProbes } from './probes.js';

// → docs/spec/26-setup.md

export interface SetupResolution {
  repoRoot: string;
  repoRootIsSelf: boolean;
  originUrl: string | null;
  isRepo: boolean;
  target: RemoteTarget | null;
  defaultBranch: { name: string; commit: string | null } | null;
  identity: SetupIdentity;
  credential: { variable: string | null; present: boolean; source: 'env' | 'az-cli' | null };
  project: { file: string | null; keys: readonly string[] };
  watch: { label: string; fromProject: boolean };
  writes: Record<string, unknown>;
}

interface SetupIdentity {
  email: string;
  userId: string | null;
  confidence: 'confirmed' | 'assumed' | 'unknown';
  why: string;
}

const FIRST_RUN_AGENTS = { agentMode: 'stream', maxConcurrentAgents: 1 } as const;

export async function resolveFromRepo(
  input: { email: string; repoRoot: string },
  deps: { probes: SetupProbes; config: Config },
): Promise<SetupResolution> {
  const { probes, config } = deps;
  const repoRoot = input.repoRoot;
  const isRepo = await probes.isRepo(repoRoot);
  const originUrl = isRepo ? await probes.originUrl(repoRoot) : null;
  const target = originUrl === null ? null : parseRemote(originUrl);

  const projectFile = projectConfigFilePath(repoRoot);
  let projectLayer: Partial<Config> = {};
  let projectPresent = false;
  try {
    projectLayer = projectConfigLayer(projectFile);
    projectPresent = Object.keys(projectLayer).length > 0;
  } catch {
    projectLayer = {};
  }
  const projectKeys = Object.keys(projectLayer).sort();

  const branchName = (await probes.remoteHead(repoRoot)) ?? projectLayer.defaultBranch ?? config.defaultBranch;
  const branchCommit = isRepo ? await probes.commitFor(repoRoot, branchName) : null;
  const defaultBranch = isRepo ? { name: branchName, commit: branchCommit } : null;

  const variable = target === null ? null : credentialVar(target.provider);
  const token = variable === null ? undefined : probes.env(variable);
  const identity = await resolveIdentity(input.email, target, token, probes);

  const hasToken = token !== undefined && token !== '';
  const azCli = !hasToken && target?.provider === 'azure' && (await probes.azSignedIn());
  const source = hasToken ? 'env' : azCli ? 'az-cli' : null;

  const prefix = projectLayer.labelPrefix ?? config.labelPrefix;
  const watch = { label: watchLabelFor(prefix), fromProject: projectLayer.labelPrefix !== undefined };

  const writes: Record<string, unknown> = { repoRoot, ...FIRST_RUN_AGENTS };
  if (defaultBranch) writes.defaultBranch = defaultBranch.name;
  if (identity.userId !== null) writes.userId = identity.userId;
  if (target !== null) {
    if (projectLayer.integrations === undefined) {
      writes['integrations.sourceControl'] = target.provider;
      writes['integrations.issues'] = target.provider;
    }
    if (target.provider === 'github' && projectLayer.github === undefined) {
      writes['github.owner'] = target.parts[0];
      writes['github.repo'] = target.parts[1];
    }
    if (target.provider === 'azure' && projectLayer.azureDevOps === undefined) {
      writes['azureDevOps.organization'] = target.parts[0];
      writes['azureDevOps.project'] = target.parts[1];
      writes['azureDevOps.repository'] = target.parts[2];
    }
  }

  const install = probes.installRoot();
  return {
    repoRoot,
    repoRootIsSelf: install !== null && resolvePath(install) === resolvePath(repoRoot),
    originUrl,
    isRepo,
    target,
    defaultBranch,
    identity,
    credential: { variable, present: source !== null, source },
    project: { file: projectPresent ? projectFile : null, keys: projectKeys },
    watch,
    writes,
  };
}

async function resolveIdentity(
  email: string,
  target: RemoteTarget | null,
  token: string | undefined,
  probes: SetupProbes,
): Promise<SetupIdentity> {
  if (target === null) {
    return { email, userId: null, confidence: 'unknown', why: 'no provider yet — nothing to resolve a login against' };
  }
  if (target.provider === 'azure') {
    return { email, userId: email, confidence: 'assumed', why: 'Azure DevOps identifies you by the address itself' };
  }
  if (token === undefined || token === '') {
    return {
      email,
      userId: null,
      confidence: 'unknown',
      why: 'GITHUB_TOKEN is not set, so nothing can be asked who you are',
    };
  }
  const login = await probes.viewerLogin(target, token);
  if (login === null) {
    return { email, userId: null, confidence: 'unknown', why: 'the credential did not answer' };
  }
  return { email, userId: login, confidence: 'confirmed', why: `the credential authenticates as ${login}` };
}
