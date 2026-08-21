import { resolve as resolvePath } from 'node:path';
import { projectConfigFilePath, projectConfigLayer, type Config } from '../config.js';
import { watchLabelFor } from '../watchLabels.js';
import { credentialVar, parseRemote, type RemoteTarget } from './remote.js';
import type { SetupProbes } from './probes.js';

/**
 * Everything the two questions imply, and the keys they would write.
 *
 * The shape of the whole feature is here: Setup asks for an email and a
 * directory, and *derives* the six keys an operator would otherwise have typed.
 * Each derivation is reported with where it came from, because a value the
 * harness worked out for you and a value you chose are different things to be
 * wrong about — the same distinction the config page's four source chips draw.
 */
export interface SetupResolution {
  repoRoot: string;
  /**
   * Whether {@link repoRoot} is LubbDubb's **own** checkout rather than a project
   * it works on — the two coincide only when the harness is dogfooding itself.
   *
   * Reported rather than refused: dogfooding is how this repo is developed. What it
   * costs is confidence, since `repoRoot` defaults to `process.cwd()` and so
   * proposes this directory on every default start whether the operator meant it or
   * not. → `docs/spec/26-setup.md#two-repositories`
   */
  repoRootIsSelf: boolean;
  /** Null when the directory is not a git worktree — every derivation below then fails with it. */
  originUrl: string | null;
  isRepo: boolean;
  target: RemoteTarget | null;
  defaultBranch: { name: string; commit: string | null } | null;
  identity: SetupIdentity;
  credential: { variable: string | null; present: boolean };
  /** The team's shared layer, and which keys it is contributing. */
  project: { file: string | null; keys: readonly string[] };
  /** The derived watch tag, and whether the prefix behind it is the team's or the default. */
  watch: { label: string; fromProject: boolean };
  /**
   * What `POST /api/config` would be asked to set — the review step's subject, and
   * the only thing here that is ever written.
   *
   * A key the project layer already sets is **absent on purpose**: copying a team
   * value into an operator's own file freezes it at today's, and the next commit
   * that changed it would not reach them. The absence is the feature.
   *
   * **Every key is a config *leaf* path** — `integrations.issues`, never
   * `integrations`. `POST /api/config` validates each one against `CONFIG_FIELDS`,
   * which holds leaves only, so a nested object is refused at the preview with the
   * operator's whole answer one field away from being written and nothing but a
   * field name to explain it. `test/setupWrites.test.ts` holds this against that
   * registry, because it is a contract between two modules that neither states.
   */
  writes: Record<string, unknown>;
}

/**
 * Who the provider says you are, and how confident this is entitled to be about it.
 *
 * Unexported: it is named only by {@link SetupResolution.identity}, and every
 * consumer reads it through that.
 */
interface SetupIdentity {
  email: string;
  /** The value that would be written as `userId`, or null when nothing could resolve one. */
  userId: string | null;
  /**
   * Three-valued, and a reader must not fold `unknown` into `no`.
   *
   * `confirmed` — the credential answered with this login. `assumed` — derived
   * from the email without anything corroborating it, which is what an Azure UPN
   * is. `unknown` — nothing could be asked, because there is no credential or no
   * provider yet. Only the first is a fact.
   */
  confidence: 'confirmed' | 'assumed' | 'unknown';
  why: string;
}

/** The starting posture Setup writes for a first run, rather than the fleet's defaults. */
const FIRST_RUN_AGENTS = { agentMode: 'stream', maxConcurrentAgents: 1 } as const;

/**
 * Read a repository and an email into everything else.
 *
 * Deliberately does no writing and holds no state: the same inputs give the same
 * answer, and the review step is free to re-run it. Every probe that cannot
 * answer leaves its field null rather than guessing — a repository this cannot
 * read is a thing to say out loud, not to paper over with the `fake` provider.
 */
export async function resolveFromRepo(
  input: { email: string; repoRoot: string },
  deps: { probes: SetupProbes; config: Config },
): Promise<SetupResolution> {
  const { probes, config } = deps;
  const repoRoot = input.repoRoot;
  const isRepo = await probes.isRepo(repoRoot);
  const originUrl = isRepo ? await probes.originUrl(repoRoot) : null;
  const target = originUrl === null ? null : parseRemote(originUrl);

  // The team's file is read *through* `repoRoot`, which is the whole reason this
  // step is first: a layer cannot be consulted about where to find itself.
  const projectFile = projectConfigFilePath(repoRoot);
  let projectLayer: Partial<Config> = {};
  let projectPresent = false;
  try {
    projectLayer = projectConfigLayer(projectFile);
    projectPresent = Object.keys(projectLayer).length > 0;
  } catch {
    // A half-typed or invalid team file reads as absent here rather than throwing.
    // This is the surface an operator opens *because* something looks wrong.
    projectLayer = {};
  }
  const projectKeys = Object.keys(projectLayer).sort();

  // Its remote head where the clone recorded one, the running config's answer
  // otherwise. Not guessed as "main": a repository whose trunk is `master` or
  // `develop` would have every branch cut from a ref that does not exist.
  const branchName = (await probes.remoteHead(repoRoot)) ?? projectLayer.defaultBranch ?? config.defaultBranch;
  const branchCommit = isRepo ? await probes.commitFor(repoRoot, branchName) : null;
  const defaultBranch = isRepo ? { name: branchName, commit: branchCommit } : null;

  const variable = target === null ? null : credentialVar(target.provider);
  const token = variable === null ? undefined : probes.env(variable);
  const identity = await resolveIdentity(input.email, target, token, probes);

  const prefix = projectLayer.labelPrefix ?? config.labelPrefix;
  const watch = { label: watchLabelFor(prefix), fromProject: projectLayer.labelPrefix !== undefined };

  const writes: Record<string, unknown> = { repoRoot, ...FIRST_RUN_AGENTS };
  if (defaultBranch) writes.defaultBranch = defaultBranch.name;
  if (identity.userId !== null) writes.userId = identity.userId;
  if (target !== null) {
    // Skipped when the team's file already selects them, for {@link SetupResolution.writes}' reason.
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
    credential: { variable, present: token !== undefined && token !== '' },
    project: { file: projectPresent ? projectFile : null, keys: projectKeys },
    watch,
    writes,
  };
}

/**
 * The email, turned into whatever the provider calls you.
 *
 * Asked of the credential where one can answer, because this is the value that
 * gates pickup: with `userId` set the harness reads *who added* each label rather
 * than the labels themselves, and a wrong login there is a fleet that picks
 * nothing up and reports nothing wrong. A guess is therefore never returned as a
 * fact — the local part of an address is a plausible GitHub login and is right
 * often enough to be dangerous.
 */
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
    // Azure identifies people by UPN, which *is* an email address. There is
    // nothing to resolve and nothing to be uncertain about.
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
