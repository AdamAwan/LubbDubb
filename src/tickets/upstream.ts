import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Config } from '../config.js';
import type { FilingTarget } from '../sink/actionSink.js';

const execFileAsync = promisify(execFile);

/**
 * Where a fault in LubbDubb goes — fixed, and deliberately not
 * `github.owner`/`github.repo` (issue #449).
 *
 * Those name the repo the fleet *works on*, which is LubbDubb's own only while it
 * is dogfooding itself. The cockpit's "Raise an issue" control is the one thing on
 * that bar about the tool rather than about the work, so a deployment driving a
 * customer's repo — or an Azure DevOps project — files here too. Filing a cockpit
 * bug into the customer's tracker is what #449 reported, and it is the failure this
 * constant exists to make unreachable.
 */
export const UPSTREAM_REPO = 'AdamAwan/LubbDubb';

/**
 * Filing into LubbDubb's own tracker, past the connector.
 *
 * A seam of its own rather than a fifth arm of `ActionSink`, because it is not the
 * same act: every other filing goes to the tracker *the fleet is pointed at*,
 * through the provider chosen in config and the credential that provider holds.
 * This one always goes to one repository, whatever that config says — so routing it
 * through the composite would mean an Azure deployment filing a GitHub issue
 * through an Azure work-item API, which nothing can do.
 *
 * **The `gh` CLI is the transport, and it is a choice rather than an omission.**
 * The harness's own `GITHUB_TOKEN` is scoped to the repo the fleet works on and may
 * not reach this one at all; `gh` is already on the machine (the agents use it), is
 * authenticated as the operator, and files as *them* — which is the right byline
 * for a bug report about the tool. It also means an Azure-only deployment, which
 * has no GitHub credential anywhere in its config, can still report a cockpit
 * fault.
 */
export interface UpstreamIssues {
  /**
   * Where a report would land and as whom, from a live call — the same question
   * the compose modal holds its fields disabled for.
   *
   * **Throws** rather than reporting a failure: `gh` missing, or logged out, is
   * exactly what this exists to catch, and the one caller (the probe route) is the
   * right place to decide what to show for it.
   */
  describeTarget(): Promise<FilingTarget>;
  /** File it. Throws with the CLI's own words, which are the half that says what to do. */
  create(input: { title: string; body: string; labels: string[] }): Promise<{ number: number; url: string }>;
}

/**
 * Whether the fleet this harness runs is pointed at {@link UPSTREAM_REPO} itself —
 * the dogfooding deployment, and the only one where watching a report raised here
 * means anything.
 *
 * The watch label is what makes the fleet pick an issue up, and the fleet only
 * sweeps its own configured tracker. Offered anywhere else it would be a checkbox
 * that silently does nothing, so the probe carries this and the modal draws the box
 * only when it is true.
 */
export function fleetWorksUpstream(config: Config): boolean {
  const gh = config.github;
  if (config.integrations.issues !== 'github' || !gh) return false;
  return `${gh.owner}/${gh.repo}`.toLowerCase() === UPSTREAM_REPO.toLowerCase();
}

/**
 * What to tell an operator when `gh` will not answer. The CLI's own stderr is the
 * useful half — "gh auth login" is printed by the thing that knows — so it is
 * quoted rather than replaced, and only the way back is added.
 */
function ghFailure(err: unknown): Error {
  const e = err as { stderr?: string; message?: string; code?: string };
  const detail = (e.stderr ?? '').trim() || e.message || String(err);
  if (e.code === 'ENOENT')
    return new Error(
      `the GitHub CLI (gh) is not installed on this machine, so nothing here can file into ${UPSTREAM_REPO}`,
    );
  return new Error(detail);
}

/**
 * The real one: `gh`, spawned without a shell.
 *
 * **No `shell: true`, unlike the `az` token call in `restAzureDevOpsApi`.** The
 * arguments here carry a title and a body the operator typed, and a shell between
 * this and the CLI would make that text executable. `gh` ships as `gh.exe` on
 * Windows, so `execFile` resolves it without one anyway — the trade the `az` call
 * has to make (`az.cmd`) does not arise.
 */
export function ghCliUpstreamIssues(): UpstreamIssues {
  return {
    async describeTarget(): Promise<FilingTarget> {
      try {
        // One authenticated round trip. `gh auth status` would prove the login and
        // not the name, and the name is what the modal shows before a word is typed.
        const { stdout } = await execFileAsync('gh', ['api', 'user', '--jq', '.login']);
        const login = stdout.trim();
        return { target: UPSTREAM_REPO, identity: login === '' ? null : login };
      } catch (err) {
        throw ghFailure(err);
      }
    },
    async create(input): Promise<{ number: number; url: string }> {
      const args = ['issue', 'create', '--repo', UPSTREAM_REPO, '--title', input.title, '--body', input.body];
      for (const label of input.labels) args.push('--label', label);
      let url: string;
      try {
        // `gh issue create` prints the new issue's URL and nothing else.
        const { stdout } = await execFileAsync('gh', args);
        url = stdout.trim().split(/\s+/).at(-1) ?? '';
      } catch (err) {
        throw ghFailure(err);
      }
      const number = Number(url.split('/').at(-1));
      if (!Number.isInteger(number)) throw new Error(`the GitHub CLI created something but did not say what: "${url}"`);
      return { number, url };
    },
  };
}
