// A LubbDubb extension: this project's own answers to the slots LubbDubb asks.
// List this file under "extensions" in lubbdubb.project.json, then restart LubbDubb.
// Delete any slot you do not fill. An unknown key or slot refuses boot.

interface SlotContext {
  /** The repository root LubbDubb works on. */
  repoRoot: string;
  /** Fires at the slot's timeout. Pass it to fetch() and child processes. */
  signal: AbortSignal;
}

export default {
  apiVersion: 1,
  name: 'my-project',
  slots: {
    // Provision (or find) the validation tenant for one environment, and name it.
    // Idempotent: `tenant` is the one already stamped, or null the first time.
    async ensureTenant(
      input: { environment: string; tenant: string | null },
      { signal }: SlotContext,
    ): Promise<{ tenant: string }> {
      const response = await fetch(`https://example.invalid/tenants/${input.environment}`, {
        method: 'PUT',
        signal,
      });
      if (!response.ok) throw new Error(`the tenant API answered ${response.status}`);
      const { name } = (await response.json()) as { name: string };
      return { tenant: name };
    },

    // Optional, and destructive: wipe the tenant back to seed data. Answer nothing; throw to fail.
    async reseedTenant(input: { environment: string; tenant: string }, { signal }: SlotContext): Promise<void> {
      const response = await fetch(`https://example.invalid/tenants/${input.tenant}/reseed`, {
        method: 'POST',
        signal,
      });
      if (!response.ok) throw new Error(`the reseed answered ${response.status}`);
    },
  },
};
