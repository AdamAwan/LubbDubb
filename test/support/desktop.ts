import { orderedProfiles } from '../../src/agents/modelPolicy.js';
import type { DesktopToolDeps } from '../../src/mcp/desktopContext.js';
import type { System } from '../../src/system.js';

/**
 * The desktop channel's deps, taken off a built `System`.
 *
 * Here rather than written out at each `new McpDesktopServer(...)`, because the
 * channel now carries the fleet tools as well as the goal ones and a dep added to
 * it would otherwise be a dep every test had to learn about — which is the shape
 * of pressure that gets a new tool wired to a hand-rolled stub instead of to the
 * thing the harness actually runs.
 *
 * `socketPath` and `credentialPath` are deliberately **not** here: they are the
 * two that must be throwaway in a test, and a default would be a default onto the
 * operator's own home directory.
 */
export function desktopDeps(system: System): Omit<DesktopToolDeps, 'now'> {
  return {
    store: system.store,
    claimMinutes: 60,
    validationRoot: '/srv/validation',
    environments: [],
    localRun: () => system.localRun,
    localRunWatch: () => system.localRunWatch,
    proposals: () => system.proposals,
    runCycle: () => system.harness.runCycle('manual').then(() => undefined),
    runtimeControl: system.runtimeControl,
    harness: () => system.harness,
    escalations: () => system.escalations,
    permissions: () => system.permissions,
    recovery: () => system.recovery,
    agents: () => system.agents,
    filing: () => system.filing,
    briefConfig: () => system.config,
    // The real template, so a test exercising `job_create` files the body an
    // operator's deployment would actually get.
    renderTicketBody: (vars) => system.prompts.render('brief-ticket-body', vars),
    profileNames: () => orderedProfiles(system.config.agentModels).map((p) => p.name),
    agentModels: system.config.agentModels,
    connector: system.connector,
    errors: system.errors,
    labelPrefix: system.config.labelPrefix,
    issueContainerTypes: system.config.issueContainerTypes,
  };
}
