import { execFile } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { runGit } from '../git/gitCli.js';
import { azCliAccessToken } from '../integrations/azure/restAzureDevOpsApi.js';
import { OctokitGitHubApi } from '../integrations/github/octokitGitHubApi.js';
import { installRoot } from '../selfUpdate/buildStanding.js';
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
  /**
   * LubbDubb's **own** checkout — the directory the running build sits in,
   * resolved from the running module and from nothing an operator can configure.
   *
   * Here so the reading can tell it from `repoRoot`, which is the *project the
   * fleet works on*. `repoRoot` defaults to `process.cwd()`, so on a default start
   * the prefill always proposes this directory — right for a harness dogfooding
   * itself and wrong for every other deployment, and indistinguishable without
   * this. Null when the walk found no `.git`.
   */
  installRoot(): string | null;
  /**
   * Whether the logged-in `az` CLI can mint an Azure DevOps token right now — the
   * harness's **second** way into Azure, and the reason a missing
   * `AZURE_DEVOPS_PAT` is not by itself a fault.
   *
   * `resolveAzureAuth` prefers a PAT and falls back to the CLI, so a deployment
   * signed in with `az login` reads the whole world with no variable set anywhere.
   * A check that asked only the environment therefore called a working harness
   * unreadable, in the operator's own words, on the surface that exists to be
   * believed. → `docs/spec/26-setup.md#the-credential-check-asks-both-routes`
   */
  azSignedIn(): Promise<boolean>;
  /** One environment variable, read at the moment it is asked for. */
  env(name: string): string | undefined;
}

/** The real probes: git in the named root, `execFile` for the rest. */
export class RealSetupProbes implements SetupProbes {
  /**
   * Logins already asked for, keyed by credential *and* target.
   *
   * The one probe on this class that costs a rate-limited request rather than a
   * subprocess, and the one asked most often: `GET /api/setup` runs on every
   * cockpit mount and on every config apply, and `POST /api/setup/resolve` is
   * debounced-per-keystroke behind the setup panel's two fields. Each of those was
   * a fresh client and a fresh `GET /user` for an answer that is fixed for a
   * token's lifetime — which is precisely the reasoning
   * `OctokitGitHubApi.viewerLogin` already caches on, applied to the caller that
   * kept building a new one.
   *
   * Only an answer is remembered. A failure is not: "the credential did not
   * answer" is the reading the panel exists to correct, so it must be re-asked the
   * moment the operator exports a token and the page re-reads.
   */
  private readonly logins = new Map<string, string>();

  /** When the `az` CLI last answered yes, or null when it has not since the window lapsed. */
  private azOkAtMs: number | null = null;
  /** Short enough that a lapsed `az` session surfaces within minutes of expiring. */
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

  /**
   * Asked of `azCliAccessToken` — the same call the Azure client authenticates
   * with, never a second spawn written to look equivalent.
   *
   * Cached only when it succeeds, and only for a window: `GET /api/setup` runs on
   * every cockpit mount and `POST /api/setup/resolve` sits debounced behind the
   * panel's fields, so an uncached probe is an `az` subprocess per keystroke. The
   * window is short because unlike a token, a CLI session expires under us — a
   * positive remembered forever would go on reporting a signed-out machine as
   * fine. A failure is never remembered: "not signed in" is the reading this panel
   * exists to correct, so `az login` must clear it on the next read.
   */
  async azSignedIn(): Promise<boolean> {
    if (this.azOkAtMs !== null && Date.now() - this.azOkAtMs < RealSetupProbes.AZ_TTL_MS) return true;
    try {
      // The token itself is discarded — this probe answers a yes/no and must never
      // carry a credential any further than the stack frame that minted it.
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
