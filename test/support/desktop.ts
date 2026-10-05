import { orderedProfiles } from '../../src/agents/modelPolicy.js';
import type { DesktopToolDeps } from '../../src/mcp/desktopContext.js';
import { planIsWithheld } from '../../src/server/planReveal.js';
import type { System } from '../../src/system/system.js';
import { askSnapshot } from '../../src/server/stateSnapshot.js';
import { desktopRemoteValidation } from '../../src/system/systemDesktop.js';

export function desktopDeps(system: System): Omit<DesktopToolDeps, 'now'> {
  return {
    store: system.store,
    planWithheld: (plan) => planIsWithheld(system, plan),
    claimMinutes: 60,
    validationRoot: '/srv/validation',
    environments: system.config.environments,
    localRun: () => system.localRun,
    localRunWatch: () => system.localRunWatch,
    proposals: () => system.proposals,
    prAssign: () => system.prAssign,
    runCycle: () => system.harness.runCycle('manual').then(() => undefined),
    remoteValidation: () => desktopRemoteValidation(system.config, system.store, system),
    runtimeControl: system.runtimeControl,
    harness: () => system.harness,
    escalations: () => system.escalations,
    permissions: () => system.permissions,
    recovery: () => system.recovery,
    ejections: () => system.ejections,
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
    asks: () => askSnapshot(system),
    cockpitUrl: 'http://127.0.0.1:4300',
    changed: () => {},
  };
}
