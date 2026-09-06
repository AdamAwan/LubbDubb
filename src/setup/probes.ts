import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { runGit } from '../git/gitCli.js';
import { azCliAccessToken } from '../integrations/azure/restAzureDevOpsApi.js';
import { OctokitGitHubApi } from '../integrations/github/octokitGitHubApi.js';
import { installRoot } from '../selfUpdate/buildStanding.js';
import type { RemoteTarget } from './remote.js';

// → docs/spec/26-setup.md

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
  originUrl(repoRoot: string): Promise<string | null>;
  isRepo(repoRoot: string): Promise<boolean>;
  gitEmail(repoRoot: string): Promise<string | null>;
  commitFor(repoRoot: string, ref: string): Promise<string | null>;
  remoteHead(repoRoot: string): Promise<string | null>;
  agentVersion(command: string): Promise<string | null>;
  viewerLogin(target: RemoteTarget, token: string): Promise<string | null>;
  installRoot(): string | null;
  azSignedIn(): Promise<boolean>;
  env(name: string): string | undefined;
}

export class RealSetupProbes implements SetupProbes {
  private readonly logins = new Map<string, string>();

  private azOkAtMs: number | null = null;
  private static readonly AZ_TTL_MS = 5 * 60 * 1000;

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
    const key = `${token}\u0000${target.parts.join('/')}`;
    const known = this.logins.get(key);
    if (known !== undefined) return known;
    try {
      const api = OctokitGitHubApi.fromToken(token, target.parts[0]!, target.parts[1]!);
      const login = (await api.viewerLogin()) || null;
      if (login !== null) this.logins.set(key, login);
      return login;
    } catch {
      return null;
    }
  }

  installRoot(): string | null {
    return installRoot();
  }

  async azSignedIn(): Promise<boolean> {
    if (this.azOkAtMs !== null && Date.now() - this.azOkAtMs < RealSetupProbes.AZ_TTL_MS) return true;
    try {
      const ok = (await azCliAccessToken()).length > 0;
      if (ok) this.azOkAtMs = Date.now();
      return ok;
    } catch {
      this.azOkAtMs = null;
      return false;
    }
  }

  env(name: string): string | undefined {
    return process.env[name];
  }
}
