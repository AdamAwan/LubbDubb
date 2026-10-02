import type { Config } from '../config/config.js';
import type { PredictionStore } from '../store/predictions.js';
import type { PromptTemplates } from '../dispatcher/promptTemplates.js';
import type { LocalRunner } from '../localRun/runner.js';
import type { LocalRunWatch } from '../localRun/watch.js';
import { McpDesktopServer } from '../mcp/desktop.js';
import { orderedProfiles } from '../agents/modelPolicy.js';
import { prRefStyle } from '../pr/prRef.js';
import { planIsWithheld } from '../server/planReveal.js';
import { apiUrl } from '../server/apiUrl.js';
import type { Foundation, LateBinding } from './systemFoundation.js';

// → docs/spec/11-mcp-tools.md#the-desktop-channel

export function buildDesktop(
  config: Config,
  { store, connector, runtimeControl, errors }: Foundation,
  predictions: PredictionStore,
  prompts: PromptTemplates,
  late: LateBinding,
): McpDesktopServer {
  return new McpDesktopServer({
    store,
    // The desktop channel is the operator's own Claude Code, and it can read a plan
    // aloud. It is handed the *answer* to whether a plan is withheld, never the means
    // to ask — src/mcp/ must not be able to name the prediction store.
    planWithheld: (plan) => planIsWithheld({ config, predictions }, plan),
    argsRetentionDays: config.mcpArgsRetentionDays,
    claimMinutes: config.validation.desktopClaimMinutes,
    validationRoot: config.validationRoot,
    environments: config.environments,
    prRefStyle: prRefStyle(config.integrations.sourceControl),
    localRun: (): LocalRunner => late.get().localRun,
    localRunWatch: (): LocalRunWatch => late.get().localRunWatch,
    runtimeControl,
    harness: () => late.get().harness,
    escalations: () => late.get().escalations,
    permissions: () => late.get().permissions,
    recovery: () => late.get().recovery,
    ejections: () => late.get().ejections,
    agents: () => late.get().agents,
    filing: () => late.get().filing,
    briefConfig: () => config,
    renderTicketBody: (vars) => prompts.render('brief-ticket-body', vars),
    profileNames: () => orderedProfiles(config.agentModels).map((p) => p.name),
    connector,
    labelPrefix: config.labelPrefix,
    issueContainerTypes: config.issueContainerTypes,
    agentModels: config.agentModels,
    askQueue: () => late.get().askQueue(),
    cockpitUrl: apiUrl(config),
    proposals: () => late.get().proposals,
    prAssign: () => late.get().prAssign,
    runCycle: () =>
      late
        .get()
        .harness.runCycle('manual')
        .then(() => undefined),
    now: () => new Date().toISOString(),
    socketPath: config.validation.desktopSocketPath,
    credentialPath: config.validation.desktopCredentialPath,
    errors,
  });
}
