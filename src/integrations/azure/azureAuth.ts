import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// → docs/spec/15-integrations.md

const execFileAsync = promisify(execFile);

const AZURE_DEVOPS_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798';

export interface AzureAuth {
  header(): Promise<string>;
  forceRefresh?(): void;
}

class PatAuth implements AzureAuth {
  constructor(private readonly pat: string) {}
  async header(): Promise<string> {
    return `Basic ${Buffer.from(`:${this.pat}`).toString('base64')}`;
  }
}

class AzCliAuth implements AzureAuth {
  private cached: { token: string; fetchedAtMs: number } | null = null;
  private static readonly TTL_MS = 45 * 60 * 1000;

  constructor(private readonly fetchToken: () => Promise<string> = azCliAccessToken) {}

  async header(): Promise<string> {
    const now = Date.now();
    if (!this.cached || now - this.cached.fetchedAtMs >= AzCliAuth.TTL_MS) {
      this.cached = { token: await this.fetchToken(), fetchedAtMs: now };
    }
    return `Bearer ${this.cached.token}`;
  }

  forceRefresh(): void {
    this.cached = null;
  }
}

/**
 * Spawn the `az` CLI for an Azure DevOps access token. Throws a clear error if `az` isn't logged in.
 *
 * Exported so Setup's credential probe asks the *same* question the auth path asks
 * (`src/setup/probes.ts`) — a second spawn written to look equivalent drifts.
 * @public called by `RealSetupProbes.azSignedIn`.
 */
export async function azCliAccessToken(): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'az',
      ['account', 'get-access-token', '--resource', AZURE_DEVOPS_RESOURCE, '--query', 'accessToken', '--output', 'tsv'],
      // TECHDEBT: On Windows `az` is `az.cmd`; execFile won't resolve the extension without a
      // shell, so it ENOENTs. All args here are hardcoded constants — no injection risk.
      { shell: true },
    );
    const token = stdout.trim();
    if (!token) throw new Error('empty token');
    return token;
  } catch (err) {
    throw new Error(
      `Could not get an Azure DevOps token from the az CLI (${(err as Error).message}). ` +
        'Run `az login`, or set AZURE_DEVOPS_PAT to a Personal Access Token.',
    );
  }
}

export function resolveAzureAuth(): AzureAuth {
  const pat = process.env.AZURE_DEVOPS_PAT;
  return pat ? new PatAuth(pat) : new AzCliAuth();
}
