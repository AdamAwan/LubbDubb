/**
 * What an `origin` URL says about where this repository lives.
 *
 * The whole reason Setup asks two questions rather than six: a checkout already
 * knows its provider and its target, and asking an operator to retype what
 * `git remote -v` prints is asking them to be a worse copy of their own repo.
 */
export interface RemoteTarget {
  /**
   * Narrower than `IntegrationSelection`'s `string` on purpose: a remote either
   * names a provider this harness has an integration for, or the parse returns
   * null. There is no third member to widen for, and `fake` is not one — it is
   * what a deployment runs when nothing has been read, never something read.
   */
  provider: 'github' | 'azure';
  /** GitHub: `owner/repo`. Azure DevOps: `organization/project/repository`. */
  parts: readonly string[];
  /** The URL this was read from, so a surface can show what it decided from. */
  url: string;
}

/**
 * Parse an `origin` URL into a provider and its target.
 *
 * Returns `null` for a host nothing here speaks — a self-hosted GitLab, a bare
 * path, an internal mirror. That is a *third* answer and not `fake`: an operator
 * whose remote could not be read needs to be told the reading failed, not handed
 * a mock provider that will happily invent a world for them.
 *
 * Both transports of each provider are accepted because both are what people
 * actually have — `git@github.com:acme/app.git` from an SSH clone,
 * `https://github.com/acme/app.git` from the web button — and a flow that worked
 * for one of them would look broken to half the people who tried it.
 */
export function parseRemote(url: string): RemoteTarget | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  const { host, path } = split(trimmed);
  if (host === null) return null;
  const segments = path
    .replace(/\.git$/i, '')
    .split('/')
    .filter(Boolean);

  if (host === 'github.com' || host.endsWith('.github.com')) {
    if (segments.length < 2) return null;
    // The last two, not the first two: an enterprise path can carry a prefix,
    // and owner/repo are always the tail.
    return { provider: 'github', parts: segments.slice(-2), url: trimmed };
  }

  if (host === 'dev.azure.com' || host === 'ssh.dev.azure.com' || host.endsWith('.visualstudio.com')) {
    // Azure spells one repository four ways. `_git` is the only stable landmark
    // in the HTTPS forms; the SSH form carries a `v3` version segment instead and
    // has none, which is why this reads positionally after dropping it.
    const gitAt = segments.indexOf('_git');
    const cleaned = segments[0] === 'v3' ? segments.slice(1) : segments;
    if (gitAt !== -1) {
      const before = segments.slice(0, gitAt);
      const repository = segments[gitAt + 1];
      if (repository === undefined) return null;
      // `dev.azure.com/org/project/_git/repo` gives both; the older
      // `org.visualstudio.com/project/_git/repo` puts the organization in the host.
      const organization = before[0] ?? host.split('.')[0]!;
      const project = before.length > 1 ? before[before.length - 1]! : repository;
      return { provider: 'azure', parts: [organization, project, repository], url: trimmed };
    }
    if (cleaned.length >= 3) return { provider: 'azure', parts: cleaned.slice(-3), url: trimmed };
    return null;
  }

  return null;
}

/** Split an SSH-or-HTTPS remote into its host and its path, or `{host: null}` for neither. */
function split(url: string): { host: string | null; path: string } {
  // `scp`-style, the shape an SSH clone leaves: `git@host:path`. Tried first
  // because it is not a URL and `new URL` accepts it as one, reading `git` as a
  // scheme and the whole rest as an opaque path.
  const scp = /^(?:([^@/]+)@)?([^/:]+):(.+)$/.exec(url);
  if (scp && !url.includes('://')) return { host: scp[2]!.toLowerCase(), path: scp[3]! };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'ssh:') {
      return { host: null, path: '' };
    }
    return { host: parsed.hostname.toLowerCase(), path: parsed.pathname };
  } catch {
    return { host: null, path: '' };
  }
}

/** The environment variable a provider's credential comes from. Never a config key. */
export function credentialVar(provider: string): string | null {
  if (provider === 'github') return 'GITHUB_TOKEN';
  if (provider === 'azure') return 'AZURE_DEVOPS_PAT';
  return null;
}
