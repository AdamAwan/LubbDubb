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
  },
};
