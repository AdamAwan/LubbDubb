import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { runGit } from '../git/gitCli.js';
import { OctokitGitHubApi } from '../integrations/github/octokitGitHubApi.js';
import type { RemoteTarget } from './remote.js';

const run = promisify(execFile);

/**
 * The small, slow facts Setup needs that nothing else in the harness reads.
 *
 * Every one of them is a *probe* rather than a lookup: it shells out, touches the
 * filesystem or reads the process environment, and can answer "I could not tell".
 * They live behind this interface so the whole surface is testable without a git
 * repository, a `claude` binary or an operator's environment — which is the same
 * seam rule the provider APIs are behind, for the same reason.
 *
 * @public injected into `buildSetupReading` and `resolveFromRepo` (see
 * `src/server/routes/setup.ts`); the fake lives in `test/support/fakeProbes.ts`.
 */
export interface SetupProbes {
  /** The repository's `origin` URL, or null when there is no repo or no remote. */
  originUrl(repoRoot: string): Promise<string | null>;
  /** Is this a git worktree at all? */
  isRepo(repoRoot: string): Promise<boolean>;
  /** `git config user.email` as this repository resolves it. */
  gitEmail(repoRoot: string): Promise<string | null>;
  /** The commit a ref resolves to, preferring `origin/<ref>`. Null when it names nothing. */
  commitFor(repoRoot: string, ref: string): Promise<string | null>;
  /** Which branch `origin/HEAD` points at, or null when the clone never recorded one. */
  remoteHead(repoRoot: string): Promise<string | null>;
  /** The agent binary's version string, or null when it is not on PATH. */
  agentVersion(command: string): Promise<string | null>;
  /**
   * Who the credential says the operator is on the named provider, or null when
   * it cannot say — no network, a refused token, a provider with no such notion.
   *
   * Behind the probe seam rather than called through the integration registry
   * because that registry builds a client from the *running* config, and this is
   * asked about a repository the harness is not pointed at yet.
   */
  viewerLogin(target: RemoteTarget, token: string): Promise<string | null>;
  /** One environment variable, read at the moment it is asked for. */
  env(name: string): string | undefined;
}

/** The real probes: git in the named root, `execFile` for the rest. */
export class RealSetupProbes implements SetupProbes {
  async originUrl(repoRoot: string): Promise<string | null> {
    try {
      const { stdout } = await runGit(repoRoot, ['remote', 'get-url', 'origin']);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async isRepo(repoRoot: string): Promise<boolean> {
    if (!existsSync(repoRoot)) return false;
    try {
      if (!statSync(repoRoot).isDirectory()) return false;
      const { stdout } = await runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']);
      return stdout.trim() === 'true';
    } catch {
      return false;
    }
  }

  async gitEmail(repoRoot: string): Promise<string | null> {
    try {
      const { stdout } = await runGit(repoRoot, ['config', '--get', 'user.email']);
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async commitFor(repoRoot: string, ref: string): Promise<string | null> {
    for (const candidate of [`refs/remotes/origin/${ref}`, `refs/heads/${ref}`]) {
      try {
        const { stdout } = await runGit(repoRoot, ['rev-parse', '--verify', '--quiet', candidate]);
        if (stdout.trim()) return stdout.trim();
      } catch {
        /* names nothing — try the next */
      }
    }
    return null;
  }

  async remoteHead(repoRoot: string): Promise<string | null> {
    try {
      const { stdout } = await runGit(repoRoot, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']);
      const ref = stdout.trim();
      return ref.startsWith('origin/') ? ref.slice('origin/'.length) : null;
    } catch {
      return null;
    }
  }

  async agentVersion(command: string): Promise<string | null> {
    try {
      const { stdout } = await run(command, ['--version'], { timeout: 5_000 });
      return stdout.trim() || null;
    } catch {
      return null;
    }
  }

  async viewerLogin(target: RemoteTarget, token: string): Promise<string | null> {
    if (target.provider !== 'github') return null;
    try {
      const api = OctokitGitHubApi.fromToken(token, target.parts[0]!, target.parts[1]!);
      return (await api.viewerLogin()) || null;
    } catch {
      return null;
    }
  }

  env(name: string): string | undefined {
    return process.env[name];
  }
}
