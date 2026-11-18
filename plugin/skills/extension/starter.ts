// A LubbDubb extension: this project's own answers to the slots LubbDubb asks.
// List this file under "extensions" in lubbdubb.project.json, then restart LubbDubb.
// Delete any slot you do not fill. An unknown key or slot refuses boot.

interface SlotContext {
  /** The repository root LubbDubb works on. */
  repoRoot: string;
  /** Fires when the call times out or fails. Pass it to fetch() and child processes. */
  signal: AbortSignal;
}

const API = 'https://example.invalid';

export default {
  apiVersion: 1,
  name: 'my-project',
  slots: {
    // Provision (or find) the validation tenant for one environment, and name it.
    // Idempotent: `tenant` is the one already stamped, or null the first time — reuse it while it exists.
    async ensureTenant(
      input: { environment: string; tenant: string | null },
      { signal }: SlotContext,
    ): Promise<{ tenant: string }> {
      if (input.tenant !== null) {
        const existing = await fetch(`${API}/tenants/${encodeURIComponent(input.tenant)}`, { signal });
        if (existing.ok) return { tenant: input.tenant };
      }
      const created = await fetch(`${API}/environments/${encodeURIComponent(input.environment)}/tenants`, {
        method: 'POST',
        signal,
      });
      if (!created.ok) throw new Error(`the tenant API answered ${created.status}`);
      const { name } = (await created.json()) as { name: string };
      return { tenant: name };
    },

    // Optional, and destructive: wipe the tenant back to seed data. Answer nothing; throw to fail.
    async reseedTenant(input: { environment: string; tenant: string }, { signal }: SlotContext): Promise<void> {
      const response = await fetch(`${API}/tenants/${encodeURIComponent(input.tenant)}/reseed`, {
        method: 'POST',
        signal,
      });
      if (!response.ok) throw new Error(`the reseed answered ${response.status}`);
    },

    // Which commit an environment with "atExtension": true is running. Several services: one commit each.
    // Not knowing is a throw, never an empty list.
    async deployedCommits(input: { environment: string }, { signal }: SlotContext): Promise<{ commits: string[] }> {
      const response = await fetch(`${API}/environments/${encodeURIComponent(input.environment)}/version`, { signal });
      if (!response.ok) throw new Error(`the version API answered ${response.status}`);
      const { commit } = (await response.json()) as { commit: string };
      return { commits: [commit] };
    },

    // The error groups since `since`, for an environment with "errors": { "extension": true }. Return the
    // same report the errors command prints: a list of groups, or { groups, query?, queryLink? }.
    async appErrors(input: { environment: string; since: string }, { signal }: SlotContext): Promise<unknown> {
      const url = `${API}/environments/${encodeURIComponent(input.environment)}/errors?since=${input.since}`;
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`the errors API answered ${response.status}`);
      return (await response.json()) as unknown;
    },

    // Optional: more on one error group, for the triage agent. Answer { text }; throw to fail.
    async appErrorDetail(
      input: { environment: string; fingerprint: string; since: string },
      { signal }: SlotContext,
    ): Promise<{ text: string }> {
      const url = `${API}/errors/${encodeURIComponent(input.fingerprint)}?since=${input.since}`;
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`the errors API answered ${response.status}`);
      return { text: await response.text() };
    },

    // Run one watch query, for an environment with "watch": { "extension": true }. `query` is ready to run.
    // Answer rows, and put `checkId` in each row's "lubbdubbWatchId" (a kql query already projects it).
    async watchReading(
      input: {
        environment: string;
        source: string;
        language: 'kql' | 'sql' | 'promql' | 'other';
        checkId: string;
        query: string;
        kind: 'signal' | 'presence' | 'measure';
        since: string;
        until: string;
        commits: string[] | null;
      },
      { signal }: SlotContext,
    ): Promise<Record<string, string | number | boolean | null>[]> {
      const response = await fetch(`${API}/query`, { method: 'POST', body: JSON.stringify(input), signal });
      if (!response.ok) throw new Error(`the query API answered ${response.status}`);
      const rows = (await response.json()) as Record<string, string | number | boolean | null>[];
      return rows.map((row) => ({ ...row, lubbdubbWatchId: input.checkId }));
    },

    // The share of traffic (0 to 1) on a build carrying every one of `commits`, where "watch.exposure" is declared.
    async watchExposure(
      input: { environment: string; commits: string[] },
      { signal }: SlotContext,
    ): Promise<{ share: number }> {
      const url = `${API}/environments/${encodeURIComponent(input.environment)}/exposure`;
      const response = await fetch(url, { method: 'POST', body: JSON.stringify(input.commits), signal });
      if (!response.ok) throw new Error(`the exposure API answered ${response.status}`);
      const { share } = (await response.json()) as { share: number };
      return { share };
    },

    // Choose how thoroughly the fleet reviews a pull request. Answer one of `modes`, or skip where allowed.
    routeReview(input: {
      pr: { number: number; title: string; branch: string; base: string; author: string | null; body: string | null };
      modes: string[];
      allowSkip: boolean;
    }): { mode: string; reason: string } | { skip: true; reason: string } {
      const [thorough, light] = [input.modes[0], input.modes.at(-1)];
      if (input.allowSkip && /lockfile|bump/i.test(input.pr.title))
        return { skip: true, reason: 'no behaviour changes' };
      if (thorough === undefined || light === undefined) throw new Error('this project declares no review modes');
      if (/auth|migration/i.test(`${input.pr.title} ${input.pr.branch}`))
        return { mode: thorough, reason: 'touches auth or data' };
      return { mode: light, reason: 'an ordinary change' };
    },

    // Publish a recorded review where this team reads it. Answer the thread you posted into, or null.
    async publishReview(
      input: {
        pr: number;
        headSha: string | null;
        mode: string | null;
        verdict: 'clear' | 'findings';
        summary: string;
        findings: string[];
      },
      { signal }: SlotContext,
    ): Promise<{ thread: string | null }> {
      if (input.verdict === 'clear') return { thread: null };
      const response = await fetch(`${API}/pulls/${input.pr}/threads`, {
        method: 'POST',
        body: JSON.stringify({ summary: input.summary, findings: input.findings }),
        signal,
      });
      if (!response.ok) throw new Error(`the review API answered ${response.status}`);
      const { id } = (await response.json()) as { id: string };
      return { thread: id };
    },
  },
};
