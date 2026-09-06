import { orderedProfiles } from '../../src/agents/modelPolicy.js';
import type { DesktopToolDeps } from '../../src/mcp/desktopContext.js';
import type { System } from '../../src/system.js';

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
    renderTicketBody: (vars) => system.prompts.render('brief-ticket-body', vars),
    profileNames: () => orderedProfiles(system.config.agentModels).map((p) => p.name),
    agentModels: system.config.agentModels,
    connector: system.connector,
    errors: system.errors,
    labelPrefix: system.config.labelPrefix,
    issueContainerTypes: system.config.issueContainerTypes,
  };
}
