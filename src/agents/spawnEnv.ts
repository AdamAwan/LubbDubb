// → docs/spec/10-agent-runtimes.md#what-an-agent-does-not-inherit

/**
 * Harness credentials an agent must never inherit.
 *
 * An agent is launched with the harness's own environment, which is what lets it
 * reach `gh`, the provider and its own MCP socket. `LUBBDUBB_TOKEN` is a different
 * kind of thing: it is the **cockpit bearer**, and every operator-only route answers
 * to it. An agent that has it can `curl` the cockpit — which on a deployment with
 * the reveal gate on means reading the operator's prediction back verbatim, the one
 * thing the whole prediction record is built to prevent. That escape is over the
 * network rather than through an import, so neither the type system nor the
 * structural containment test can see it; this list is what closes it.
 *
 * The others are credentials of the same kind — the ingress secrets and the desktop
 * channel's credential — that no agent has any reason to hold.
 *
 * This strips them from what is *inherited*. Anything the harness deliberately hands
 * a session through its own spec still wins, because the spec is spread after.
 */
const HARNESS_ONLY_ENV = [
  'LUBBDUBB_TOKEN',
  'LUBBDUBB_INGRESS_SECRET',
  'LUBBDUBB_INGRESS_BASIC',
  'LUBBDUBB_DESKTOP_CREDENTIAL',
] as const;

/** `process.env` with the harness's own credentials taken out. */
export function inheritableEnv(from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...from };
  for (const key of HARNESS_ONLY_ENV) delete env[key];
  return env;
}
